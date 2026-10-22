# Vinculum transcript: thinking and tool calls

Status: not started. A plan only.

This is a working note, not a product contract. `README.md` is human-edited and is not the place for it.

## What Pi actually produces

Pi produces both. They are content parts on the assistant message, not a harness side channel.

An assistant message is `(TextContent | ThinkingContent | ToolCall)[]`. The provider stream emits `thinking_start` / `thinking_delta` / `thinking_end` and `toolcall_start` / `toolcall_delta` / `toolcall_end`, and each event carries the response so far. pi-durable commits that partial onto `LiveDoc.generation.message` about every 100 ms. A finished turn is stored as `entry.model`. A tool result is its own `toolResult` message. While a tool runs, `LiveDoc.tools` has the call id, name, status (`pending` | `running` | `done`), and the retained output.

Thinking is the part we do not get today, and that is a setting, not a missing stream. pi-durable's agent defaults `thinkingLevel` to `"off"`, and generation only sends `reasoning` when the level is not off. Vinculum configures `{ model: { provider, modelId } }` and never sets a level, so the model is not asked to think. Hosted catalog models are also registered with `reasoning: false`. Grok models copied from the xAI catalog have `reasoning: true`, so they will think once a level is set. Tool calls are produced either way.

## What the pane sees now

`formatTranscript` in `vinculum-daemon/src/main.ts` keeps user text, joins assistant text, and reduces a tool call to `{ role: "tool", text: name }`. Thinking parts are skipped. Tool-result messages are skipped. Arguments, status, and output are skipped.

Chat and session chat both poll that list once a second (`chatThreadSession.tsx`, `SessionView.tsx`) and fold it with `applyVinculumTranscript`. That function wraps every string as a text part. A `tool` row becomes a `tool_result` whose body is the tool name. The thinking and tool-call rows, and the "Thinking…" label, only exist for the old OMP events. Vinculum never sends those events.

The app deserializes the reply into `TranscriptMessage { role, text }` in `alinery-core/src/daemon_client.rs`. Extra JSON fields are dropped before the view runs. Both `chat_transcript` and `session_transcript` use that struct.

Show thinking and Show tools still default off (`appearance.ts`). That was true for OMP too. Surfacing the parts does not by itself turn the rails on.

## Change

Keep the transcript poll. Do not add a socket stream and do not reintroduce the OMP event names.

One reply shape for both views. Each item is a message the existing mapper already understands:

- `user`: text parts.
- `assistant`: `thinking`, `text`, and `toolCall` parts. A redacted thinking part (`redacted: true`) becomes `redactedThinking`, not the signature text. `toolCall.arguments` is the field `mapPart` already reads.
- `toolResult`: tool name, call id, error flag, and text parts.

Carry the Pi entry id on each stored message. The in-flight partial uses a fixed id, `live`, and `streaming: true`. `applyVinculumTranscript` stops inventing `v${index}` text rows. It hydrates through `mapContent` and `explodeAssistantParts`, and it marks the partial's thinking, text, and tool-call parts streaming. Row keys stay `entry id + part key`, so a growing partial does not remount earlier rows. When the partial commits, that one row moves from `live` to the entry id.

A tool call whose id is still `pending` or `running` in `LiveDoc.tools` stays a running tool-call row after the assistant message has committed. If that slot has output, show it as the running tool-result text. A finished call keeps the stored `toolResult`. Nested tool slots stay out of this pass.

The per-session thinking picker, and the model label that has to move with it, are specified in `docs/vinculum-model-thinking-plan.md`. That plan replaces the earlier “no second thinking control” note. A model with `reasoning: false` still stays at `off`, so a request does not ask for a trace the catalog says it cannot return.

The 100 ms partial is already finer than the view. While a session is busy, poll the transcript faster than the current 1 s. Idle stays at 1 s. No new op.

`TranscriptMessage` has to grow the parts, because the Rust client is what the views receive. That is a reply-format change, so bump `PROTOCOL_VERSION` and the assertion in `protocol.rs` that pins it at 18. App and daemon ship together on this branch. A protocol bump means a running daemon is not reused; restart `tauri dev` after it.

Leave the Show thinking and Show tools switches, and their defaults, alone. With the switches on, chat and session chat show the same rails OMP did. With them off, a live turn still reads "Working…", which is what a running status with no visible thinking or tool row already does.

## Tests

- A daemon-side formatter test: an assistant message with thinking, text, and a tool call, plus a tool-result message and a live partial, becomes the reply above. A redacted thinking part does not leak its signature. A running slot keeps the call running and carries its output.
- `applyVinculumTranscript` builds a thinking row, a tool-call row, and a tool-result row from that reply, and a second poll that only appends text keeps the earlier row ids.
- The protocol assertion matches the bumped version.

## Not in this pass

No OMP RPC attach. No `thinking_delta` forwarded over the socket. No change to terminal sessions. No nested-tool tree. No change to the default visibility switches.
