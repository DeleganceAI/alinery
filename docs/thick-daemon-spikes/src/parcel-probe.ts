// Run from a dir with node_modules/@parcel/watcher. Probes the two Linux misses seen in the matrix.
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const parcel = require("@parcel/watcher");
const tag = (p: string, root: string) => p.slice(root.length + 1);
async function trial(name: string, setup: (r: string) => void, act: (r: string) => void, later?: (r: string) => void) {
  const r = mkdtempSync("/tmp/pp-");
  setup(r);
  const ev: string[] = [];
  const bun: string[] = [];
  const sub = await parcel.subscribe(r, (_e: unknown, es: { type: string; path: string }[]) => es.forEach((e) => ev.push(`${e.type} ${tag(e.path, r)}`)));
  const w = require("node:fs").watch(r, { recursive: true }, (t: string, n: string) => bun.push(`${t} ${n}`));
  await Bun.sleep(300);
  act(r);
  await Bun.sleep(700);
  later?.(r);
  await Bun.sleep(1500);
  await sub.unsubscribe();
  w.close();
  console.log(`${name}\n  parcel: ${ev.join(", ") || "(none)"}\n  bun:    ${[...new Set(bun)].join(", ") || "(none)"}`);
}
// 1. pre-existing file: append, atomic replace, delete, back to back (the burst workload for 500 paths)
await trial("pre-existing f: append, replace, delete", (r) => writeFileSync(join(r, "f"), "x"), (r) => {
  appendFileSync(join(r, "f"), "y"); writeFileSync(join(r, "f.tmp"), "z"); renameSync(join(r, "f.tmp"), join(r, "f")); unlinkSync(join(r, "f"));
});
await trial("pre-existing f: delete only", (r) => writeFileSync(join(r, "f"), "x"), (r) => unlinkSync(join(r, "f")));
await trial("pre-existing f: replace, delete", (r) => writeFileSync(join(r, "f"), "x"), (r) => {
  writeFileSync(join(r, "f.tmp"), "z"); renameSync(join(r, "f.tmp"), join(r, "f")); unlinkSync(join(r, "f"));
});
// 2. new dir, subdir and file in quick succession (the paced new-task case)
for (let i = 0; i < 5; i++)
  await trial(`new d/sub/f #${i}`, () => {}, (r) => { mkdirSync(join(r, "d")); mkdirSync(join(r, "d", "sub")); writeFileSync(join(r, "d", "sub", "f"), "x"); }, (r) => writeFileSync(join(r, "d", "sub", "g"), "later"));
