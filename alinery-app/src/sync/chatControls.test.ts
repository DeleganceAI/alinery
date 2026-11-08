import { createRouterTransport, type Transport } from "@connectrpc/connect";
import { ChatService } from "alinery-proto/alinery/v1/chat_pb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { daemonTransport } from "../daemon/transport";
import { abortChatThread, promptChatThread, setChatModel, setChatThinkingLevel } from "./chat";

vi.mock("../daemon/transport", () => ({ daemonTransport: vi.fn() }));
vi.mock("../ipc", () => ({ prepareHostedInference: vi.fn(), listChatRepos: vi.fn(), onRemoteHostConnected: () => () => {}, readLocalFile: vi.fn() }));

let seen: { repo: string; call: string; req: Record<string, unknown> }[];

beforeEach(() => {
  seen = [];
  vi.mocked(daemonTransport).mockImplementation((repo: string) => {
    const handler = (call: string, reply: unknown) => (req: never) => {
      seen.push({ repo, call, req: req as never });
      return reply as never;
    };
    return createRouterTransport((router) => {
      router.service(ChatService, {
        promptChatThread: handler("promptChatThread", {}),
        abortChatThread: handler("abortChatThread", {}),
        setChatModel: handler("setChatModel", { controls: { model: "anthropic/claude", thinking: "off", thinkingLevels: [] } }),
        setChatThinkingLevel: handler("setChatThinkingLevel", { controls: { model: "xai/grok", thinking: "low", thinkingLevels: ["off", "low"] } }),
      } as never);
    }) as Transport;
  });
});
afterEach(() => vi.resetAllMocks());

it("a thread's turn controls go to the daemon of the repo the thread is in, by thread id", async () => {
  await promptChatThread("/a", "t1", "hello");
  await abortChatThread("/b", "t2");
  expect(seen.map((s) => [s.repo, s.call])).toEqual([
    ["/a", "promptChatThread"],
    ["/b", "abortChatThread"],
  ]);
  expect(seen[0].req).toMatchObject({ threadId: "t1", text: "hello" });
  expect((seen[0].req.meta as { mutationId: string }).mutationId).not.toBe("");
  expect(seen[1].req).toMatchObject({ threadId: "t2" });
});

it("a model or thinking change answers with the controls in the shape the views read", async () => {
  expect(await setChatModel("/a", "t1", "anthropic/claude")).toEqual({ model: "anthropic/claude", thinking: "off", thinking_levels: [] });
  expect(await setChatThinkingLevel("/a", "t1", "low")).toEqual({ model: "xai/grok", thinking: "low", thinking_levels: ["off", "low"] });
  expect(seen[0].req).toMatchObject({ threadId: "t1", model: "anthropic/claude" });
  expect(seen[1].req).toMatchObject({ threadId: "t1", level: "low" });
});
