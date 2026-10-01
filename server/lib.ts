/** Pure helpers, kept free of the Paseo SDK so they can run under `node --test`. */

export const LABEL = "subagent-notifications";
export const RESPONSE_LIMIT = 4000;

type Labels = Readonly<Record<string, string>> | undefined;
type TimelineItem = { type: string; text?: string };

/** On by default: the label set to off/false/0 (or empty) on the parent or the child opts out. */
export function wantsNotification(parentLabels: Labels, childLabels: Labels): boolean {
  const off = (value: string | undefined) =>
    value !== undefined && ["", "off", "false", "0"].includes(value.trim().toLowerCase());
  return !off(parentLabels?.[LABEL]) && !off(childLabels?.[LABEL]);
}

/** Claude streams one assistant_message item per chunk: join the last contiguous run. */
export function lastAssistantText(timeline: readonly TimelineItem[]): string {
  const chunks: string[] = [];
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (item.type === "assistant_message") chunks.unshift(item.text ?? "");
    else if (chunks.length) break;
  }
  return chunks.join("").trim();
}

export function responseBlock(text: string): string {
  if (!text) return "";
  const body =
    text.length > RESPONSE_LIMIT
      ? `${text.slice(0, RESPONSE_LIMIT)}\n[truncated ${text.length - RESPONSE_LIMIT} chars; use get_agent_activity for the full message]`
      : text;
  return `\n\n<agent-response>\n${body}\n</agent-response>`;
}

type Request = { id: string; title?: string | null; description?: string | null; name?: string };

/** Human-readable first line, then the ids and the exact request the parent needs to answer. */
export function permissionBody(agentId: string, title: string, request: Request): string {
  const question = request.title ? `asks: "${request.title}"` : `needs permission (${request.name ?? "tool"})`;
  const options = request.description ? ` — ${request.description}` : "";
  return [
    `${title} ${question}${options}`,
    `Answer with \`respond_to_permission\` · agentId: ${agentId} · requestId: ${request.id}`,
    `<permission-request>\n${JSON.stringify({ agentId, requestId: request.id, request }, null, 2)}\n</permission-request>`,
  ].join("\n\n");
}

export function turnBody(agentId: string, title: string, error: string | null, lastText: string): string {
  const head = error ? `${title} errored: ${error}` : `${title} finished.`;
  return `${head} · agentId: ${agentId}${responseBlock(lastText)}`;
}

export function systemMessage(body: string): string {
  return `<paseo-system>\n${body}\n</paseo-system>`;
}
