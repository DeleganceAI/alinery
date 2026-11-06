// The host's agent directory (plan S4.10, O12 a): model roles, the customization inventory, skill install and delete, and the
// prompt that helps a person customize it. Ported from the app's `omp_update.rs` and `vinculum_customizations.rs`. The directory is
// `vinculumAgentDir(appConfig)`, so each host has its own and its daemon owns it. Nothing in it is executed: the inventory reads names
// and metadata only, and no command line, env value, header or frontmatter body is copied into a result.
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join, normalize, sep } from "node:path";
import { DomainError } from "../platform/lock.ts";
import { writeAtomic } from "../platform/fs.ts";
import { unzipInto, unzipNames, unzipSizes, unzipText, unzipTypes } from "../platform/zip.ts";
import { appConfigDirOf } from "./playbookLibrary.ts";

const MAX_METADATA_BYTES = 1024 * 1024;
const ZIP_CAP = 25 * 1024 * 1024;
const FILE_CAP = 8 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 200;

const refuse = (message: string): never => {
  throw new DomainError("invalid_argument", message);
};

// ---- model roles ---------------------------------------------------------------------------------------------------------

function configYml(agentDir: string): string {
  const isFile = (p: string) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const yml = join(agentDir, "config.yml");
  if (isFile(yml)) return yml;
  const yaml = join(agentDir, "config.yaml");
  return isFile(yaml) ? yaml : yml;
}

const trimEnd = (s: string) => s.replace(/\s+$/, "");
const indentOf = (line: string) => line.length - line.trimStart().length;

/** Best-effort parse of a top-level `modelRoles:` map from the agent's YAML (a line parser, as the Rust one was). */
export function parseModelRoles(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inBlock = false;
  for (const line of text.split("\n")) {
    const trimmed = trimEnd(line);
    if (!inBlock) {
      const t = trimmed.trimStart();
      if (t.startsWith("modelRoles:")) {
        const rest = t.slice("modelRoles:".length).trim();
        if (rest === "") {
          inBlock = true;
          continue;
        }
        if (rest === "{}" || rest === "null" || rest === "~") return out;
      }
      continue;
    }
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (indentOf(line) === 0) break;
    const body = trimmed.trimStart();
    if (body.startsWith("-")) continue;
    const colon = body.indexOf(":");
    if (colon < 0) continue;
    const key = body.slice(0, colon).trim();
    let value = body.slice(colon + 1).trim();
    if (value === "") continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (key !== "") out[key] = value;
  }
  return out;
}

function stripModelRoles(text: string): string {
  let out = "";
  let skipping = false;
  for (const line of text.split("\n")) {
    const trimmed = trimEnd(line);
    if (!skipping) {
      const t = trimmed.trimStart();
      if (t.startsWith("modelRoles:")) {
        if (t.slice("modelRoles:".length).trim() === "") skipping = true; // the block form; the inline form drops only its line
        continue;
      }
      out += `${line}\n`;
      continue;
    }
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (indentOf(line) === 0) {
      skipping = false;
      out += `${line}\n`;
    }
  }
  return out;
}

/** The YAML with its `modelRoles` block replaced by `roles` (sorted by key) and every other line kept. */
export function renderModelRoles(existing: string, roles: Record<string, string>): string {
  // `lines()` of a text with or without its last newline is the same list; the split of one would add an empty last line.
  let base = existing === "" ? "" : stripModelRoles(existing.endsWith("\n") ? existing.slice(0, -1) : existing);
  while (base.endsWith("\n\n")) base = base.slice(0, -1);
  if (base !== "" && !base.endsWith("\n")) base += "\n";
  const keys = Object.keys(roles).sort();
  if (keys.length === 0) return base;
  if (base !== "" && !base.endsWith("\n\n")) base += "\n";
  base += "modelRoles:\n";
  for (const key of keys) base += `  ${key}: ${roles[key]}\n`;
  return base;
}

export function readModelRoles(agentDir: string): Record<string, string> {
  const path = configYml(agentDir);
  try {
    return parseModelRoles(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export function writeModelRoles(agentDir: string, roles: Record<string, string>): void {
  mkdirSync(agentDir, { recursive: true });
  const path = configYml(agentDir);
  let existing = "";
  try {
    existing = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new DomainError("internal", `read ${path}: ${(e as Error).message}`);
  }
  writeAtomic(path, renderModelRoles(existing, roles));
}

// ---- the inventory -------------------------------------------------------------------------------------------------------

export type Customization = { name: string; kind: string; source: string; path: string | null; offered?: boolean };
export type Customizations = { items: Customization[]; errors: string[] };

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

const fileError = (inv: Customizations, path: string, reason: string) => inv.errors.push(`${path}: ${reason}`);
const item = (inv: Customizations, name: string, kind: string, source: string, path: string | null, offered?: boolean) =>
  inv.items.push(offered === undefined ? { name, kind, source, path } : { name, kind, source, path, offered });
const displayName = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

/** The file's text, `null` when it does not exist, or the reason it cannot be used. */
function metadataText(path: string): { text: string | null } | { reason: string } {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? { text: null } : { reason: "could not read metadata" };
  }
  if (!st.isFile() || st.size > MAX_METADATA_BYTES) return { reason: "metadata must be a regular file smaller than 1 MiB" };
  try {
    return { text: readFileSync(path, "utf8") };
  } catch {
    return { reason: "could not read metadata" };
  }
}

function metadataJson(path: string, inv: Customizations): Json | undefined {
  const read = metadataText(path);
  if ("reason" in read) {
    fileError(inv, path, read.reason);
    return undefined;
  }
  if (read.text === null) return undefined;
  try {
    const value: unknown = JSON.parse(read.text);
    if (isObject(value)) return value;
  } catch {}
  fileError(inv, path, "malformed JSON metadata (expected an object)");
  return undefined;
}

/** Visible entries of a directory (links followed), sorted by path; a directory that is not there is empty. */
function directoryEntries(path: string, inv: Customizations): [string, ReturnType<typeof statSync>][] {
  let names: string[];
  try {
    names = readdirSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") fileError(inv, path, "could not list directory");
    return [];
  }
  const out: [string, ReturnType<typeof statSync>][] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const full = join(path, name);
    try {
      out.push([full, statSync(full)]);
    } catch {
      fileError(inv, full, "could not inspect installed item (unreadable or broken link)");
    }
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

type SkillDoc = { name?: string; description?: string; modelInvocation: boolean };

/** `undefined`: no frontmatter. A string: why the frontmatter is unusable. */
function parseSkillText(text: string): SkillDoc | undefined | string {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  if ((lines[0] ?? "").trim() !== "---") return undefined;
  let closed = false;
  const yaml: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") {
      closed = true;
      break;
    }
    yaml.push(line);
  }
  if (!closed) return "unterminated skill frontmatter";
  let metadata: unknown;
  try {
    metadata = Bun.YAML.parse(`${yaml.join("\n")}\n`);
  } catch {
    return "malformed YAML skill frontmatter";
  }
  if (metadata !== null && metadata !== undefined && !isObject(metadata)) return "skill frontmatter must be a mapping";
  const m = (metadata ?? {}) as Json;
  const flag = m["disable-model-invocation"];
  const disabled = flag === true || flag === "true";
  return { name: displayName(m.name), description: displayName(m.description), modelInvocation: !disabled };
}

function scanSkills(agentDir: string, inv: Customizations): void {
  for (const [directory, st] of directoryEntries(join(agentDir, "skills"), inv)) {
    if (!st.isDirectory()) continue;
    const path = join(directory, "SKILL.md");
    const read = metadataText(path);
    let name: string | undefined;
    let offered = false;
    if ("reason" in read) fileError(inv, path, read.reason);
    else if (read.text === null) continue;
    else {
      const doc = parseSkillText(read.text);
      if (typeof doc === "string") fileError(inv, path, doc);
      else if (doc) {
        name = doc.name;
        offered = doc.name !== undefined && doc.description !== undefined && doc.modelInvocation;
      }
    }
    item(inv, name ?? basename(directory), "Skill", path, path, offered);
  }
}

const isFileAt = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

function scanExtensions(agentDir: string, inv: Customizations): void {
  for (const [path, st] of directoryEntries(join(agentDir, "extensions"), inv)) {
    if (st.isFile() && /\.(ts|js)$/.test(path)) {
      item(inv, basename(path), "Extension", path, path);
    } else if (st.isDirectory()) {
      const packagePath = join(path, "package.json");
      const before = inv.errors.length;
      const pkg = metadataJson(packagePath, inv);
      const gemini = metadataJson(join(path, "gemini-extension.json"), inv);
      const manifest = pkg ? (pkg.omp ?? pkg.pi) : undefined;
      const declared = isObject(manifest) ? manifest.extensions : undefined;
      let hasDeclared = false;
      if (Array.isArray(declared)) {
        if (declared.some((e) => typeof e !== "string")) fileError(inv, packagePath, "extension paths must be strings");
        hasDeclared = declared.some((e) => typeof e === "string");
      } else if (declared !== undefined) {
        fileError(inv, packagePath, "extension paths must be an array");
      }
      if (hasDeclared || isFileAt(join(path, "index.ts")) || isFileAt(join(path, "index.js")) || gemini !== undefined || inv.errors.length > before) {
        const name = displayName(pkg?.name) ?? displayName(gemini?.name) ?? basename(path);
        item(inv, name, "Extension", path, path);
      }
    }
  }
}

function scanMcp(agentDir: string, inv: Customizations): void {
  for (const file of ["mcp.json", ".mcp.json"]) {
    const path = join(agentDir, file);
    const config = metadataJson(path, inv);
    if (!config || config.mcpServers === undefined) continue;
    if (!isObject(config.mcpServers)) {
      fileError(inv, path, "mcpServers must be an object");
      continue;
    }
    for (const [name, definition] of Object.entries(config.mcpServers)) {
      if (!isObject(definition)) fileError(inv, path, "an MCP server definition must be an object");
      item(inv, name, "MCP server", path, path);
    }
  }
}

const cmp = (a: string | null | undefined, b: string | null | undefined) => ((a ?? "") < (b ?? "") ? -1 : (a ?? "") > (b ?? "") ? 1 : 0);

export function customizationsFromDir(agentDir: string): Customizations {
  const inv: Customizations = { items: [], errors: [] };
  scanSkills(agentDir, inv);
  scanExtensions(agentDir, inv);
  scanMcp(agentDir, inv);
  inv.items.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.name, b.name) || cmp(a.source, b.source) || cmp(a.path, b.path));
  inv.errors = [...new Set(inv.errors)].sort();
  return inv;
}

// ---- skills --------------------------------------------------------------------------------------------------------------

function skillNameRule(name: string): void {
  if (name === "" || name.length > 64 || name.startsWith("-") || name.endsWith("-") || name.includes("--") || !/^[a-z0-9-]+$/.test(name)) {
    refuse("A skill name must be lowercase letters, numbers, and hyphens, at most 64 characters, with no leading, trailing, or doubled hyphen.");
  }
}

function requireUploadSkill(text: string): { name: string } {
  const doc = parseSkillText(text);
  if (typeof doc === "string") return refuse(`A skill file must start with YAML frontmatter (${doc}).`);
  if (!doc) return refuse("A skill file must start with YAML frontmatter.");
  if (!doc.name) return refuse("A skill needs a name.");
  skillNameRule(doc.name);
  if (!doc.description) return refuse("A skill needs a description.");
  if ([...doc.description].length > 1024) refuse("A skill description must be at most 1024 characters.");
  return { name: doc.name };
}

const skillDirName = (name: string) => name !== "" && !name.startsWith(".") && !/[/\\\0]/.test(name) && name !== ".." && name !== ".";

function removeSkillDir(skills: string, name: string): void {
  if (!skillDirName(name)) refuse("That skill directory is not inside skills/.");
  const path = join(skills, name);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    return refuse("That skill is not installed.");
  }
  try {
    if (st.isSymbolicLink()) return unlinkSync(path);
    if (!st.isDirectory()) return refuse("That skill is not installed.");
    if (!`${realpathSync(path)}${sep}`.startsWith(`${realpathSync(skills)}${sep}`)) return refuse("That skill directory is not inside skills/.");
    rmSync(path, { recursive: true });
  } catch (e) {
    if (e instanceof DomainError) throw e;
    refuse("Could not remove that skill.");
  }
}

export function deleteSkill(agentDir: string, name: string): void {
  removeSkillDir(join(agentDir, "skills"), name);
}

type Install = { name: string; exists: boolean };

function placeSkill(agentDir: string, name: string, staging: string, replace: boolean): Install {
  const skills = join(agentDir, "skills");
  mkdirSync(skills, { recursive: true });
  const dest = join(skills, name);
  let there = true;
  try {
    lstatSync(dest);
  } catch {
    there = false;
  }
  if (there) {
    if (!replace) {
      rmSync(staging, { recursive: true, force: true });
      return { name, exists: true };
    }
    removeSkillDir(skills, name);
  }
  try {
    renameSync(staging, dest);
  } catch {
    refuse("Could not install that skill.");
  }
  return { name, exists: false };
}

const stagingFor = (agentDir: string, name: string) => join(agentDir, "skills", `.staging-${name}`);

function installMarkdown(agentDir: string, bytes: Uint8Array, replace: boolean): Install {
  if (bytes.length > FILE_CAP) refuse("A skill file must be smaller than 8 MiB.");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return refuse("Could not read that skill file.");
  }
  const { name } = requireUploadSkill(text);
  const staging = stagingFor(agentDir, name);
  rmSync(staging, { recursive: true, force: true });
  try {
    mkdirSync(staging, { recursive: true });
    writeAtomic(join(staging, "SKILL.md"), text);
    return placeSkill(agentDir, name, staging, replace);
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    if (e instanceof DomainError) throw e;
    return refuse("Could not install that skill.");
  }
}

function zipNameOk(name: string): void {
  if (name === "" || name.length > 255) refuse("Could not install that skill: a zip entry name is empty or too long.");
  if (name.startsWith("/") || name.startsWith("\\") || /^.:/.test(name)) refuse("Could not install that skill: a zip entry is absolute.");
  for (const part of name.split("/")) if (part === ".." || part.includes("\0")) refuse("Could not install that skill: a zip entry escapes the skill directory.");
}

const allowedSkillRel = (rel: string): boolean => {
  const r = rel.replace(/\/+$/, "");
  if (r === "SKILL.md") return true;
  return ["scripts/", "references/", "assets/"].some((prefix) => r.startsWith(prefix) && r.length > prefix.length);
};

function skillPrefix(names: string[]): string {
  const files = names.map((n) => n.replace(/\/+$/, "")).filter((n) => n !== "");
  const notOne = () => refuse("This zip is not one skill.");
  if (files.includes("SKILL.md")) {
    if (files.some((n) => !allowedSkillRel(n))) notOne();
    return "";
  }
  let root: string | undefined;
  for (const name of files) {
    const slash = name.indexOf("/");
    if (slash < 0) notOne();
    const first = name.slice(0, slash);
    const rest = name.slice(slash + 1);
    if (rest === "") continue;
    if (root === undefined) root = first;
    else if (root !== first) notOne();
    if (!allowedSkillRel(rest)) notOne();
  }
  return root === undefined ? (notOne() as never) : `${root}/`;
}

async function installZip(agentDir: string, archive: string, size: number, replace: boolean): Promise<Install> {
  if (size > ZIP_CAP) refuse("This zip is larger than 25 MiB.");
  const unreadable = () => refuse("Could not read that zip.");
  const [entryNames, types, sizes] = await Promise.all([unzipNames(archive), unzipTypes(archive), unzipSizes(archive)]).catch(unreadable) as [string[], string[], number[]];
  if (entryNames.length > MAX_ZIP_ENTRIES) refuse("This zip has more than 200 files.");
  if (types.length !== entryNames.length || sizes.length !== entryNames.length) unreadable();
  const names: string[] = [];
  let uncompressed = 0;
  entryNames.forEach((name, i) => {
    zipNameOk(name);
    if (types[i] === "l") refuse("A zip entry is a symlink or a hard link.");
    uncompressed += sizes[i] as number;
    if ((sizes[i] as number) > FILE_CAP) refuse("A file in this zip is larger than 8 MiB.");
    if (uncompressed > ZIP_CAP) refuse("This zip unpacks to more than 25 MiB.");
    if (types[i] !== "d" && !name.endsWith("/")) names.push(name);
  });
  const prefix = skillPrefix(names);
  const skillEntry = names.find((n) => n.replace(/\/+$/, "") === `${prefix}SKILL.md`);
  if (!skillEntry) refuse("This zip is not one skill.");
  const skillText = await unzipText(archive, skillEntry as string).catch(() => refuse("Could not read that skill."));
  if (Buffer.byteLength(skillText) > FILE_CAP) refuse("A file in this zip is larger than 8 MiB.");
  const { name } = requireUploadSkill(skillText);
  const staging = stagingFor(agentDir, name);
  const unpacked = `${staging}.unpack`;
  rmSync(staging, { recursive: true, force: true });
  rmSync(unpacked, { recursive: true, force: true });
  mkdirSync(dirname(staging), { recursive: true });
  try {
    // The whole archive goes under a scratch directory (every name was checked above); only the skill's own directory is kept.
    await unzipInto(archive, unpacked, "\u0001no-such-entry");
    renameSync(prefix === "" ? unpacked : join(unpacked, normalize(prefix)), staging);
    rmSync(unpacked, { recursive: true, force: true });
    return placeSkill(agentDir, name, staging, replace);
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    rmSync(unpacked, { recursive: true, force: true });
    if (e instanceof DomainError) throw e;
    return refuse("Could not install that skill.");
  }
}

/** `file` is the staged upload on disk, `fileName` what the person picked (its extension says which kind). */
export async function installSkill(agentDir: string, file: string, fileName: string, replace: boolean): Promise<Install> {
  const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase() : "";
  mkdirSync(agentDir, { recursive: true });
  if (ext === "md") return installMarkdown(agentDir, readFileSync(file), replace);
  if (ext === "zip") return installZip(agentDir, file, statSync(file).size, replace);
  return refuse("Choose a .md or .zip skill.");
}

// ---- the prompt ----------------------------------------------------------------------------------------------------------

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** The installation identifier of a host is the name of its app config directory (the bundle identifier on a Mac). */
export const installationIdentifier = (appConfig: string) => basename(appConfigDirOf(appConfig));

export function customizationPrompt(appConfig: string, agentDir: string): string {
  const agent = shellQuote(agentDir);
  return `Help me customize the Vinculum harness in this Alinery installation. Its agent runtime is pi-durable, from Pi (@earendil-works/pi-durable 1.4.0). It is not OMP. There is no OMP binary to run. ~/.pi and ~/.omp are the wrong directories.

Alinery installation identifier: ${installationIdentifier(appConfig)}
Alinery app configuration: ${appConfig}
Agent directory (shell quoted): ${agent}

Inspect existing files locally first. Do not print, copy, or upload secrets. Back up a file before editing it. Make the smallest necessary edit. mcp.json may contain commands, env, and headers; do not echo those values. Do not read credential stores into the reply. Do not put a secret in the prompt. Provider sign-in is the Accounts list, not models.yml.

Edit only the agent directory above.
- Skills that sessions load live at skills/<name>/SKILL.md. The model is told the name, the description, and the path. It is not given the body. It reads the file with the read tool. Paths inside the skill are relative to that skill's directory.
- mcp.json and .mcp.json in that directory are user MCP servers. The daemon connects stdio and streamable HTTP. It does not do OAuth. The alinery key is reserved for the built-in server. Do not add a server and claim it replaced the built-in.
- Extensions under extensions/ are listed and not loaded. Do not add one and claim the session picked it up.
- The daemon's own tools are read, write, edit, bash, alinery_phase_complete, and alinery_set_session_name. They are not files. Do not look for them in the agent directory. A write to xd://alinery_phase_complete is the phase tool.

- File formats are Pi's, in packages/coding-agent/docs/ of earendil-works/pi (skills and MCP). Do not use an OMP repository or pin these instructions to an OMP release.

Example read-only inspection (POSIX shell; names only, not file contents):
(
  cd ${agent} || exit
  find . -name 'SKILL.md' -o -name 'mcp.json' -o -name '.mcp.json' -o -name 'package.json'
)

Alinery clears the session environment. A key exported in the shell is not a Vinculum credential.

My requested change:
`;
}
