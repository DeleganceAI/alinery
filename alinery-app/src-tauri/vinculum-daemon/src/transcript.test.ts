import { expect, test } from "bun:test";
import { formatTranscript, transcriptSource, type TranscriptToolSlot } from "./transcript.ts";

const SIGNATURE = "secret-thinking-signature-do-not-show";

const stored = [
  transcriptSource("u1", { role: "user", content: "What is in this file?" }),
  transcriptSource("a1", {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Look at the file.", thinkingSignature: SIGNATURE },
      { type: "thinking", thinking: "hidden", thinkingSignature: SIGNATURE, redacted: true },
      { type: "text", text: "Reading it." },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
    ],
  }),
  transcriptSource("r1", {
    role: "toolResult",
    toolName: "read",
    toolCallId: "c1",
    isError: false,
    content: [{ type: "text", text: "export const n = 1;" }],
  }),
  transcriptSource(
    "live",
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Next", thinkingSignature: SIGNATURE },
        { type: "text", text: "And" },
      ],
    },
    true,
  ),
];

test("a stored turn and the live partial keep thinking, text, tool calls, and tool results", () => {
  const reply = formatTranscript(stored);
  expect(reply.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
  expect(reply[1]).toMatchObject({
    id: "a1",
    content: [
      { type: "thinking", thinking: "Look at the file." },
      { type: "redactedThinking" },
      { type: "text", text: "Reading it." },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
    ],
  });
  expect(reply[2]).toMatchObject({ id: "r1", role: "toolResult", toolName: "read", toolCallId: "c1", content: [{ type: "text", text: "export const n = 1;" }] });
  expect(reply[3]).toMatchObject({ id: "live", streaming: true, content: [{ type: "thinking", thinking: "Next" }, { type: "text", text: "And" }] });
  expect(JSON.stringify(reply).includes(SIGNATURE)).toBe(false);
});

test("a running slot keeps the call running and carries its output; a finished call stays the stored result", () => {
  const tools: TranscriptToolSlot[] = [
    { callId: "c1", name: "read", status: "done", output: "should not repeat" },
    { callId: "c2", name: "bash", status: "running", output: "partial out" },
    { callId: "c3", name: "edit", status: "pending" },
  ];
  const messages = [
    transcriptSource("a1", {
      role: "assistant",
      content: [
        { type: "toolCall", id: "c1", name: "read", arguments: {} },
        { type: "toolCall", id: "c2", name: "bash", arguments: { command: "ls" } },
        { type: "toolCall", id: "c3", name: "edit", arguments: { path: "a.ts" } },
      ],
    }),
    transcriptSource("r1", { role: "toolResult", toolName: "read", toolCallId: "c1", content: [{ type: "text", text: "stored" }] }),
  ];
  const reply = formatTranscript(messages, tools);
  expect(reply[0]).toMatchObject({ runningToolIds: ["c2", "c3"] });
  expect(reply[1]).toMatchObject({ id: "live:c2", role: "toolResult", streaming: true, toolName: "bash", toolCallId: "c2", content: [{ type: "text", text: "partial out" }] });
  expect(reply[2]).toMatchObject({ id: "r1", content: [{ type: "text", text: "stored" }] });
  expect(JSON.stringify(reply).includes("should not repeat")).toBe(false);
});

test("each message carries when it was complete: a reply's start plus its duration", () => {
  const reply = formatTranscript([
    transcriptSource("u", { role: "user", content: "go", timestamp: 1000 }),
    transcriptSource("a", { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2000, durationMs: 500 }),
    transcriptSource("b", { role: "assistant", content: [{ type: "text", text: "old" }] }),
  ]);
  expect(reply.map((message) => message.at)).toEqual([1000, 2500, undefined]);
});

test("a prompt's images ride as named parts, so an image-only send is still a row", () => {
  const reply = formatTranscript([
    transcriptSource("u1", {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image", data: "AAAA", mimeType: "image/png", name: "shot.png" },
        { type: "image", data: "BBBB", mimeType: "image/jpeg" },
      ],
    }),
    transcriptSource("u2", { role: "user", content: [{ type: "image", data: "CCCC", mimeType: "image/png", name: "only.png" }] }),
    transcriptSource("u3", { role: "user", content: [{ type: "text", text: "   " }] }),
  ]);
  expect(reply.map((message) => message.id)).toEqual(["u1", "u2"]);
  expect(reply[0]?.content).toEqual([
    { type: "text", text: "what is this?" },
    { type: "image", mimeType: "image/png", name: "shot.png" },
    { type: "image", mimeType: "image/jpeg" },
  ]);
  expect(reply[1]?.content).toEqual([{ type: "image", mimeType: "image/png", name: "only.png" }]);
  // The bytes stay on disk: the pane reads them back through BlobService.
  expect(JSON.stringify(reply).includes("AAAA")).toBe(false);
});
