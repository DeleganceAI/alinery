// Pi numbers conversation ids from 1 inside each session file. Two live sessions therefore
// both have a root conversation "1". The environment object is built for the session
// whose tool is running, and that is the only caller identity that does not collide.
const owners = new WeakMap<object, { id: string }>();

export function rememberSessionEnv(env: object, session: { id: string }) {
  owners.set(env, session);
}

/** The one live row with this conversation id, or none when more than one shares it. */
export function soleConversationOwner<T extends { conversationId: string }>(sessions: Iterable<T>, conversationId: string): T | undefined {
  let found: T | undefined;
  for (const row of sessions) {
    if (row.conversationId !== conversationId) continue;
    if (found) return undefined;
    found = row;
  }
  return found;
}

/** Prefer the session stamped on this call's environment. Never guess among colliding conversation ids. */
export function sessionByToolEnv<T>(env: unknown, conversationId: string, byId: (id: string) => T | undefined, sessions: Iterable<T & { conversationId: string }>): T | undefined {
  if (typeof env === "object" && env !== null) {
    const owner = owners.get(env);
    // A resumed conversation can reuse its session id. A stopped harness's tool still
    // carries its old environment and must not acquire the replacement's execution.
    if (owner) {
      const current = byId(owner.id);
      return Object.is(owner, current) ? current : undefined;
    }
  }
  return soleConversationOwner(sessions, conversationId);
}
