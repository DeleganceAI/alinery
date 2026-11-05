import { fromJson, type MessageInitShape } from "@bufbuild/protobuf";
import { ValueSchema, type JsonValue } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { Capability } from "alinery-proto/alinery/v1/admin_pb";
import { type SessionService, type TranscriptItemSchema, type WatchTranscriptResponseSchema } from "alinery-proto/alinery/v1/sessions_pb";
import { watchTranscript, type TranscriptFrame, type TranscriptFeed } from "../runtime/transcript.ts";
import type { TranscriptPart, TranscriptReply } from "../transcript.ts";
import { requireCapability } from "./auth.ts";

/** The session's transcript source, or undefined when it is not open in this daemon. */
export type Transcripts = (taskSlug: string, id: string) => Promise<TranscriptFeed | undefined>;

type Item = MessageInitShape<typeof TranscriptItemSchema>;

function part(p: TranscriptPart): NonNullable<Item["content"]>[number] {
  switch (p.type) {
    case "text":
      return { kind: { case: "text", value: p.text } };
    case "thinking":
      return { kind: { case: "thinking", value: p.thinking } };
    case "redactedThinking":
      return { kind: { case: "redactedThinking", value: {} } };
    case "toolCall":
      return {
        kind: {
          case: "toolCall",
          value: { id: p.id, name: p.name, ...(p.arguments === undefined ? {} : { arguments: fromJson(ValueSchema, p.arguments as JsonValue) }) },
        },
      };
  }
}

export function toItem(item: TranscriptReply): Item {
  return {
    id: item.id,
    role: item.role,
    streaming: item.streaming === true,
    content: item.content.map(part),
    toolName: item.toolName ?? "",
    toolCallId: item.toolCallId ?? "",
    isError: item.isError === true,
    runningToolIds: item.runningToolIds ?? [],
  };
}

export function toResponse(frame: TranscriptFrame): MessageInitShape<typeof WatchTranscriptResponseSchema> {
  return {
    items: frame.items.map(toItem),
    nextItem: BigInt(frame.nextItem),
    replace: frame.replace,
    ...(frame.controls ? { controls: { model: frame.controls.model, thinking: frame.controls.thinking, thinkingLevels: frame.controls.thinking_levels } } : {}),
  };
}

export function sessionService(transcripts: Transcripts): ServiceImpl<typeof SessionService> {
  return {
    async *watchTranscript(req, ctx) {
      requireCapability(ctx, Capability.VIEW);
      if (!req.session?.id) throw new ConnectError("WatchTranscript needs a session", Code.InvalidArgument);
      const source = await transcripts(req.session.taskSlug, req.session.id);
      if (!source) throw new ConnectError(`no open session ${req.session.id}`, Code.NotFound);
      for await (const frame of watchTranscript(source, Number(req.fromItem), ctx.signal)) yield toResponse(frame);
    },
  };
}
