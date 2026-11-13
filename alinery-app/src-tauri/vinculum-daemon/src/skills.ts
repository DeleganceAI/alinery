import { existsSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const MAX_DESCRIPTION = 1024;

/** Same rule as `alinery_core::vinculum_home_dirs`. The daemon does not call FFI just to build this path. */
export function vinculumAgentDir(appConfig: string): string {
  const parent = dirname(appConfig);
  const vinculum = join(parent, "vinculum");
  const omp = join(parent, "omp");
  if (!existsSync(vinculum) && isDirectory(omp)) {
    try {
      renameSync(omp, vinculum);
    } catch {
      // Leave `omp/` where it is. Sessions read `vinculum/` only.
    }
  }
  return join(vinculum, "config", "agent");
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function offeredSkill(text: string): { name: string; description: string } | undefined {
  const front = frontmatter(text);
  if (!front) return undefined;
  if (front.disabled) return undefined;
  const name = front.values.name?.trim();
  const description = front.values.description?.trim();
  if (!name || !description) return undefined;
  return { name, description: description.slice(0, MAX_DESCRIPTION) };
}

export const MAX_SKILLS = 64;

/** The user's choices about skills, in the agent directory: which are switched on or off (an included skill's default is
 * its `included.json` entry, a user's skill is on), and which included skills were removed. */
export type SkillChoices = { enabled: Record<string, boolean>; removed: string[] };
export const skillChoicesPath = (agentDir: string) => join(agentDir, "skill-choices.json");

export function readSkillChoices(agentDir: string): SkillChoices {
  try {
    const raw = JSON.parse(readFileSync(skillChoicesPath(agentDir), "utf8")) as Partial<SkillChoices>;
    const enabled: Record<string, boolean> = {};
    for (const [name, on] of Object.entries(raw.enabled ?? {})) if (typeof on === "boolean") enabled[name] = on;
    return { enabled, removed: Array.isArray(raw.removed) ? raw.removed.filter((name) => typeof name === "string") : [] };
  } catch {
    return { enabled: {}, removed: [] };
  }
}

/** The skills Alinery includes: each directory of the runtime's `skills/` holding a SKILL.md, named by its directory. */
export function includedSkills(dir: string | undefined): { name: string; path: string; offByDefault: boolean }[] {
  if (!dir) return [];
  let off: string[] = [];
  try {
    off = (JSON.parse(readFileSync(join(dir, "included.json"), "utf8")) as { off_by_default?: string[] }).off_by_default ?? [];
  } catch {}
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((name) => !name.startsWith(".")).sort();
  } catch {
    return [];
  }
  return names.map((name) => ({ name, path: join(dir, name, "SKILL.md"), offByDefault: off.includes(name) })).filter((skill) => isFile(skill.path));
}

export const skillOn = (choices: SkillChoices, name: string, offByDefault = false) => choices.enabled[name] ?? !offByDefault;

export type OfferedSkill = { name: string; description: string; path: string; included: boolean };

/** What the model is offered, in order: the user's own skills, then the included ones. The first of a name wins, so a
 * user's skill replaces an included one of its name; switched-off and removed skills are left out. Not capped. */
export function offeredSkills(agentDir: string, included?: string): OfferedSkill[] {
  const choices = readSkillChoices(agentDir);
  const userDir = join(agentDir, "skills");
  let names: string[] = [];
  try {
    names = readdirSync(userDir).filter((name) => !name.startsWith(".")).sort();
  } catch {}
  const candidates = [
    ...names.map((directory) => ({ path: join(userDir, directory, "SKILL.md"), included: false, offByDefault: false })),
    ...includedSkills(included)
      .filter((skill) => !choices.removed.includes(skill.name))
      .map((skill) => ({ path: skill.path, included: true, offByDefault: skill.offByDefault })),
  ];
  const seen = new Set<string>();
  const out: OfferedSkill[] = [];
  for (const candidate of candidates) {
    let text = "";
    try {
      if (!statSync(candidate.path).isFile()) continue;
      text = readFileSync(candidate.path, "utf8");
    } catch {
      continue;
    }
    const skill = offeredSkill(text);
    if (!skill || seen.has(skill.name)) continue;
    seen.add(skill.name);
    if (skillOn(choices, skill.name, candidate.offByDefault)) out.push({ ...skill, path: candidate.path, included: candidate.included });
  }
  return out;
}

/** Name, description, and path only. The body stays on disk for the read tool. At most MAX_SKILLS. */
export function skillCatalog(agentDir: string, included?: string): string | undefined {
  const offered = offeredSkills(agentDir, included);
  if (offered.length === 0) return undefined;
  const blocks = offered.slice(0, MAX_SKILLS).map((skill) => `name: ${skill.name}\ndescription: ${skill.description}\npath: ${skill.path}`);
  let catalog = "Skills you can use. When one applies, read its SKILL.md with the read tool. Paths inside a skill are relative to that skill's directory.\n\n";
  catalog += blocks.join("\n\n");
  if (offered.length > MAX_SKILLS) catalog += "\n\nFurther skills were omitted.";
  return catalog;
}

function frontmatter(text: string): { values: Record<string, string>; disabled: boolean } | undefined {
  if (!text.startsWith("---")) return undefined;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return undefined;
  const yaml = text.slice(text.indexOf("\n") + 1, end);
  const values: Record<string, string> = {};
  const lines = yaml.split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) {
      index += 1;
      continue;
    }
    const key = match[1] ?? "";
    const raw = (match[2] ?? "").trim();
    if (raw === "|" || raw === ">" || raw === "|-" || raw === ">-") {
      const block: string[] = [];
      index += 1;
      while (index < lines.length && (lines[index] ?? "").startsWith(" ")) {
        block.push((lines[index] ?? "").trim());
        index += 1;
      }
      values[key] = block.join(raw.startsWith(">") ? " " : "\n").trim();
      continue;
    }
    values[key] = unquote(raw);
    index += 1;
  }
  const flag = values["disable-model-invocation"];
  return { values, disabled: flag?.replace(/\s+#.*$/, "") === "true" };
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) return value.slice(1, -1);
  }
  return value;
}
