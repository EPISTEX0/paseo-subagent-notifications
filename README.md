# subagent-notifications

Wakes an orchestrating parent agent in [Paseo](https://paseo.sh) on **every** question and **every** finished turn of its child agents, not only the first one.

## Why

When an agent spawns another with `create_agent` or `send_agent_prompt`, Paseo's `notifyOnFinish` subscribes the parent once per prompt: the parent hears about the child's permission requests only until the child's first finished (or errored) turn, then the subscription ends. A child that ends a turn early (for example, after delegating to its own subagent) and later asks a question wakes nobody. The parent only finds out when someone else prompts it and it happens to call `list_pending_permissions`.

This plugin listens to the daemon's lifecycle hooks and keeps waking the parent for as long as the child carries the `paseo.parent-agent-id` label and the parent is not archived.

## Install

```bash
paseo plugin add EPISTEX0/paseo-subagent-notifications
```

Plugins must be enabled on the daemon (**Settings → Plugins → Enable plugins**). Requires Paseo 0.8 or later. Server-only: no UI, no network, no filesystem access.

From a local checkout:

```bash
git clone https://github.com/EPISTEX0/paseo-subagent-notifications
cd paseo-subagent-notifications && npm install && npm run typecheck && npm test
paseo plugin install "$PWD"
```

## Setup

None. Once installed, every parent is woken for every child that carries `paseo.parent-agent-id`.

To opt out, set the label `subagent-notifications` to `off`, `false` or `0` on either side:

- **On the parent**, to silence every child it spawns:
  `update_agent(agentId: <own id>, labels: {"subagent-notifications": "off"})`. An agent's own id is in `PASEO_AGENT_ID`.
- **On a child**, at spawn time:
  `create_agent(..., labels: {"subagent-notifications": "off"})`.

Pass `notifyOnFinish: false` on `create_agent` and `send_agent_prompt` once the plugin is active, otherwise the first notification arrives twice (once from Paseo, once from the plugin). Opted-out parents keep Paseo's built-in behavior unchanged.

## How it works

- Hooks `agent.permission_requested` and `agent.turn_ended` (`completed` and `failed`; `canceled` is skipped).
- Sends the parent a `<paseo-system>` message shaped like Paseo's own notification, with a readable first line:

  ```
  <paseo-system>
  Child · my-project asks: "ping?" — yes / no

  Answer with `respond_to_permission` · agentId: <id> · requestId: <id>

  <permission-request>
  { ...the request exactly as Paseo reported it... }
  </permission-request>
  </paseo-system>
  ```

  Finished turns read `<title> finished. · agentId: <id>` followed by `<agent-response>` with the last assistant message (capped at 4000 characters); failed turns read `errored: <message>`. Delivered with `activeTurnBehavior: "steer"` so a running parent is not interrupted.
- Sent with `messageId: ""`, which keeps the wake out of the parent's message jump list — the strip of ticks down the left margin of the chat, where each tick jumps back to one earlier message. Measured, see [Measuring a change](#measuring-a-change). The chain, reading Paseo 0.8.0:
  - `@getpaseo/client` builds the request with `options?.messageId ?? crypto.randomUUID()` and then drops the key when it is falsy. Omitting `messageId` therefore buys a generated id; `""` passes through `??` untouched and is dropped, so the request carries no id at all.
  - Without an id the daemon sets no `clientMessageId` (`agent-prompt.js`), and the two call sites that would write a `user_message` timeline row for a submitted prompt are both gated on it (`agent-manager.js`).
  - The jump list is built from exactly those rows: the daemon's prompt index keeps `row.item.type === "user_message"` (`timeline-prompt-index.js`) and the web UI maps the resulting `prompts` array into the ticks (`useChatOutline`).

  A wake still reaches the parent's context, still steers its running turn, and still appears in the provider transcript. It just takes no slot in the jump list. Paseo's own `<paseo-system>` notifications end up equally invisible, but by a different route — the daemon filters that envelope off the provider echo path, which is not the mechanism used here.
- If the parent itself has a permission pending (for example its own `AskUserQuestion`), the message is held and delivered when that permission is resolved or the parent's turn ends. Sending immediately would clear the parent's pending question.
- Each permission request id is delivered once.

## Measuring a change

`npm test` reaches the pure helpers and the shape of the call this plugin makes. It cannot reach
the daemon, so anything about what the daemon *does* with that call has to be measured against a
running one. This is the procedure that produced the numbers below.

### Loading a test build

`paseo plugin install <dir>` refuses an id that is already configured:

```
Plugin ID "subagent-notifications" is already configured; choose another ID with --id
```

`paseo plugin update` is not the way round it either. `sources.json` records a `remote` and a
`commit` pointing at GitHub, so `update` pulls `main` from GitHub over the checkout and destroys
any unpushed commit sitting in it.

What works is to copy the runtime files straight into `checkoutRoot` and reload:

```bash
CHECKOUT=$(node -e 'const fs=require("fs"),os=require("os");console.log(JSON.parse(fs.readFileSync(os.homedir()+"/.paseo/plugins/sources.json","utf8"))["subagent-notifications"].checkoutRoot)')
cp index.server.ts "$CHECKOUT/"
cp server/lib.ts "$CHECKOUT/server/"
sha256sum index.server.ts server/lib.ts "$CHECKOUT/index.server.ts" "$CHECKOUT/server/lib.ts"
paseo plugin reload subagent-notifications
```

Compare the four hashes before trusting anything the run produces, and run `sha256sum` again after
rolling back, so the "before" and "after" builds are both pinned rather than assumed.

Prefer this over `remove` + `install`: it leaves no window in which the plugin is absent, and
during such a window every parent on the machine silently stops being woken.

After the reload `paseo plugin ls` still prints the commit recorded in `sources.json` — the one
from the last `plugin add`, not the build now running. The hashes above and the reload event in
`~/.paseo/daemon.log` are the evidence; that column is not.

### Jump list ticks

Count the ticks in a parent's jump list by counting its `user_message` rows:

```bash
paseo logs <parentAgentId> | grep -c '^\[User\]'
```

`paseo logs` prints `[User]` for exactly `item.type === "user_message"`, the same field the
daemon's prompt index filters on to build the jump list, so this count and the tick count move
together.

Then, for each version under test: load it as above, confirm from `~/.paseo/daemon.log` that the
plugin actually reloaded (see the two traps in `CLAUDE.md` — neither the `paseo plugin ls` commit
column nor the checkout mtime tells you what is loaded), count, trigger three real wakes, count
again. Each wake leaves a `[subagent-notifications] → …` line in `daemon.log` to prove it fired.

Result on Paseo 0.8.0, three wakes per branch:

| plugin  | wakes | ticks before → after |
| ------- | ----- | -------------------- |
| 0.1.1   | 3     | 3 → 6                |
| 0.2.0   | 3     | 6 → 6                |

Under 0.2.0 all three wakes still steered the parent's running turn and still landed in the
provider transcript. The wakes left the jump list; they did not leave.

## Limitations

- Events raised while the daemon or the plugin is restarting are not replayed.
- A wake is invisible in the parent's chat and takes no slot in its jump list. It is in the parent's context and in the provider transcript, but not in the daemon's timeline. To read one back, use `get_agent_activity` on the child.
- Held messages live in memory; a plugin restart drops them.
- The message format mirrors Paseo 0.8's wording. If Paseo changes it, the parent still gets the ids it needs, only the prose differs.
- If Paseo ever adds a persistent notify option, prefer it and remove this plugin.
