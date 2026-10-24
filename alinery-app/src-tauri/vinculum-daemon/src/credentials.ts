import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CreateModelsOptions } from "@earendil-works/pi-ai/models";

/** One credential per provider. The shape is whatever Pi stored; this file does not interpret it. */
type Credential = NonNullable<Awaited<ReturnType<NonNullable<CreateModelsOptions["credentials"]>["read"]>>>;
type Store = NonNullable<CreateModelsOptions["credentials"]>;

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

  const readAll = (): Record<string, Credential> => {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("credential store is not an object");
      return parsed as Record<string, Credential>;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code === "ENOENT") return {};
      throw new Error("credential store is unreadable");
    }
  };

  const writeAll = (all: Record<string, Credential>) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(all), { mode: 0o600 });
    chmodSync(path, 0o600);
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

async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 50; attempt += 1) {
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
