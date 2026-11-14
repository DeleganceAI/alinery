import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeOwnerOnly } from "./platform/fs.ts";
import type { CreateModelsOptions } from "@earendil-works/pi-ai/models";

/** One credential per provider. The shape is whatever Pi stored; this file does not interpret it. */
type Credential = NonNullable<Awaited<ReturnType<NonNullable<CreateModelsOptions["credentials"]>["read"]>>>;
type Store = NonNullable<CreateModelsOptions["credentials"]>;

/** The whole store, `{}` for a file that is not there yet. A file that is not a JSON object is unreadable, never "empty". */
export function readStore(path: string): Record<string, Credential> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("credential store is not an object");
    return parsed as Record<string, Credential>;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return {};
    throw new Error("credential store is unreadable");
  }
}

export function credentialPath(appConfig: string): string {
  return join(dirname(appConfig), "provider-credentials.json");
}

/**
 * Owner-only file beside this app config. Not `auth.json` and not the hosted `inference.json`:
 * those belong to the Alinery account, and a provider key must not land in either.
 */
export function openCredentialStore(path: string): Store {
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const readAll = (): Record<string, Credential> => readStore(path);

  const writeAll = (all: Record<string, Credential>) => {
    mkdirSync(dirname(path), { recursive: true });
    writeOwnerOnly(path, JSON.stringify(all));
  };

  return {
    async read(providerId) {
      try {
        return readAll()[providerId];
      } catch {
        return undefined;
      }
    },
    async list() {
      let all: Record<string, Credential>;
      try {
        all = readAll();
      } catch {
        return [];
      }
      return Object.entries(all)
        .filter(([, credential]) => credential && (credential.type === "api_key" || credential.type === "oauth"))
        .map(([providerId, credential]) => ({ providerId, type: credential.type }));
    },
    modify(providerId, fn) {
      return exclusive(async () => {
        const next = await withFileLock(path, async () => {
          const all = readAll();
          const updated = await fn(all[providerId]);
          if (updated === undefined) return all[providerId];
          all[providerId] = updated;
          writeAll(all);
          return updated;
        });
        return next;
      });
    },
    delete(providerId) {
      return exclusive(() =>
        withFileLock(path, async () => {
          const all = readAll();
          delete all[providerId];
          writeAll(all);
        }),
      );
    },
  };
}

export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  // 250 x 20 ms: long enough to outwait the 5 s steal below (the Mac's credential sync, now the host service, used the same numbers).
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      closeSync(fd);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 5_000) unlinkSync(lock);
      } catch {
        /* the holder released it */
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      continue;
    }
    try {
      return await fn();
    } finally {
      try {
        unlinkSync(lock);
      } catch {
        /* already gone */
      }
    }
  }
  throw new Error("credential store is busy");
}

const isOauth = (credential: unknown) => !!credential && typeof credential === "object" && (credential as { type?: unknown }).type === "oauth";

/**
 * What the Mac asks of a host's store (credential_sync.rs `apply`): `set` replaces those providers; `remove` drops API keys the
 * app copied earlier (a sign-in made on the host since is kept); `eraseOauth` drops every browser sign-in, once. Returns the
 * sign-ins erased. Under the same `<file>.lock` the daemon takes, so a sign-in finishing at that moment is not lost.
 */
export function applyCredentialChanges(path: string, set: Record<string, Credential>, remove: string[], eraseOauth: boolean): Promise<string[]> {
  return withFileLock(path, async () => {
    const store = readStore(path);
    let erased: string[] = [];
    if (eraseOauth) {
      erased = Object.keys(store).filter((provider) => isOauth(store[provider]));
      for (const provider of erased) delete store[provider];
    }
    for (const provider of remove) if (provider in store && !isOauth(store[provider])) delete store[provider];
    Object.assign(store, set);
    mkdirSync(dirname(path), { recursive: true });
    writeOwnerOnly(path, JSON.stringify(store));
    return erased;
  });
}
