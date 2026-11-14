# Vinculum model change and thinking level

Status: done. The transcript reply carries `model`, `thinking`, and `thinking_levels`. `set_model` and `set_thinking_level` return the same three fields. A new session takes the settings thinking level once, at open. Protocol is 21.

This is a working note, not a product contract. `README.md` is human-edited and is not the place for it.

Pi can change both after a session has started. The chat and task-session pickers already call `set_model`, and the daemon already applies it. The pane keeps the old label, so the switch looks like a no-op. The thinking menu is still the OMP one, and for a Vinculum session it does nothing.

## What Pi does

`conversation.configure({ model, thinkingLevel })` writes the conversation's `pi.agent` document. A later turn reads that document when it prepares the request. The model and level of a turn already in `prepare` stay what they were; the next turn uses the new values. There is no "fork a new session to switch" requirement.

`thinkingLevel` is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Unset means `off`. Generation sends `reasoning` only when the level is not `off`.

A chat model has `reasoning: boolean` and an optional `thinkingLevelMap`. A missing map key uses the provider default. A `null` value means that level is not supported. Hosted Alinery models are registered with `reasoning: false`. Grok models copied from the xAI catalog have `reasoning: true`.

## Why the picker looks broken

`set_model` in `vinculum-daemon/src/main.ts` resolves `provider/modelId`, calls `ensureModel(..., force)`, and writes the resolved id into the session meta. `ensureModel` with `force` calls `configure({ model })`. A following prompt reads that meta and does not put the old model back.

The label does not move.

- Chat shows `transcript.sessionMeta.model`, then the thread row's `session.model`. The thread row is the meta from the last list, and nothing reloads it after `set_model`.
- A task session shows `chat.sessionMeta.model`, then the `model` prop from the session list. Same stale fallback.
- `applyVinculumTranscript` rebuilds from `emptyTranscript()` on every poll. `sessionMeta` comes back empty, so a local patch would be gone within a second.
- The dialog's current-model highlight reads that same empty `sessionMeta.model`, so the open picker does not mark the model that is actually running.

A failed switch is a real error (`unknown-session` if the Pi conversation is not open yet, or `no model is configured`). Chat puts it on the thread error. A task session leaves it in the dialog. A success closes the dialog and leaves the old name up, which is what reads as "nothing happened".

`prompt` and the playbook `send` path call `ensureModel` without `force`. That refuses to replace a model that is already set, except for the `alinery/grok-*` to xAI remap. `set_model` is the only path that is allowed to replace one. Keep it that way: a prompt must not undo a switch, and a playbook turn must not either.

## Why thinking does nothing

The control is `ThinkingSelect` in the chat title bar and in the task-session meta line. It renders only when `sessionMeta.thinking` is set, and its choices come from `sessionMeta.thinkingLevels`. Vinculum's transcript never sets either, so the control is absent.

If it were shown, the handlers still would not reach Pi. Chat writes `set_thinking_level` through `chatRpcWrite`, which returns `OMP process sessions are not available`. A task session returns immediately when the harness is Vinculum (`vinculum` is `harness === "omp"` in `SessionView`).

New conversations are created with a model and no level, so Pi stores `off`. Settings → thinking level (`defaults.thinking`, invalid or blank falling back to `high` via `thinking_launch_level`) is never read. The Settings hint still says new OMP sessions start at that level.

## Change

One session state for both panes: the model Pi will use on the next turn, the thinking level it will use, and the levels this model offers. Chat and a task session read the same reply and render the controls they already have.

### Model

Keep `set_model`. Do not add a second op.

The reply, and the transcript poll, carry the resolved model as `provider/modelId` (the same string `writeMeta` stores). `applyVinculumTranscript` writes it onto `sessionMeta.model` and keeps it across polls. The label, the dialog highlight, and the thread or session row all show that string. A poll must not wipe it back to empty and fall through to the stale list row.

`set_model` still requires the conversation to be open. A thread that has not started yet has no Pi conversation; the existing start path keeps using the model already on the meta. Do not invent a second "remember this until open" store.

An in-flight turn finishes on the model it started with. Say that in the control title, not in a toast. The next send uses the new model.

`alinery/grok-*` stays the on-disk exception `resolveModel` already has. The label shows the resolved `xai/...` id, which is what the next turn runs.

### Thinking level

New op `set_thinking_level`, body `{ id, level }`, same session lookup as `set_model`. It calls `configure({ thinkingLevel })` and does not write a second file. The level lives on `pi.agent`, so a resume keeps it. A human change is not overwritten by the Settings default.

A new conversation, and a resumed one whose agent has no stored level, takes `defaults.thinking` through the existing `thinking_launch_level` rule (`high` when unset or not one of the seven names). Read it once at open, from the repo settings the daemon can already see. Do not read it again on later turns.

Offered levels, computed from the model Pi resolved:

- `reasoning: false`: no menu. The level stays `off`. Do not send `reasoning` for a model the catalog says cannot think. Hosted Alinery models are in this group.
- `reasoning: true` and no map: `off` plus every name in `THINKING_LEVELS`.
- `reasoning: true` with a map: `off` plus every name whose map value is not `null`. A missing key stays, because Pi treats that as the provider default.

The stored level is always shown, even when this model does not list it. `ThinkingSelect` already appends an unknown current value. Picking a level the model does not offer is a daemon error, not a silent clamp.

Changing the model does not reset a stored level. If the new model has `reasoning: false`, the next turn still runs at `off` and the menu hides. Switching back to a reasoning model shows the stored level again.

Chat's `pickThinking` stops calling `chatRpcWrite`. The task-session handler stops returning early for Vinculum. Both call the new op. The label moves when the poll reports the level, not before, which is the rule `ThinkingSelect` already documents.

The menu stays disabled while the session is not running, with the sentences already written ("Ava is not running in this thread", "The session is not running"). An in-flight turn keeps its snapshotted level; the title says the next turn picks up the change.

Settings keeps the default. Change its hint from "New OMP sessions" to new sessions. Resumed sessions still keep their own level.

### Reply shape

Put `model`, `thinking`, and `thinking_levels` on the transcript reply, next to `messages`, not inside each message. Both `chat_transcript` and `session_transcript` already share that reply. One parse in `daemon_client.rs`, one fold in `applyVinculumTranscript`.

`set_model` and `set_thinking_level` return the same three fields with `ok: true`, so the pane can move the label before the next poll. A poll is still the source of truth and overwrites that optimistic value.

This is a reply-format change. `PROTOCOL_VERSION` is 20 after the transcript parts landed. Bump it again, and bump the assertion in `protocol.rs` that pins 20 to those parts. App and daemon ship together. A running daemon is not reused; restart `tauri dev` after it.

Do not fold this into the thinking-and-tool-call transcript work. That plan changes what is inside each message. This one adds fields beside the list. Either can land first. The sentence in `docs/vinculum-transcript-plan.md` that said not to add a thinking control now points here.

Terminal (`no-harness`) sessions have neither control. Do not send them these ops.

## Tests

- Daemon: `set_model` on an open conversation changes `agent.model`, writes the meta, and the next `ensureModel` without `force` leaves it. A prompt does not revert it. An unknown session and a blank model still error and write nothing.
- Daemon: `set_thinking_level` changes `agent.thinkingLevel` and does not touch the meta file. A level outside the seven names errors. A new conversation with no stored level gets the settings value, and `high` when that value is blank.
- Level list: a `reasoning: false` model offers nothing and stays `off`. A map with `minimal: null` drops `minimal` and keeps a missing key. The stored level is still reported when it is not in the list.
- `applyVinculumTranscript` keeps `model`, `thinking`, and `thinking_levels` from the reply, and a second poll that only appends a message does not clear them.
- Chat and session view: a successful set updates the label from the reply. The Vinculum thinking handler calls `set_thinking_level` and does not call `rpcWrite` or `chatRpcWrite`. The protocol assertion matches the bumped version.

## Not in this pass

No change to Show thinking or Show tools. Thinking text and tool rows are already on the transcript reply (`docs/vinculum-transcript-plan.md`); this pass only adds the model and thinking level beside that list. No per-message model stamp. No second protocol. No live model discovery. The harness key stays `omp`.
