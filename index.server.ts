import type { PluginHookAgent, PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import { lastAssistantText, permissionBody, systemMessage, turnBody, wantsNotification } from "./server/lib.ts";

type Paseo = PluginHookContext["paseo"];

// Longest a finished-turn wake is held for a "running" parent. `running` also covers a Claude Code
// parent that has replied and is only waiting on its own background tasks; the daemon emits no
// turn_ended for it until they finish (one wake sat 45 minutes), and the status cannot tell that
// apart from a tool in flight. The hold protects a tool mid-call from being aborted by a steer, so
// it still covers every normal tool; past this bound, delivering beats waiting indefinitely.
export const MAX_HOLD_MS = 120_000;

export default function contribute(server: PluginServerContext) {
  const notifiedRequests = new Set<string>();
  // Messages held while the parent has its own permission pending (sending would clear it) or,
  // for finished turns, while the parent's own turn runs: on Claude a steer lands as a queued
  // user message that aborts the tool in flight, which Claude Code reports to the parent as
  // "The user doesn't want to proceed … STOP and wait for the user".
  const held = new Map<string, string[]>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  async function deliver(paseo: Paseo, parentId: string, body: string, wrap = true) {
    const parent = paseo.agents.ref(parentId);
    // The daemon accepts activeTurnBehavior even though PaseoAgentSendOptions omits it; default would interrupt.
    // messageId must be "" and not absent: the client mints `options?.messageId ?? crypto.randomUUID()`,
    // so omitting it buys a real id, while "" survives ?? and is then dropped as falsy from the request.
    // Without an id the daemon writes no user_message row, which is what keeps a wake out of the jump list.
    // Rewriting that ?? as || would silently undo this fix, and nothing here would fail.
    const options = { activeTurnBehavior: "steer", messageId: "" } as Parameters<typeof parent.send>[1];
    await parent.send(wrap ? systemMessage(body) : body, options);
    console.log(`[subagent-notifications] → ${parentId}: ${body.split("\n")[0]}`);
  }

  function hold(paseo: Paseo, parentId: string, body: string, reason: string) {
    held.set(parentId, [...(held.get(parentId) ?? []), body]);
    if (reason === "parent turn is running" && !timers.has(parentId)) arm(paseo, parentId);
    console.log(`[subagent-notifications] held for ${parentId} (${reason}): ${body.split("\n")[0]}`);
  }

  // Safety net for a parent whose turn never ends while it waits on background work.
  function arm(paseo: Paseo, parentId: string) {
    timers.set(
      parentId,
      setTimeout(async () => {
        timers.delete(parentId);
        try {
          const snapshot = (await paseo.agents.ref(parentId).refresh())?.agent;
          if (snapshot?.pendingPermissions.length) return arm(paseo, parentId); // sending would clear it
          await flush(paseo, parentId);
        } catch (error) {
          console.log(`[subagent-notifications] timed flush failed for ${parentId}: ${error}`);
        }
      }, MAX_HOLD_MS),
    );
  }

  async function wake(
    paseo: Paseo,
    child: PluginHookAgent,
    makeBody: (title: string) => string,
    kind: "permission" | "turn",
  ) {
    const parentId = child.parentAgentId;
    if (!parentId) return;
    const parent = paseo.agents.ref(parentId);
    const snapshot = (await parent.refresh())?.agent ?? parent.current();
    if (!snapshot || snapshot.archivedAt) return;
    const childSnapshot = (await paseo.agents.ref(child.id).refresh())?.agent;
    if (!wantsNotification(snapshot.labels, childSnapshot?.labels)) return;
    const body = makeBody(childSnapshot?.title ?? child.title ?? child.id);
    if (snapshot.pendingPermissions.length > 0) return hold(paseo, parentId, body, "parent has a pending permission");
    // A child's question still steers a running parent: the parent may be blocked waiting on that
    // very child, and holding the question until its turn ends would deadlock both.
    if (kind === "turn" && snapshot.status === "running") {
      hold(paseo, parentId, body, "parent turn is running");
      // The parent's turn may have ended between the refresh above and the hold: flush ourselves.
      if ((await parent.refresh())?.agent?.status !== "running") await flush(paseo, parentId);
      return;
    }
    await deliver(paseo, parentId, body);
  }

  // One message, not one per body: the first delivery starts a turn and the rest would steer it.
  async function flush(paseo: Paseo, parentId: string) {
    const bodies = held.get(parentId);
    if (!bodies?.length) return;
    held.delete(parentId);
    clearTimeout(timers.get(parentId));
    timers.delete(parentId);
    await deliver(paseo, parentId, bodies.map((body) => systemMessage(body)).join("\n\n"), false);
  }

  const off = [
    server.on("agent.permission_requested", async ({ agent, request }, { paseo }) => {
      if (notifiedRequests.has(request.id)) return;
      notifiedRequests.add(request.id);
      await wake(paseo, agent, (title) => permissionBody(agent.id, title, request), "permission");
    }),
    server.on("agent.permission_resolved", async ({ agent, requestId }, { paseo }) => {
      notifiedRequests.delete(requestId);
      // Resolving a permission resumes the agent's turn; held turn results wait for its end.
      const snapshot = (await paseo.agents.ref(agent.id).refresh())?.agent;
      if (snapshot?.status !== "running") await flush(paseo, agent.id);
    }),
    server.on("agent.turn_ended", async ({ agent, outcome, timeline }, { paseo }) => {
      await flush(paseo, agent.id);
      if (outcome.kind === "canceled") return;
      const error = outcome.kind === "failed" ? outcome.error.message : null;
      await wake(paseo, agent, (title) => turnBody(agent.id, title, error, lastAssistantText(timeline)), "turn");
    }),
  ];

  return () => {
    for (const remove of off) remove();
    for (const timer of timers.values()) clearTimeout(timer);
  };
}
