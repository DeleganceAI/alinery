// Titling and seeding read the person's words. A compaction entry's model rows are the harness summary, not a prompt.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation } from "@earendil-works/pi-durable";
import { COMPACTION_ENTRY, hasSpoken } from "./transcript.ts";

const context = BACKGROUND_CONTEXT;

export async function modelMessages(conversation: Conversation) {
  const messages: Awaited<ReturnType<Conversation["context"]>>["messages"] = [];
  let cursor: Awaited<ReturnType<Conversation["entries"]>>["next"];
  for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
    const page = await conversation.entries({ order: "ascending" }, 200, cursor, context);
    for (const entry of page.items) {
      if (entry.kind === COMPACTION_ENTRY) continue;
      messages.push(...(entry.model ?? []));
    }
    cursor = page.next;
    if (!cursor) break;
  }
  return messages;
}

export async function userMessageCount(conversation: Conversation): Promise<number> {
  return (await modelMessages(conversation)).filter((message) => message.role === "user").length;
}

/** Seeds the opening prompt only when the person has not spoken. A compaction summary is not speech. */
export async function seedPrompt(conversation: Conversation, prompt: string) {
  if (!prompt) return;
  const page = await conversation.entries({ order: "ascending" }, 200, undefined, context);
  if (hasSpoken(page.items)) return;
  await conversation.submit({ type: "input", content: prompt, whenBusy: "followUp" }, context);
}
