import type { PluginHookAgent, PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import { lastAssistantText, permissionBody, systemMessage, turnBody, wantsNotification } from "./server/lib.ts";

type Paseo = PluginHookContext["paseo"];

export default function contribute(server: PluginServerContext) {
  const notifiedRequests = new Set<string>();
  // Messages held while the parent has its own permission pending: sending would clear it.
  const held = new Map<string, string[]>();

  async function deliver(paseo: Paseo, parentId: string, body: string) {
    const parent = paseo.agents.ref(parentId);
    // The daemon accepts activeTurnBehavior even though PaseoAgentSendOptions omits it; default would interrupt.
    // messageId must be "" and not absent: the client mints `options?.messageId ?? crypto.randomUUID()`,
    // so omitting it buys a real id, while "" survives ?? and is then dropped as falsy from the request.
    // Without an id the daemon writes no user_message row, which is what keeps a wake out of the jump list.
    // Rewriting that ?? as || would silently undo this fix, and nothing here would fail.
    const options = { activeTurnBehavior: "steer", messageId: "" } as Parameters<typeof parent.send>[1];
    await parent.send(systemMessage(body), options);
    console.log(`[subagent-notifications] → ${parentId}: ${body.split("\n")[0]}`);
  }

  async function wake(paseo: Paseo, child: PluginHookAgent, makeBody: (title: string) => string) {
    const parentId = child.parentAgentId;
    if (!parentId) return;
    const parent = paseo.agents.ref(parentId);
    const snapshot = (await parent.refresh())?.agent ?? parent.current();
    if (!snapshot || snapshot.archivedAt) return;
    const childSnapshot = (await paseo.agents.ref(child.id).refresh())?.agent;
    if (!wantsNotification(snapshot.labels, childSnapshot?.labels)) return;
    const body = makeBody(childSnapshot?.title ?? child.title ?? child.id);
    if (snapshot.pendingPermissions.length > 0) {
      held.set(parentId, [...(held.get(parentId) ?? []), body]);
      console.log(`[subagent-notifications] held for ${parentId} (parent has a pending permission): ${body.split("\n")[0]}`);
      return;
    }
    await deliver(paseo, parentId, body);
  }

  async function flush(paseo: Paseo, parentId: string) {
    const bodies = held.get(parentId);
    if (!bodies?.length) return;
    held.delete(parentId);
    for (const body of bodies) await deliver(paseo, parentId, body);
  }

  const off = [
    server.on("agent.permission_requested", async ({ agent, request }, { paseo }) => {
      if (notifiedRequests.has(request.id)) return;
      notifiedRequests.add(request.id);
      await wake(paseo, agent, (title) => permissionBody(agent.id, title, request));
    }),
    server.on("agent.permission_resolved", async ({ agent, requestId }, { paseo }) => {
      notifiedRequests.delete(requestId);
      await flush(paseo, agent.id);
    }),
    server.on("agent.turn_ended", async ({ agent, outcome, timeline }, { paseo }) => {
      await flush(paseo, agent.id);
      if (outcome.kind === "canceled") return;
      const error = outcome.kind === "failed" ? outcome.error.message : null;
      await wake(paseo, agent, (title) => turnBody(agent.id, title, error, lastAssistantText(timeline)));
    }),
  ];

  return () => {
    for (const remove of off) remove();
  };
}
