// ChatService (plan S4.4): the writes of a chat thread. The thread itself is the `chat/_/<id>` and `session/_/<id>`
// entities; its attachments go through BlobService. The file and git half is `domain/chat.ts`.
import type { ServiceImpl } from "@connectrpc/connect";
import { Capability } from "alinery-proto/alinery/v1/admin_pb";
import type { ChatService } from "alinery-proto/alinery/v1/chat_pb";
import { canvasRel, closePanelByUser, enableCanvas } from "../domain/canvas.ts";
import { archiveChatThread, createChatThread, loadChat, removeChatWorktree, resumeChatThread, setChatPinned } from "../domain/chat.ts";
import type { Json } from "../domain/sessionOps.ts";
import type { Dedupe } from "../sync/dedupe.ts";
import type { Store } from "../sync/store.ts";
import { requireCapability } from "./auth.ts";
import { domain, metaOf } from "./errors.ts";
import { controlsOf, metaRel, nameRel, promptImages, ranOrFail, type SessionControl, started } from "./sessions.ts";

export function chatService(c: SessionControl, dedupe: Dedupe, store: Store): ServiceImpl<typeof ChatService> {
  const applied = () => ({ cursor: store.cursor() });
  const once = <T>(meta: Parameters<typeof metaOf>[0], fn: () => Promise<T>) => dedupe.once(metaOf(meta), () => domain(fn));
  /** The files a write changed are in the store, and so is the thread's own row, before the reply. */
  const settle = async (...ids: string[]) => {
    for (const id of ids) {
      await c.refresh(metaRel("", id));
      await c.refresh(nameRel("", id));
      await c.chat.refresh(id);
    }
  };
  return {
    createChatThread: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return once(req.meta, async () => {
        const reply: Json = ranOrFail(await createChatThread(c.repo, c.runner, req.model, req.createWorktree));
        const id = String((reply.session as Json).id);
        await settle(id);
        return { applied: applied(), started: started(reply) };
      });
    },
    startChatThread: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return once(req.meta, async () => {
        const reply = ranOrFail(await c.runner.start({ task_slug: "", session_id: req.threadId }));
        await settle(req.threadId);
        return { applied: applied(), started: started(reply) };
      });
    },
    setChatPinned: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return once(req.meta, async () => {
        setChatPinned(c.repo, req.threadId, req.pinned);
        await settle(req.threadId);
        return { applied: applied() };
      });
    },
    archiveChatThread: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return once(req.meta, async () => {
        await archiveChatThread(c.repo, c.runner, req.threadId, req.removeWorktree, () => settle(req.threadId));
        await settle(req.threadId);
        return { applied: applied() };
      });
    },
    removeChatWorktree: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return once(req.meta, async () => {
        await removeChatWorktree(c.repo, c.runner, req.threadId);
        await settle(req.threadId);
        return { applied: applied() };
      });
    },
    resumeChatThread: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return once(req.meta, async () => {
        const successor = await resumeChatThread(c.repo, c.runner, req.threadId);
        const id = String(successor.id);
        await settle(req.threadId, id);
        return { applied: applied(), successorId: id };
      });
    },
    // The controls name a thread, and a thread is a root session of the chat kind (`loadChat` refuses any other id).
    promptChatThread: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return once(req.meta, async () => {
        loadChat(c.repo, req.threadId);
        await c.turns.prompt(req.threadId, req.text, promptImages(req.images));
        return {};
      });
    },
    abortChatThread: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return domain(async () => {
        loadChat(c.repo, req.threadId);
        await c.turns.abort(req.threadId);
        return {};
      });
    },
    setChatModel: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return once(req.meta, async () => {
        loadChat(c.repo, req.threadId);
        return controlsOf(await c.turns.setModel(req.threadId, req.model));
      });
    },
    enableCanvas: (req, ctx) => {
      requireCapability(ctx, Capability.APPROVE);
      return once(req.meta, async () => {
        if (await enableCanvas(c.repo, req.threadId)) await c.runner.canvasEnabled?.(req.threadId);
        await c.refresh(canvasRel(req.threadId));
        return { applied: applied() };
      });
    },
    closeCanvasPanel: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return once(req.meta, async () => {
        await closePanelByUser(c.repo, req.threadId, req.panel);
        await c.refresh(canvasRel(req.threadId));
        return { applied: applied() };
      });
    },
    setChatThinkingLevel: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return once(req.meta, async () => {
        loadChat(c.repo, req.threadId);
        return controlsOf(await c.turns.setThinkingLevel(req.threadId, req.level));
      });
    },
  };
}
