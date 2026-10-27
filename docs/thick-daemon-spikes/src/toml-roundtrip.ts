// S4.1/S4.3 check: do smol-toml and Bun.TOML write task.md and config.toml the way Rust's
// `toml::to_string` does? Parses each file, stringifies it, and reports byte-identical vs
// semantically equal, per writer.
// Usage: bun src/toml-roundtrip.ts <file.toml|task.md>...
import { readFileSync } from "node:fs";
import * as smol from "smol-toml";
import { deepStrictEqual } from "node:assert";

const files = process.argv.slice(2).map((p) => [p, readFileSync(p, "utf8")] as const);
for (const [name, toml] of [["smol-toml 1.9.1", smol], [`Bun.TOML ${Bun.version}`, Bun.TOML]] as const) {
  let same = 0, semanticOnly = 0, broken = 0;
  let firstDiff = "";
  for (const [path, src] of files) {
    let out: string;
    try { out = toml.stringify(smol.parse(src) as never); } catch (e) { broken++; firstDiff ||= `${path}: throws ${e}`; continue; }
    if (out === src) { same++; continue; }
    try { deepStrictEqual(smol.parse(out), smol.parse(src)); semanticOnly++; } catch { broken++; }
    if (!firstDiff) {
      const a = src.split("\n"), b = out.split("\n");
      const i = a.findIndex((l, n) => l !== b[n]);
      firstDiff = `${path}:${i + 1}\n  rust: ${JSON.stringify(a[i])}\n  ts:   ${JSON.stringify(b[i])}`;
    }
  }
  console.log(name, { files: files.length, same, semanticOnly, broken });
  if (firstDiff) console.log(firstDiff);
}
