# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Paseo distributes plugins by pinning a commit, so each version below is also an annotated git
tag (`v0.1.0` … `v0.3.0`): `git show v0.3.0` resolves the commit to pin. Numbers quoted here were
measured against a running Paseo daemon (0.8.0 up to 0.2.0, 0.10.2 for 0.3.0); anything not
measured says so.

## [Unreleased]

### Fixed

- **A held finished-turn wake is delivered after at most 2 minutes.** A Claude Code parent that
  replied and waits on its own background subagent stays `running` with no `turn_ended`, so the
  0.4.0 hold kept a wake for 45 minutes (daemon.log 07:40:43 held, 08:25:31 delivered). Not yet
  measured against a live daemon.

## [0.4.0] - 2026-10-07

A finished child no longer aborts the parent's running tool.

### Fixed

- **Finished-turn wakes wait for the parent's turn to end.** On the Claude provider a steer is
  queued with `priority: "next"` and aborts the tool in flight, which Claude Code reports to the
  parent as a user rejection ("STOP what you are doing and wait for the user"); a parent hit this
  stalled for 17 minutes waiting for a decision nobody had asked for. Turn results are now held
  while the parent is `running` and sent as one message when its turn ends (or when its pending
  permission resolves and it is no longer running). Child questions are still sent at once.

  Measured on Paseo 0.10.3, parent running a foreground 45 s sleep while its child finished: 0.3.0
  rejected the Bash call 6 ms after the wake; 0.4.0 held the wake, the call returned `SLEPT-DONE`,
  and the wake arrived 1.7 s after it.

## [0.3.0] - 2026-10-01

Every parent is covered without setup, under a name that matches Paseo's own vocabulary.

### Changed

- **Renamed `parent-wake` → `subagent-notifications`**: the plugin id, the opt-out label, the log
  prefix and the repository (`paseo-subagent-notifications`). Paseo calls a spawned agent a
  subagent and its built-in callback a finish notification; this plugin extends that callback, so
  it now carries that name. Reinstall under the new id and remove the old one.
- **On by default.** The `subagent-notifications` label is now an opt-out: only `off`, `false`,
  `0` or an empty value on the parent or the child silences the wake. Before, a parent without the label
  heard only Paseo's own first notification and missed the rest.

  Measured on Paseo 0.10.2 with a parent → child → background subagent (`sleep 45`) chain, no
  labels anywhere: with 0.2.0 the parent heard 1 wake (`CHILD-WAITING`, from Paseo's
  `notifyOnFinish`); with 0.3.0 and `notifyOnFinish: false` it heard 3 (`CHILD-WAITING`, the
  intermediate turn, `CHILD-FINAL`).

## [0.2.0] - 2026-09-18

Wakes stop cluttering the parent's jump list.

### Changed

- **A wake no longer adds a tick to the parent's message jump list** — the strip down the left
  margin of the chat where each tick jumps back to one earlier message. Before this release every
  wake landed there, so a parent watching a busy child collected a tick per event and its own
  prompts became hard to find.

  The wake is sent with an empty message id, which the daemon drops rather than replacing, so no
  `user_message` timeline row is written and the jump list, built from exactly those rows, does
  not grow.

  Measured, three wakes per branch, counting the parent's `user_message` rows:

  | plugin | wakes | ticks before → after |
  | ------ | ----- | -------------------- |
  | 0.1.1  | 3     | 3 → 6                |
  | 0.2.0  | 3     | 6 → 6                |

  What a wake still does is unchanged and was checked on both branches: it reaches the parent's
  context, it steers the parent's running turn, and it appears in the provider transcript. It is
  now absent from the daemon's timeline, so to read one back, use `get_agent_activity` on the
  child.

### Upgrade notes

**Nothing to do.** No label and no call changes.

## [0.1.1] - 2026-09-17

The first line of a wake is readable without decoding ids.

### Changed

- **A permission wake leads with the child's name and its actual question**, and moves the ids to
  their own line. `Agent <child-id> (<title>) needs permission.` became:

  ```
  <title> asks: "<the question>" — <the options>

  Answer with `respond_to_permission` · agentId: <child-id> · requestId: <request-id>
  ```

  A request that carries no question falls back to `needs permission (<tool name>)`. The
  `<permission-request>` block below it is unchanged: still the request exactly as Paseo reported
  it.
- **A finished-turn wake reads `<title> finished. · agentId: <child-id>`**, and a failed one
  `<title> errored: <message>`, instead of leading with the id.
- **The title is read fresh at wake time.** Agents are often renamed after they start, so the name
  in the wake is the one the child carries now, not the one it had when the event fired.

### Upgrade notes

**Nothing to do**, unless something of yours parses the wake text. The ids a parent needs are all
still present, on the second line of a permission wake and after `· agentId:` on a turn wake.

## [0.1.0] - 2026-09-17

First version.

### Added

- **Wakes a parent agent on every question and every finished turn of its children**, not only
  the first one. Paseo's built-in `notifyOnFinish` subscribes the parent once per prompt and ends
  at the child's first finished or errored turn, so a child that ends a turn early and asks a
  question later wakes nobody. This plugin listens to the daemon's lifecycle hooks instead and
  keeps waking for as long as the child carries the `paseo.parent-agent-id` label and the parent
  is not archived.
- **Opt-in by label**, on either side, with any value except `off`, `false`, `0`:
  - on the parent, covering every child it spawns:
    `update_agent(agentId: <own id>, labels: {"parent-wake": "always"})`
  - on a child, at spawn time:
    `create_agent(..., labels: {"parent-wake": "always"}, notifyOnFinish: false)`

  An agent without the label keeps Paseo's built-in behavior unchanged.
- **Held delivery.** If the parent has a permission of its own pending, the wake is held and
  delivered when that permission resolves or the parent's turn ends. Sending it immediately would
  clear the parent's pending question.
- Each permission request id is delivered once, and wakes are sent with
  `activeTurnBehavior: "steer"` so a running parent is not interrupted. Turns that were canceled
  raise no wake.

### Upgrade notes

Requires Paseo 0.8 or later, and plugins enabled on the daemon
(**Settings → Plugins → Enable plugins**). Pass `notifyOnFinish: false` on `create_agent` and
`send_agent_prompt` once the plugin is active, otherwise the first notification arrives twice:
once from Paseo, once from the plugin.

### Known limits

- Events raised while the daemon or the plugin is restarting are not replayed.
- Held messages live in memory; a plugin restart drops them.
- The message format mirrors Paseo 0.8's wording. If Paseo changes it, the parent still gets the
  ids it needs, only the prose differs.
