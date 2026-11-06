// The playbook conformance cases (plan S4.6): the Rust reference (alinery-core/tests/conformance.rs `playbook`) wrote `expected.json`
// for each case under `conformance/playbook/<case>/`, and the daemon's library and the engine's one parser must give the same answers
// and leave the same bytes behind. `command.json` holds the steps; `input/app` is the global config dir and `input/repo` the repository.
import { fromJson } from "@bufbuild/protobuf";
import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { PlaybookDefinitionSchema, PlaybookStepSchema, SavePlaybookRequestSchema } from "alinery-proto/alinery/v1/playbooks_pb";
import { type DocDiagnostic, type PlaybookDocument, parsePlaybookDocument, renderPlaybookMd } from "playbook-engine/src/playbook-md.ts";
import { BUNDLED_PLAYBOOKS } from "./bundledPlaybooks.ts";
import { decodePickerPreferences, deletePlaybook, loadCatalog, loadPicker, LoadFailure, resolvePlaybook, savePicker, savePlaybook, SaveFailure, type Roots } from "./playbookLibrary.ts";

const ROOT = resolve(import.meta.dir, "../../../conformance/playbook");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Step = Record<string, any>;
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

/** `playbook_source`: the step's `source`, else a fixture with the `replace` pairs applied once, the `replace_all` pairs everywhere, then `append`. */
function sourceOf(command: Step, step: Step): string {
  if (typeof step.source === "string") return step.source;
  let text: string = command[step.base ?? "fixture"];
  for (const [from, to] of step.replace ?? []) text = text.replace(from, () => to);
  for (const [from, to] of step.replace_all ?? []) text = text.replaceAll(from, () => to);
  return text + (step.append ?? "");
}

/** The serde form of a definition: `required` is left out when false (`skip_serializing_if = "Not::not"`). */
function serde(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(serde);
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([k, v]) => !(k === "required" && v === false));
    return Object.fromEntries(entries.map(([k, v]) => [k, serde(v)]));
  }
  return value;
}

/** The words of a TOML syntax error are the TOML parser's own (the `toml` crate's there, smol-toml's here); its code and line are compared, its text is not. */
function parserText(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(parserText);
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, k === "message" && row.code === "invalid_toml" ? "<TOML parser text>" : parserText(v)]));
  }
  return value;
}

const sorted = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, sorted(v)]));
  return value;
};
/** `playbook_errors`: diagnostics in a fixed order, by their JSON text. */
const errors = (list: DocDiagnostic[]) => list.map((d) => JSON.stringify(sorted(d))).sort().map((t) => JSON.parse(t));

function parse(source: string) {
  const parsed = parsePlaybookDocument(source);
  return parsed.document ? { ok: serde(parsed.document) } : { errors: errors(parsed.diagnostics) };
}

const equalDocs = (a: PlaybookDocument, b: PlaybookDocument) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

function scrubber(scratch: string) {
  const dirs = [realpathSync(scratch), scratch];
  const str = (text: string) => {
    let out = text;
    for (const dir of dirs) out = out.replaceAll(dir, "<REPO>");
    return out.replace(/(?<![A-Za-z0-9_])c\d{13}(?:_\d+)?(?![A-Za-z0-9_])/g, "cID");
  };
  const scrub = (value: unknown): unknown => {
    if (typeof value === "string") return str(value);
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === "modified_at_ms" && v !== null ? "MTIME" : scrub(v)]));
    return value;
  };
  return scrub;
}

/** The JSON a Rust type refused: its message has to name the offending field. The daemon's equivalents are the wire messages. */
const WIRE: Record<string, (value: unknown) => unknown> = {
  NormalizedPlaybook: (v) => fromJson(PlaybookDefinitionSchema, v as never),
  NormalizedStep: (v) => fromJson(PlaybookStepSchema, v as never),
  SavePlaybookRequest: (v) => fromJson(SavePlaybookRequestSchema, v as never),
};

async function attempt<T>(f: () => Promise<T> | T): Promise<{ ok: unknown } | { error: unknown }> {
  try {
    const value = await f();
    return { ok: value === undefined ? {} : serde(value) };
  } catch (e) {
    if (e instanceof LoadFailure || e instanceof SaveFailure) return { error: e.error };
    throw e;
  }
}

function collect(dir: string, root: string, files: Record<string, string>) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(dir, entry.name);
    if (entry.name === ".mutation.lock") continue;
    if (lstatSync(path).isSymbolicLink()) files[relative(root, path)] = "<symlink>";
    else if (entry.isDirectory()) collect(path, root, files);
    else files[relative(root, path)] = new TextDecoder().decode(readFileSync(path));
  }
}

for (const name of readdirSync(ROOT)) {
  test(`playbook/${name} equals the Rust library's answers and files`, async () => {
    const scratch = mkdtempSync(join(tmpdir(), `conf-playbook-${name}-`));
    dirs.push(scratch);
    if (existsSync(join(ROOT, name, "input"))) cpSync(join(ROOT, name, "input"), scratch, { recursive: true });
    const command = read(join(ROOT, name, "command.json"));
    const expected = read(join(ROOT, name, "expected.json"));
    mkdirSync(join(scratch, "app"), { recursive: true });
    mkdirSync(join(scratch, "repo"), { recursive: true });
    const roots: Roots = { globalConfigDir: join(scratch, "app"), repoDir: command.no_repo === true ? "" : join(scratch, "repo") };
    const scrub = scrubber(scratch);

    const bundledSource = (step: Step): string => {
      const spec = step.bundled;
      const found = BUNDLED_PLAYBOOKS.find(([key]) => key === spec.key);
      const doc = parsePlaybookDocument(found![1]).document!;
      if (spec.title) doc.title = spec.title;
      if (spec.set_key) doc.key = spec.set_key;
      return renderPlaybookMd(doc);
    };

    const answers: unknown[] = [];
    const skipped: number[] = [];
    for (const [index, step] of (command.steps as Step[]).entries()) {
      let answer: unknown;
      switch (step.op) {
        case "parse":
          answer = parse(sourceOf(command, step));
          break;
        case "roundtrip": {
          const parsed = parsePlaybookDocument(sourceOf(command, step));
          if (!parsed.document) {
            answer = { errors: errors(parsed.diagnostics) };
            break;
          }
          const rendered = renderPlaybookMd(parsed.document);
          const again = parsePlaybookDocument(rendered);
          answer = {
            rendered,
            reparsed_equal: again.document !== null && equalDocs(again.document, parsed.document),
            rerendered_equal: again.document !== null && renderPlaybookMd(again.document) === rendered,
          };
          break;
        }
        case "remove_lines_sweep": {
          const source = sourceOf(command, step);
          const lines = source.split(/(?<=\n)/);
          const codes: unknown[] = [];
          for (const [removed, line] of lines.entries()) {
            if (!line.includes(" = ")) continue;
            const parsed = parsePlaybookDocument(lines.filter((_, i) => i !== removed).join(""));
            codes.push(parsed.document ? "ok" : [...new Set(parsed.diagnostics.map((d) => d.code))].sort());
          }
          answer = { codes };
          break;
        }
        case "strict_json": {
          const wire = WIRE[step.type];
          if (!wire) {
            // `PlaybookRoots` exists only in Rust: the daemon builds its roots from its own paths and never reads them from a request.
            skipped.push(index);
            continue;
          }
          let message: string | undefined;
          try {
            wire(step.value);
          } catch (e) {
            message = (e as Error).message;
          }
          if (message !== undefined) expect(message).toContain(step.field);
          answer = { rejected: message !== undefined };
          break;
        }
        case "catalog":
          answer = loadCatalog(roots);
          break;
        case "resolve":
          answer = await attempt(() => resolvePlaybook(roots, step.reference));
          break;
        case "save":
          answer = await attempt(() => savePlaybook(roots, step.target, step.bundled ? bundledSource(step) : sourceOf(command, step), step.overwrite === true));
          break;
        case "delete":
          answer = await attempt(() => deletePlaybook(roots, step.reference));
          break;
        case "load_picker":
          try {
            answer = { ok: loadPicker(roots) };
          } catch {
            answer = { error: true };
          }
          break;
        case "save_picker": {
          let preferences: ReturnType<typeof decodePickerPreferences>;
          try {
            preferences = decodePickerPreferences(step.preferences);
          } catch {
            answer = { error: true };
            break;
          }
          answer = await attempt(() => savePicker(roots, preferences));
          break;
        }
        case "read_file": {
          const path = join(scratch, step.path);
          answer = { text: existsSync(path) ? readFileSync(path, "utf8") : null };
          break;
        }
        case "write_file": {
          const path = join(scratch, step.path);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, step.text);
          answer = {};
          break;
        }
        case "symlink": {
          const path = join(scratch, step.path);
          mkdirSync(dirname(path), { recursive: true });
          symlinkSync(join(scratch, step.target), path);
          answer = {};
          break;
        }
        default:
          throw new Error(`unknown playbook op ${step.op}`);
      }
      answers.push(scrub(serde(answer)));
    }
    const files: Record<string, string> = {};
    collect(scratch, scratch, files);
    const want = { ...expected, steps: (expected.steps as unknown[]).filter((_, i) => !skipped.includes(i)) };
    expect(parserText({ steps: answers, files })).toEqual(parserText(want));
  });
}
