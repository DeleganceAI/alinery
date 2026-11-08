// O3 / S2.3 measurement: what a full index scan and a 30 s reconcile pass cost on the event loop.
// Usage: bun src/scan-bench.ts <real .alinery dir> <scratch dir> [copies...]
// Copies the real tasks N times (large .omp/.scrollback/.log files become empty placeholders, so
// readdir still sees them) and times:
//   scan:      read + parse every task.md (Bun.TOML), execution.json and *.meta.json; stat artifacts
//   reconcile: readdir every task dir and stat every tracked file (what 2.2.8 runs every 30 s)
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const SKIP = /\.(omp|scrollback|log)$/;

export function build(realAlinery: string, scratch: string, n: number): string {
  const root = join(scratch, `x${n}`, ".alinery", "tasks");
  rmSync(join(scratch, `x${n}`), { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  for (const slug of readdirSync(join(realAlinery, "tasks"))) {
    const src = join(realAlinery, "tasks", slug);
    for (let i = 0; i < n; i++) {
      const dst = join(root, n === 1 ? slug : `${slug}-${i}`);
      cpSync(src, dst, { recursive: true, filter: (p) => !SKIP.test(p) });
      for (const f of readdirSync(join(src, "sessions"), { withFileTypes: true }))
        if (SKIP.test(f.name)) writeFileSync(join(dst, "sessions", f.name), "");
    }
  }
  return root;
}

type Tracked = { path: string; mtimeMs: number; size: number };
export function scan(root: string) {
  const index = new Map<string, unknown>();
  const tracked: Tracked[] = [];
  const track = (path: string) => { const s = statSync(path); tracked.push({ path, mtimeMs: s.mtimeMs, size: s.size }); };
  for (const slug of readdirSync(root)) {
    const dir = join(root, slug);
    const taskMd = join(dir, "task.md");
    index.set(`task/${slug}`, Bun.TOML.parse(readFileSync(taskMd, "utf8")));
    track(taskMd);
    try { index.set(`execution/${slug}`, JSON.parse(readFileSync(join(dir, "execution.json"), "utf8"))); track(join(dir, "execution.json")); } catch {}
    for (const f of readdirSync(join(dir, "sessions")))
      if (f.endsWith(".meta.json")) { const p = join(dir, "sessions", f); index.set(`session/${slug}/${f}`, JSON.parse(readFileSync(p, "utf8"))); track(p); }
    try { for (const f of readdirSync(join(dir, "artifacts"), { withFileTypes: true })) if (f.isFile()) track(join(dir, "artifacts", f.name)); } catch {}
  }
  return { index, tracked };
}

function reconcileSync(root: string, tracked: Tracked[]) {
  let changed = 0;
  for (const slug of readdirSync(root)) { readdirSync(join(root, slug, "sessions")); try { readdirSync(join(root, slug, "artifacts")); } catch {} }
  for (const t of tracked) { const s = statSync(t.path); if (s.mtimeMs !== t.mtimeMs || s.size !== t.size) changed++; }
  return changed;
}

async function reconcileAsync(root: string, tracked: Tracked[]) {
  let maxGap = 0, last = performance.now();
  const tick = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 1);
  const slugs = await readdir(root);
  await Promise.all(slugs.map((s) => Promise.all([readdir(join(root, s, "sessions")), readdir(join(root, s, "artifacts")).catch(() => [])])));
  let changed = 0;
  for (let i = 0; i < tracked.length; i += 256)
    await Promise.all(tracked.slice(i, i + 256).map(async (t) => { const s = await stat(t.path); if (s.mtimeMs !== t.mtimeMs || s.size !== t.size) changed++; }));
  clearInterval(tick);
  return { changed, maxGap };
}

export const time = <T>(f: () => T): [T, number] => { const t0 = performance.now(); const r = f(); return [r, performance.now() - t0]; };
if (import.meta.main) {
const [realAlinery, scratch, ...copyArgs] = process.argv.slice(2);
const copies = copyArgs.length ? copyArgs.map(Number) : [1, 5, 25, 100];
for (const n of copies) {
  const root = build(realAlinery, scratch, n);
  Bun.gc(true);
  const rss0 = process.memoryUsage().rss;
  const [{ index, tracked }, scanMs] = time(() => scan(root));
  Bun.gc(true);
  const rssMb = (process.memoryUsage().rss - rss0) / 1e6;
  reconcileSync(root, tracked); // warm
  const recMs = Array.from({ length: 5 }, () => time(() => reconcileSync(root, tracked))[1]).sort((a, b) => a - b)[2];
  const t0 = performance.now();
  const { maxGap } = await reconcileAsync(root, tracked);
  const asyncMs = performance.now() - t0;
  console.log(JSON.stringify({ tasks: readdirSync(root).length, keys: index.size, trackedFiles: tracked.length,
    scanMs: +scanMs.toFixed(1), indexRssMb: +rssMb.toFixed(1), reconcileSyncMs: +recMs.toFixed(1),
    reconcileAsyncMs: +asyncMs.toFixed(1), reconcileAsyncMaxLoopGapMs: +maxGap.toFixed(1) }));
}
rmSync(scratch, { recursive: true, force: true });
}
