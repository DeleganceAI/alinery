import { randomUUID } from "node:crypto";
import type { MutableModels } from "@earendil-works/pi-ai/models";

type AuthType = "api_key" | "oauth";
type Interaction = Parameters<MutableModels["login"]>[2];
type Prompt = Parameters<Interaction["prompt"]>[0];
type Notify = Parameters<Interaction["notify"]>[0];

export type LoginPrompt = {
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: { id: string; label: string; description?: string }[];
};

export type LoginEvent =
  | { type: "info"; message: string; links?: { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: "progress"; message: string };

export type LoginStatus = {
  loginId: string;
  status: "pending" | "prompt" | "done" | "error" | "cancelled";
  prompt?: LoginPrompt;
  events: LoginEvent[];
  failure?: string;
};

type Waiter = { resolve: (value: string) => void; reject: (error: Error) => void };

type Session = {
  id: string;
  provider: string;
  status: LoginStatus["status"];
  prompt?: LoginPrompt;
  events: LoginEvent[];
  failure?: string;
  waiter: Waiter | null;
  abort: AbortController;
  started: number;
};

export function createLoginBroker(models: MutableModels, options: NonNullable<Parameters<MutableModels["login"]>[3]>) {
  const sessions = new Map<string, Session>();

  const fail = (session: Session, error: unknown) => {
    session.prompt = undefined;
    session.waiter = null;
    if (session.abort.signal.aborted) {
      session.status = "cancelled";
      return;
    }
    session.status = "error";
    session.failure = error instanceof Error ? error.message : String(error);
  };

  return {
    start(providerId: string, method: AuthType): LoginStatus {
      const provider = models.getProvider(providerId);
      if (!provider) throw new Error(`unknown provider ${providerId}`);
      if (method === "api_key" && !provider.auth.apiKey?.login) throw new Error(`${provider.name} has no API key sign-in`);
      if (method === "oauth" && !provider.auth.oauth?.login) throw new Error(`${provider.name} has no browser sign-in`);
      for (const session of sessions.values()) {
        if (session.status === "pending" || session.status === "prompt") session.abort.abort();
      }
      const session: Session = {
        id: randomUUID(),
        provider: providerId,
        status: "pending",
        events: [],
        waiter: null,
        abort: new AbortController(),
        started: Date.now(),
      };
      sessions.set(session.id, session);
      for (const [id, older] of sessions) {
        if (sessions.size <= 8) break;
        if (older.status !== "pending" && older.status !== "prompt") sessions.delete(id);
      }
      const interaction = {
        signal: session.abort.signal,
        prompt(prompt: Prompt) {
          return new Promise<string>((resolve, reject) => {
            if (session.abort.signal.aborted) {
              reject(new Error("cancelled"));
              return;
            }
            session.prompt = viewPrompt(prompt);
            session.status = "prompt";
            session.waiter = {
              resolve,
              reject,
            };
            const cancel = () => {
              if (!session.waiter) return;
              session.waiter = null;
              session.prompt = undefined;
              reject(new Error("cancelled"));
            };
            session.abort.signal.addEventListener("abort", cancel, { once: true });
            prompt.signal?.addEventListener("abort", cancel, { once: true });
          });
        },
        notify(event: Notify) {
          session.events.push(viewEvent(event));
        },
      } satisfies Interaction;
      void models
        .login(providerId, method, interaction, options)
        .then(() => {
          session.prompt = undefined;
          session.waiter = null;
          if (session.abort.signal.aborted) session.status = "cancelled";
          else session.status = "done";
        })
        .catch((error: unknown) => fail(session, error));
      return snapshot(session);
    },
    poll(loginId: string): LoginStatus {
      const session = sessions.get(loginId);
      if (!session) throw new Error("unknown login");
      const status = snapshot(session);
      session.events = [];
      return status;
    },
    reply(loginId: string, value: string) {
      const session = sessions.get(loginId);
      if (!session?.waiter) throw new Error("no prompt is waiting");
      const waiter = session.waiter;
      session.waiter = null;
      session.prompt = undefined;
      session.status = "pending";
      waiter.resolve(value);
    },
    cancel(loginId: string) {
      const session = sessions.get(loginId);
      if (!session) return;
      session.abort.abort();
    },
  };
}

function snapshot(session: Session): LoginStatus {
  return {
    loginId: session.id,
    status: session.status,
    prompt: session.prompt,
    events: [...session.events],
    failure: session.failure,
  };
}

function viewPrompt(prompt: Prompt): LoginPrompt {
  if (prompt.type === "select") {
    return {
      type: "select",
      message: prompt.message,
      options: prompt.options.map((option) => ({ id: option.id, label: option.label, description: option.description })),
    };
  }
  return { type: prompt.type, message: prompt.message, placeholder: "placeholder" in prompt ? prompt.placeholder : undefined };
}

function viewEvent(event: Notify): LoginEvent {
  if (event.type === "device_code") {
    return {
      type: "device_code",
      userCode: event.userCode,
      verificationUri: event.verificationUri,
      intervalSeconds: event.intervalSeconds,
      expiresInSeconds: event.expiresInSeconds,
    };
  }
  if (event.type === "auth_url") return { type: "auth_url", url: event.url, instructions: event.instructions };
  if (event.type === "info") return { type: "info", message: event.message, links: event.links?.map((link) => ({ url: link.url, label: link.label })) };
  return { type: "progress", message: event.message };
}
