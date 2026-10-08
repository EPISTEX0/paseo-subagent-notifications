import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { lastAssistantText, permissionBody, responseBlock, turnBody, wantsNotification } from "./lib.ts";

test("wantsNotification: on by default, an off value on parent or child opts out", () => {
  assert.equal(wantsNotification(undefined, undefined), true);
  assert.equal(wantsNotification({}, {}), true);
  assert.equal(wantsNotification({ "subagent-notifications": "on" }, undefined), true);
  assert.equal(wantsNotification({ "subagent-notifications": "off" }, undefined), false);
  assert.equal(wantsNotification(undefined, { "subagent-notifications": "0" }), false);
  assert.equal(wantsNotification({ "subagent-notifications": "on" }, { "subagent-notifications": "false" }), false);
});

test("lastAssistantText joins streamed chunks after the last non-assistant item", () => {
  const timeline = [
    { type: "assistant_message", text: "old" },
    { type: "tool_call" },
    { type: "assistant_message", text: "p" },
    { type: "assistant_message", text: "ong" },
  ];
  assert.equal(lastAssistantText(timeline), "pong");
  assert.equal(lastAssistantText([{ type: "tool_call" }]), "");
});

test("responseBlock truncates long text", () => {
  assert.equal(responseBlock(""), "");
  assert.match(responseBlock("x".repeat(4500)), /\[truncated 500 chars;/);
});

test("bodies lead with the agent name and carry the ids", () => {
  const p = permissionBody("a1", "Child · x", { id: "r1", title: "ping?", description: "yes / no" });
  assert.match(p, /^Child · x asks: "ping\?" — yes \/ no\n/);
  assert.match(p, /agentId: a1 · requestId: r1/);
  assert.match(p, /"requestId": "r1"/);
  assert.match(permissionBody("a1", "Child · x", { id: "r2", name: "Bash" }), /needs permission \(Bash\)/);
  assert.equal(turnBody("a1", "Child · x", null, "done"), "Child · x finished. · agentId: a1\n\n<agent-response>\ndone\n</agent-response>");
  assert.match(turnBody("a1", "Child · x", "boom", ""), /^Child · x errored: boom · agentId: a1$/);
});

// Guards the one line the jump-list fix lives on. This pins the shape of the call only: the
// daemon's reaction to it is not reachable from here, and is measured instead (see README).
test('a wake is sent with messageId "" so it takes no jump list slot', async () => {
  const { default: contribute } = await import("../index.server.ts");

  const sent: Array<{ text: string; options: { messageId?: string; activeTurnBehavior?: string } }> = [];
  const parentRef = {
    refresh: async () => ({ agent: { labels: {}, pendingPermissions: [], archivedAt: null } }),
    current: () => null,
    send: async (text: string, options: { messageId?: string; activeTurnBehavior?: string }) => {
      sent.push({ text, options });
    },
  };
  const childRef = { refresh: async () => ({ agent: { labels: {}, title: "Child · x" } }) };
  const paseo = { agents: { ref: (id: string) => (id === "parent-1" ? parentRef : childRef) } };

  const handlers = new Map<string, (event: unknown, context: unknown) => Promise<void>>();
  const server = {
    on: (name: string, handler: (event: unknown, context: unknown) => Promise<void>) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
  };

  const stop = contribute(server as never);
  await handlers.get("agent.turn_ended")!(
    { agent: { id: "child-1", parentAgentId: "parent-1", title: "Child · x" }, outcome: { kind: "completed" }, timeline: [] },
    { paseo },
  );
  stop();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].options.messageId, "");
  assert.equal(sent[0].options.activeTurnBehavior, "steer");
  assert.match(sent[0].text, /^<paseo-system>\n/);
});

// A finished-turn wake must not steer a running parent: on Claude that aborts the tool in flight
// and is reported to the parent as a user rejection. It is held and sent when the parent's turn ends.
test("a finished turn is held while the parent runs and sent when its turn ends", async () => {
  const { default: contribute } = await import("../index.server.ts");

  let status = "running";
  const sent: string[] = [];
  const parentRef = {
    refresh: async () => ({ agent: { labels: {}, pendingPermissions: [], archivedAt: null, status } }),
    current: () => null,
    send: async (text: string) => {
      sent.push(text);
    },
  };
  const childRef = { refresh: async () => ({ agent: { labels: {}, title: "Child · x", status: "idle" } }) };
  const paseo = { agents: { ref: (id: string) => (id === "parent-1" ? parentRef : childRef) } };
  const handlers = new Map<string, (event: unknown, context: unknown) => Promise<void>>();
  const server = {
    on: (name: string, handler: (event: unknown, context: unknown) => Promise<void>) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
  };
  const stop = contribute(server as never);
  const childEnded = (id: string) =>
    handlers.get("agent.turn_ended")!(
      { agent: { id, parentAgentId: "parent-1", title: id }, outcome: { kind: "completed" }, timeline: [] },
      { paseo },
    );

  await childEnded("child-1");
  await childEnded("child-2");
  assert.equal(sent.length, 0);

  await handlers.get("agent.permission_requested")!(
    { agent: { id: "child-3", parentAgentId: "parent-1", title: "c3" }, request: { id: "r1", name: "Bash" } },
    { paseo },
  );
  assert.equal(sent.length, 1, "a child's question still reaches a running parent");

  status = "idle";
  await handlers.get("agent.turn_ended")!(
    { agent: { id: "parent-1", parentAgentId: null, title: "p" }, outcome: { kind: "completed" }, timeline: [] },
    { paseo },
  );
  stop();

  assert.equal(sent.length, 2, "both held results arrive in one message");
  assert.match(sent[1], /child-1/);
  assert.match(sent[1], /child-2/);
});

// A Claude Code parent that replied and waits on background tasks stays `running` with no
// turn_ended; the held wake must still arrive after MAX_HOLD_MS.
test("a held finished turn is delivered after MAX_HOLD_MS even if the parent never goes idle", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { default: contribute, MAX_HOLD_MS } = await import("../index.server.ts");
  const sent: string[] = [];
  const parentRef = {
    refresh: async () => ({ agent: { labels: {}, pendingPermissions: [], archivedAt: null, status: "running" } }),
    current: () => null,
    send: async (text: string) => {
      sent.push(text);
    },
  };
  const childRef = { refresh: async () => ({ agent: { labels: {}, title: "Child", status: "idle" } }) };
  const paseo = { agents: { ref: (id: string) => (id === "parent-1" ? parentRef : childRef) } };
  let ended: (event: unknown, context: unknown) => Promise<void> = async () => {};
  const stop = contribute({
    on: (name: string, handler: typeof ended) => {
      if (name === "agent.turn_ended") ended = handler;
      return () => {};
    },
  } as never);
  await ended(
    { agent: { id: "child-1", parentAgentId: "parent-1", title: "c" }, outcome: { kind: "completed" }, timeline: [] },
    { paseo },
  );
  assert.equal(sent.length, 0);
  t.mock.timers.tick(MAX_HOLD_MS - 1);
  assert.equal(sent.length, 0);
  t.mock.timers.tick(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /child-1/);
  stop();
});

async function rig(t: TestContext) {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { default: contribute, MAX_HOLD_MS } = await import("../index.server.ts");
  const parent = { status: "running", pending: 0, archived: null as string | null, throws: false, missing: false };
  const sent: string[] = [];
  const parentRef = {
    refresh: async () => {
      if (parent.throws) throw new Error("gone");
      if (parent.missing) return null;
      return { agent: { labels: {}, pendingPermissions: Array(parent.pending).fill({}), archivedAt: parent.archived, status: parent.status } };
    },
    current: () => null,
    send: async (text: string) => void sent.push(text),
  };
  const childRef = { refresh: async () => ({ agent: { labels: {}, title: "Child", status: "idle" } }) };
  const paseo = { agents: { ref: (id: string) => (id === "parent-1" ? parentRef : childRef) } };
  const handlers = new Map<string, (event: unknown, context: unknown) => Promise<void>>();
  const stop = contribute({
    on: (name: string, handler: (event: unknown, context: unknown) => Promise<void>) => (handlers.set(name, handler), () => {}),
  } as never);
  const ctx = { paseo };
  const child = (id: string) => ({ id, parentAgentId: "parent-1", title: id });
  return {
    parent, sent, stop, MAX_HOLD_MS,
    childEnded: (id: string) => handlers.get("agent.turn_ended")!({ agent: child(id), outcome: { kind: "completed" }, timeline: [] }, ctx),
    childAsks: (id: string) => handlers.get("agent.permission_requested")!({ agent: child(id), request: { id: `r-${id}`, name: "Bash" } }, ctx),
    parentResolved: () => handlers.get("agent.permission_resolved")!({ agent: { id: "parent-1" }, requestId: "p" }, ctx),
    tick: async (ms: number) => { t.mock.timers.tick(ms); await new Promise((r) => setImmediate(r)); },
  };
}

test("after the parent's permission is resolved, a held child question is sent even though the parent runs", async (t) => {
  const r = await rig(t);
  r.parent.pending = 1;
  await r.childEnded("child-1");
  await r.childAsks("child-2");
  assert.equal(r.sent.length, 0);
  r.parent.pending = 0; // approved: the parent resumes as running
  await r.parentResolved();
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0], /child-2/);
  assert.doesNotMatch(r.sent[0], /child-1/, "the finished turn still waits for turn end or timer");
  await r.tick(r.MAX_HOLD_MS);
  assert.equal(r.sent.length, 2);
  assert.match(r.sent[1], /child-1/);
  r.stop();
});

test("a hold made for a pending permission is bounded by the timer once the permission is gone", async (t) => {
  const r = await rig(t);
  r.parent.pending = 1;
  await r.childEnded("child-1");
  await r.tick(r.MAX_HOLD_MS * 3);
  assert.equal(r.sent.length, 0, "still pending: keep holding");
  r.parent.pending = 0;
  await r.tick(r.MAX_HOLD_MS);
  assert.equal(r.sent.length, 1);
  r.stop();
});

test("an archived or missing parent is never sent a held wake", async (t) => {
  const a = await rig(t);
  await a.childEnded("child-1");
  a.parent.archived = "2026-10-08";
  await a.tick(a.MAX_HOLD_MS);
  assert.equal(a.sent.length, 0);
  a.parent.archived = null;
  await a.tick(a.MAX_HOLD_MS * 2);
  assert.equal(a.sent.length, 0, "dropped, not kept");
  a.stop();
  const b = await rig(t);
  await b.childEnded("child-1");
  b.parent.missing = true;
  await b.tick(b.MAX_HOLD_MS);
  b.parent.missing = false;
  await b.tick(b.MAX_HOLD_MS * 2);
  assert.equal(b.sent.length, 0);
  b.stop();
});

test("cleanup sends held wakes instead of losing them, and arms no timer afterwards", async (t) => {
  const r = await rig(t);
  await r.childEnded("child-1");
  r.stop();
  await r.tick(0);
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0], /child-1/);
});

test("a transient refresh error keeps the held wake and the timer retries it once", async (t) => {
  const r = await rig(t);
  await r.childEnded("child-1");
  r.parent.throws = true;
  await r.tick(r.MAX_HOLD_MS);
  assert.equal(r.sent.length, 0);
  r.parent.throws = false;
  await r.tick(r.MAX_HOLD_MS);
  assert.equal(r.sent.length, 1);
  await r.tick(r.MAX_HOLD_MS * 3);
  assert.equal(r.sent.length, 1, "delivered once");
  r.stop();
});
