import { existsSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const MAX_SKILLS = 64;
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

/** Name, description, and path only. The body stays on disk for the read tool. */
export function skillCatalog(agentDir: string): string | undefined {
  const skills = join(agentDir, "skills");
  let names: string[] = [];
  try {
    names = readdirSync(skills).filter((name) => !name.startsWith(".")).sort();
  } catch {
    return undefined;
  }
  const seen = new Set<string>();
  const blocks: string[] = [];
  let omitted = 0;
  for (const directory of names) {
    const path = join(skills, directory, "SKILL.md");
    let text = "";
    try {
      if (!statSync(path).isFile()) continue;
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const skill = offeredSkill(text);
    if (!skill || seen.has(skill.name)) continue;
    seen.add(skill.name);
    if (blocks.length >= MAX_SKILLS) {
      omitted += 1;
      continue;
    }
    blocks.push(`name: ${skill.name}\ndescription: ${skill.description}\npath: ${path}`);
  }
  if (blocks.length === 0) return undefined;
  let catalog = "Skills you can use. When one applies, read its SKILL.md with the read tool. Paths inside a skill are relative to that skill's directory.\n\n";
  catalog += blocks.join("\n\n");
  if (omitted > 0) catalog += "\n\nFurther skills were omitted.";
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
  return { values, disabled: flag === "true" };
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) return value.slice(1, -1);
  }
  return value;
}
