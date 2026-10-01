import { test } from "node:test";
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
