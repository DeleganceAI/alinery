import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Engine, type EngineOptions } from '../src/engine.ts';
import type { Playbook, Step } from '../src/playbook.ts';
import type { Harness } from '../src/harness.ts';

/** A fresh task directory with the layout the engine expects. */
export function taskDir(): { root: string; artifactsDir: string; logPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'playbook-engine-'));
  const artifactsDir = join(root, 'artifacts');
  mkdirSync(artifactsDir);
  return { root, artifactsDir, logPath: join(root, 'execution.jsonl') };
}

export function openEngine(playbook: Playbook, harness: Harness, dir = taskDir(), extra: Partial<EngineOptions> = {}): Engine {
  return Engine.open({ playbook, harness, cwd: dir.root, artifactsDir: dir.artifactsDir, logPath: dir.logPath, ...extra });
}

/**
 * Tick until nothing is reserved, live or finishing for two ticks in a row.
 * Exit confirmation lands after a tick's scheduling pass, so a single quiet
 * tick can precede the reservation of a successor.
 */
export async function settle(engine: Engine, maxTicks = 200): Promise<void> {
  let quiet = 0;
  for (let i = 0; i < maxTicks; i++) {
    await engine.tick();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const busy = [...engine.state.executions.values()].some((e) => e.status === 'reserved' || e.status === 'live' || e.status === 'finishing');
    quiet = busy ? 0 : quiet + 1;
    if (quiet === 2) return;
  }
  throw new Error('did not settle');
}

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export function writeJson(path: string, value: unknown): void {
  writeText(path, JSON.stringify(value, null, 2));
}

/** Minimal step with sensible defaults. */
export function step(key: string, s: Partial<Step> = {}): Step {
  return { key, title: key, short: key, inputs: [], outputs: [], model: '', harness: '', isCodingStep: false, autoAdvanceDefault: true, prompt: `Do ${key}.`, ...s };
}

export function playbook(steps: Step[]): Playbook {
  return { key: 'test', title: 'Test', description: '', defaultModel: 'm', defaultHarness: 'fake', steps };
}

export function byStep(engine: Engine, key: string) {
  return [...engine.state.executions.values()].filter((e) => e.step === key);
}
