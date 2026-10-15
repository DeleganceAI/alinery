// External-only derivative: native incomplete recovery and conditional restoration.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.includes("--help")) {
  console.log(
    "Usage: node external_maintenance_lifecycle_smoke.mjs\nRuns real incomplete recovery with no summarizable history. Exit 3 = bounded assertions passed; automatic all-entry coverage remains unproved. Exit 1 = diagnostic failure.",
  );
  process.exit(0);
}
assert.equal(process.argv.length, 2, "Unknown arguments");

async function recoveryWorkflow(api, config, ctx) {
  const { TurnRecovery } = await import("@oh-my-pi/pi-coding-agent/session/turn-recovery");
  const { SessionMaintenance } = await import("@oh-my-pi/pi-coding-agent/session/session-maintenance");
  const receivers = new WeakMap();
  let bindingOwner;
  let bindings = 0;
  const active = new Set();
  const events = [];
  const restores = [];
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const noRewrite = Promise.withResolvers();
  const restoreRelease = Promise.withResolvers();
  let session;
  let failedMessage;
  let recoveryResult;
  let recoveryCalls = 0;
  let discarded = 0;
  let restored = 0;
  let compactions = 0;
  let rewrites = 0;
  let ordinal = 0;
  const check = (ok, message) => {
    if (!ok) throw new Error(message);
  };
  const wait = async (promise, label) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Missing native boundary: ${label}`)), 20000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const decorate = (target, name, wrap) => {
    const original = target[name];
    check(typeof original === "function", `Missing public ${name}`);
    target[name] = wrap(original);
    restores.push(() => {
      target[name] = original;
    });
  };
  const failedEntries = () =>
    session.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "length");
  try {
    for (const [prototype, name] of [
      [SessionMaintenance.prototype, "isCompacting"],
      [TurnRecovery.prototype, "attempt"],
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      check(typeof descriptor?.get === "function", `Missing public getter ${name}`);
      Object.defineProperty(prototype, name, {
        ...descriptor,
        get() {
          if (bindingOwner) {
            check(!receivers.has(this) || receivers.get(this) === bindingOwner, "Conflicting native owner association");
            if (!receivers.has(this)) bindings++;
            receivers.set(this, bindingOwner);
          }
          return descriptor.get.call(this);
        },
      });
      restores.push(() => Object.defineProperty(prototype, name, descriptor));
    }
    decorate(
      SessionMaintenance.prototype,
      "checkCompaction",
      (original) =>
        async function (...args) {
          if (receivers.get(this) !== session || !session) return original.apply(this, args);
          const token = `check:${++ordinal}`;
          active.add(token);
          try {
            return await original.apply(this, args);
          } finally {
            active.delete(token);
          }
        },
    );
    decorate(
      TurnRecovery.prototype,
      "runRecoveryCompactionWithRollback",
      (original) =>
        async function (...args) {
          if (receivers.get(this) !== session || !session) return original.apply(this, args);
          recoveryCalls++;
          const token = `recovery:${++ordinal}`;
          active.add(token);
          failedMessage = args[1];
          check(args[0] === "incomplete" && failedMessage.stopReason === "length", "Not genuine incomplete recovery");
          events.push({ type: "recovery-before-persisted-removal", active: [...active] });
          entered.resolve();
          try {
            await release.promise;
            recoveryResult = await original.apply(this, args);
            events.push({ type: "original-recovery-returned", restored, active: [...active], result: recoveryResult });
            return recoveryResult;
          } finally {
            active.delete(token);
          }
        },
    );
    decorate(
      TurnRecovery.prototype,
      "discardAssistantTurn",
      (original) =>
        function (...args) {
          if (receivers.get(this) !== session || !session) return original.apply(this, args);
          check(
            [...active].some((id) => id.startsWith("recovery:")),
            "Discard escaped recovery ownership",
          );
          const result = original.apply(this, args);
          discarded++;
          events.push({ type: "native-discard", dropped: Boolean(result), failedEntries: failedEntries().length, active: [...active] });
          return result;
        },
    );
    decorate(
      SessionMaintenance.prototype,
      "runAutoCompaction",
      (original) =>
        async function (...args) {
          if (receivers.get(this) !== session || !session) return original.apply(this, args);
          const result = await original.apply(this, args);
          check(result.historyRewritten !== true && compactions === 0 && rewrites === 0, "Native compaction rewrote history");
          check(discarded === 1 && failedEntries().length === 0, "Failed native turn was not removed");
          events.push({ type: "native-no-rewrite-result-held", result, active: [...active] });
          noRewrite.resolve();
          await restoreRelease.promise;
          return result;
        },
    );
    {
      ({ session } = await api.pi.createAgentSession({
        cwd: config.root,
        agentDir: config.agentDir,
        model: ctx.model,
        modelRegistry: ctx.modelRegistry,
        authStorage: ctx.modelRegistry.authStorage,
        autoApprove: true,
        sessionManager: api.pi.SessionManager.create(config.root, config.sessionsDir),
        settings: api.pi.Settings.isolated({}),
      }));
      // Synchronous public getter handshake; no workflow ancestry or private host.
      bindingOwner = session;
      try {
        check(session.isCompacting === false && session.retryAttempt === 0, "Unexpected initial native state");
      } finally {
        bindingOwner = undefined;
      }
      check(bindings === 2, "Public getters did not associate both actual native instances");
      events.push({ type: "public-getter-owner-binding", bindings });
      decorate(
        session.sessionManager,
        "appendMessage",
        (original) =>
          function (...args) {
            if (args[0] === failedMessage) {
              check(
                [...active].some((id) => id.startsWith("recovery:")),
                "Original restoration escaped recovery lease",
              );
              restored++;
              events.push({ type: "native-restoration", active: [...active] });
            }
            return original.apply(this, args);
          },
      );
      for (const name of ["appendCompaction", "rewriteEntries"]) {
        decorate(
          session.sessionManager,
          name,
          (original) =>
            function (...args) {
              if (name === "appendCompaction") compactions++;
              else rewrites++;
              return original.apply(this, args);
            },
        );
      }
      const prompt = session.prompt("MAINTENANCE_RECOVERY: give a brief answer.");
      // Attach a rejection observer immediately; preserve the original prompt result.
      void prompt.catch(() => {});
      await wait(entered.promise, "public native recovery entry");
      await session.settleInFlightMessagePersistence();
      await session.sessionManager.flush();
      check(failedEntries().length === 1 && discarded === 0, "Hold did not precede persisted removal");
      check(!session.messages.includes(failedMessage), "Native active removal did not precede rollback wrapper");
      events.push({ type: "persisted-failed-turn-held-before-removal", active: [...active] });
      release.resolve();
      await wait(noRewrite.promise, "legitimate native unsuccessful compaction");
      check(restored === 0 && failedEntries().length === 0, "Restoration happened before result release");
      check(
        [...active].some((id) => id.startsWith("recovery:")),
        "Early settlement at auto-compaction return",
      );
      restoreRelease.resolve();
      await wait(prompt, "original prompt recovery completion");
      await session.waitForIdle();
      await session.sessionManager.flush();
      check(recoveryCalls === 1 && discarded === 1 && restored === 1, "Unexpected recovery/removal/restoration counts");
      check(failedEntries().length === 1 && session.messages.includes(failedMessage), "Failed turn not restored to branch and active context");
      check(active.size === 0 && compactions === 0 && rewrites === 0, "Unexpected pending work or compaction rewrite");
      const persisted = await Bun.file(session.sessionManager.getSessionFile()).text();
      check(persisted.includes("Native incomplete answer") && persisted.includes('"length"'), "Restored history not flushed to native journal");
      events.push({ type: "native-restoration-settled-and-flushed", active: [...active] });
    }
    return {
      status: "passed-bounded-recovery-subset",
      ownerBinding: "public-getter-receivers-without-caller-scope",
      bindings,
      recoveryCalls,
      discarded,
      restored,
      compactions,
      rewrites,
      events,
    };
  } catch (error) {
    return { status: "failed", error: String(error), recoveryCalls, discarded, restored, compactions, rewrites, events };
  } finally {
    release.resolve();
    restoreRelease.resolve();
    if (session) await session.dispose();
    for (const restore of restores.reverse()) restore();
  }
}

const base = fileURLToPath(new URL("./external_maintenance_ownership_smoke.mjs", import.meta.url));
let source = readFileSync(base, "utf8");
assert.equal(
  createHash("sha256").update(source).digest("hex"),
  "d691f6b15312dc940fde233140c86018f4fa105e2c6892dadb39b0cd918c7a9d",
  "Retained diagnostic changed; review before deriving",
);
const replace = (before, after) => {
  assert.equal(source.split(before).length, 2, `Nonunique/missing derivative anchor: ${before.slice(0, 70)}`);
  source = source.replace(before, after);
};
const start = source.indexOf("async function nativeWorkflow(");
const end = source.indexOf("\ntry {\n  await new Promise((resolve) => server.listen", start);
assert.ok(start >= 0 && end > start);
source = source.slice(0, start) + recoveryWorkflow.toString().replace("recoveryWorkflow", "nativeWorkflow") + source.slice(end);
replace(
  'const text = primary\n      ? Array.from({ length: 180 }, (_, index) => `${index}: ${createHash("sha256").update(`native-context-${index}`).digest("hex")}`).join("\\n")\n      : "Native speculative handoff document: preserve the fixture investigation.";',
  'const text = "Native incomplete answer";',
);
replace('finish_reason: "stop"', 'finish_reason: "length"');
replace('"passed-bounded-speculation-subset", JSON.stringify(result.workflow)', '"passed-bounded-recovery-subset", JSON.stringify(result.workflow)');
replace('scope: workflow ? "native-speculation-subset" : "module-access-only"', 'scope: "native-incomplete-recovery-no-rewrite"');
const temporary = mkdtempSync(path.join(tmpdir(), "maintenance-lifecycle-derivative-"));
try {
  const script = path.join(temporary, "probe.mjs");
  writeFileSync(script, source);
  console.log(JSON.stringify({ derivativeSha256: createHash("sha256").update(source).digest("hex") }));
  const child = spawn(process.execPath, [script, "--workflow"], { env: process.env, stdio: "inherit" });
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  process.exitCode = exit ?? 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
