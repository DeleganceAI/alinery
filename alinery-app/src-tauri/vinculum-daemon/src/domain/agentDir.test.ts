// The agent directory (S4.10). The cases are the ones the app's Rust tests held for `vinculum_customizations.rs` and `omp_update.rs`
// (the Rust side of the model-role helpers stays for the hosted default role until S4.11, so these two sets must keep agreeing).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillCatalog } from "../skills.ts";
import {
  customizationPrompt,
  customizationsFromDir,
  deleteSkill,
  installSkill,
  parseModelRoles,
  readModelRoles,
  removeIncludedSkill,
  renderModelRoles,
  restoreIncludedSkills,
  setSkillEnabled,
  writeModelRoles,
} from "./agentDir.ts";

let root: string;
let agent: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agent-dir-"));
  agent = join(root, "agent");
  mkdirSync(agent, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const file = (rel: string, content: string) => {
  const p = join(agent, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
};
const skillMd = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
const zipOf = async (name: string, entries: Record<string, string>, extra: string[] = []) => {
  const dir = join(root, `zip-src-${Math.random().toString(36).slice(2)}`);
  for (const [rel, text] of Object.entries(entries)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  const out = join(root, name);
  const proc = Bun.spawn(["zip", "-q", "-r", "-y", out, ...Object.keys(entries).map((e) => e.split("/")[0] as string), ...extra], { cwd: dir });
  await proc.exited;
  return out;
};

describe("model roles", () => {
  test("a round trip keeps the other keys and replaces the block", () => {
    const rendered = renderModelRoles("theme: dark\nmodelRoles:\n  smol: old/model\nother: keep\n", { default: "anthropic/claude", smol: "xai/grok" });
    expect(rendered).toContain("theme: dark");
    expect(rendered).toContain("other: keep");
    expect(rendered).not.toContain("old/model");
    expect(parseModelRoles(rendered)).toEqual({ default: "anthropic/claude", smol: "xai/grok" });
  });
  test("an empty set removes the block", () => {
    const rendered = renderModelRoles("a: 1\nmodelRoles:\n  smol: x/y\nb: 2\n", {});
    expect(rendered).not.toContain("modelRoles");
    expect(rendered).toContain("a: 1");
    expect(rendered).toContain("b: 2");
  });
  test("the bytes match what the Rust renderer wrote", () => {
    expect(renderModelRoles("", { b: "2/x", a: "1/y" })).toBe("modelRoles:\n  a: 1/y\n  b: 2/x\n");
    expect(renderModelRoles("x: 1", { a: "1/y" })).toBe("x: 1\n\nmodelRoles:\n  a: 1/y\n");
    expect(renderModelRoles("x: 1\n\n\n", {})).toBe("x: 1\n");
  });
  test("write then read goes through config.yml, and config.yaml is used when it is the one there", () => {
    writeModelRoles(agent, { default: "p/m" });
    expect(readFileSync(join(agent, "config.yml"), "utf8")).toBe("modelRoles:\n  default: p/m\n");
    expect(readModelRoles(agent)).toEqual({ default: "p/m" });
    rmSync(join(agent, "config.yml"));
    writeFileSync(join(agent, "config.yaml"), "modelRoles:\n  smol: 'q/n'\n");
    expect(readModelRoles(agent)).toEqual({ smol: "q/n" });
    writeModelRoles(agent, {});
    expect(readFileSync(join(agent, "config.yaml"), "utf8")).toBe("");
  });
});

describe("the inventory", () => {
  test("loose skills are listed without running anything", () => {
    file("skills/ponytail/SKILL.md", "---\nname: 'Ponytail: minimal'\ndescription: Keep it simple\n---\nInstructions");
    file("skills/fallback/SKILL.md", "No frontmatter, but still installed.");
    file("skills/disabled/SKILL.md", "---\nname: disabled-skill\ndescription: Hidden\ndisable-model-invocation: true\n---\nInstructions");
    file("skills/nested/child/SKILL.md", "Not a directly installed skill.");
    const inv = customizationsFromDir(agent);
    expect(inv.errors).toEqual([]);
    expect(inv.items.filter((i) => i.kind === "Skill").map((i) => i.name)).toEqual(["Ponytail: minimal", "disabled-skill", "fallback"]);
    const offered = (n: string) => inv.items.find((i) => i.name === n)?.offered;
    expect([offered("Ponytail: minimal"), offered("disabled-skill"), offered("fallback")]).toEqual([true, false, false]);
  });
  test("a missing directory is an empty install", () => {
    rmSync(agent, { recursive: true });
    expect(customizationsFromDir(agent)).toEqual({ items: [], errors: [], skills: { on: 0, limit: 64, catalogChars: 0, removed: [] } });
  });
  test("malformed metadata keeps filename fallbacks and never echoes the file", () => {
    file("skills/broken/SKILL.md", "---\nname: [secret-frontmatter\n---\nBody");
    file("skills/unclosed/SKILL.md", "---\nname: secret-unclosed");
    file("skills/good/SKILL.md", "---\nname: >-\n  Folded name\n---\nBody");
    file("extensions/broken-package/package.json", '{"name":"secret-package"');
    file("mcp.json", '{"mcpServers":{"secret-json-excerpt":');
    file(".mcp.json", '{"mcpServers":{"healthy-server":{"command":"server"}}}');
    const inv = customizationsFromDir(agent);
    for (const name of ["broken", "unclosed", "Folded name", "broken-package", "healthy-server"]) expect(inv.items.map((i) => i.name)).toContain(name);
    expect(inv.errors.some((e) => e.includes("malformed YAML"))).toBe(true);
    expect(inv.errors.some((e) => e.includes("unterminated"))).toBe(true);
    expect(inv.errors.some((e) => e.includes("mcp.json"))).toBe(true);
    expect(JSON.stringify(inv)).not.toContain("secret-");
  });
  test("an MCP server shows its name and source only", () => {
    file(
      "mcp.json",
      '{"mcpServers":{"local":{"command":"secret-command","args":["secret-arg"],"env":{"API_KEY":"secret-env"}},"remote":{"url":"https://secret-url","headers":{"Authorization":"secret-header"}},"invalid":"secret-invalid-definition"},"unrelated":"secret-top-level"}',
    );
    const inv = customizationsFromDir(agent);
    expect(inv.items.map((i) => i.name)).toEqual(["invalid", "local", "remote"]);
    expect(inv.errors.some((e) => e.includes("definition must be an object"))).toBe(true);
    for (const i of inv.items) expect([i.path, i.source]).toEqual([join(agent, "mcp.json"), join(agent, "mcp.json")]);
    expect(JSON.stringify(inv)).not.toContain("secret-");
  });
  test("extensions are discovered without executing code, and a linked skill counts", () => {
    const executed = join(root, "extension-executed");
    const code = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(executed)}, 'executed');`;
    file("extensions/loose.ts", code);
    file("extensions/indexed/index.js", code);
    file("extensions/declared/package.json", '{"name":"declared-extension","omp":{"extensions":["custom.ts"]}}');
    file("extensions/declared/custom.ts", code);
    file("extensions/unrelated/package.json", '{"name":"not-an-extension"}');
    file("extensions/legacy/gemini-extension.json", '{"name":"legacy-extension"}');
    file(".skill-source/SKILL.md", "---\nname: linked-skill\n---\nBody");
    mkdirSync(join(agent, "skills"), { recursive: true });
    symlinkSync(join(agent, ".skill-source"), join(agent, "skills/linked"));
    const inv = customizationsFromDir(agent);
    expect(inv.items.map((i) => i.name)).toEqual(["declared-extension", "indexed", "legacy-extension", "loose.ts", "linked-skill"]);
    expect(existsSync(executed)).toBe(false);
  });
  test("a broken link and a file where a directory belongs give a partial inventory", () => {
    file("skills/retained/SKILL.md", "Body");
    symlinkSync(join(root, "missing"), join(agent, "skills/broken"));
    file("extensions", "not a directory");
    const inv = customizationsFromDir(agent);
    expect(inv.items.map((i) => i.name)).toContain("retained");
    expect(inv.errors.some((e) => e.includes("skills/broken"))).toBe(true);
    expect(inv.errors.some((e) => e.includes("extensions"))).toBe(true);
  });
});

describe("installing and deleting skills", () => {
  test("a markdown skill installs as one directory; a missing description is refused and writes nothing", async () => {
    const source = join(root, "demo.md");
    writeFileSync(source, skillMd("demo-skill", "Does the demo", "Secret body"));
    expect(await installSkill(agent, source, "demo.md", false)).toEqual({ name: "demo-skill", exists: false });
    expect(readFileSync(join(agent, "skills/demo-skill/SKILL.md"), "utf8")).toContain("Secret body");
    writeFileSync(source, "---\nname: other-skill\n---\nno description\n");
    await expect(installSkill(agent, source, "demo.md", false)).rejects.toThrow(/description/);
    expect(existsSync(join(agent, "skills/other-skill"))).toBe(false);
    await expect(installSkill(agent, source, "demo.txt", false)).rejects.toThrow(/\.md or \.zip/);
  });
  test("a zip installs one skill directory under its declared name", async () => {
    const zip = await zipOf("skill.zip", { "bundle/SKILL.md": skillMd("from-zip", "Packed skill", "Packed body"), "bundle/scripts/run.sh": "echo hi" });
    expect(await installSkill(agent, zip, "skill.zip", false)).toEqual({ name: "from-zip", exists: false });
    expect(readFileSync(join(agent, "skills/from-zip/scripts/run.sh"), "utf8")).toBe("echo hi");
    expect(existsSync(join(agent, "skills/bundle"))).toBe(false);
    expect(existsSync(join(agent, "skills/.staging-from-zip.unpack"))).toBe(false);
  });
  test("a zip with SKILL.md at its root installs too", async () => {
    const zip = await zipOf("flat.zip", { "SKILL.md": skillMd("flat-skill", "Flat", "x"), "references/a.md": "ref" });
    expect(await installSkill(agent, zip, "flat.zip", false)).toEqual({ name: "flat-skill", exists: false });
    expect(readFileSync(join(agent, "skills/flat-skill/references/a.md"), "utf8")).toBe("ref");
  });
  test("a zip that escapes, holds a symlink, holds another skill's files or is oversize is refused and leaves the install alone", async () => {
    const good = await zipOf("good.zip", { "SKILL.md": skillMd("kept", "Kept", "kept body") });
    await installSkill(agent, good, "good.zip", false);

    const escape = join(root, "escape.zip");
    const dir = join(root, "esc");
    mkdirSync(join(dir, "inner"), { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), skillMd("escaper", "Escapes", "x"));
    await Bun.spawn(["zip", "-q", escape, "../SKILL.md"], { cwd: join(dir, "inner") }).exited;
    await expect(installSkill(agent, escape, "escape.zip", false)).rejects.toThrow(/escapes|absolute/);
    expect(existsSync(join(agent, "SKILL.md"))).toBe(false);

    const linkDir = join(root, "lnk");
    mkdirSync(join(linkDir, "scripts"), { recursive: true });
    writeFileSync(join(linkDir, "SKILL.md"), skillMd("linker", "Links", "x"));
    symlinkSync("/etc/passwd", join(linkDir, "scripts/link"));
    await Bun.spawn(["zip", "-q", "-r", "-y", join(root, "link.zip"), "."], { cwd: linkDir }).exited;
    await expect(installSkill(agent, join(root, "link.zip"), "link.zip", true)).rejects.toThrow(/symlink/);

    const stray = await zipOf("stray.zip", { "SKILL.md": skillMd("stray", "Stray", "x"), "other/file.txt": "no" });
    await expect(installSkill(agent, stray, "stray.zip", false)).rejects.toThrow(/not one skill/);

    const fat = await zipOf("fat.zip", { "SKILL.md": skillMd("fat-skill", "Fat", "x".repeat(8 * 1024 * 1024)) });
    await expect(installSkill(agent, fat, "fat.zip", false)).rejects.toThrow(/8 MiB/);
    expect(readFileSync(join(agent, "skills/kept/SKILL.md"), "utf8")).toContain("kept body");
    expect(existsSync(join(agent, "skills/fat-skill"))).toBe(false);
  });
  test("replace asks by leaving the directory until it is confirmed", async () => {
    const source = join(root, "demo.md");
    writeFileSync(source, skillMd("demo-skill", "First", "first body"));
    await installSkill(agent, source, "demo.md", false);
    writeFileSync(source, skillMd("demo-skill", "Second", "second body"));
    expect(await installSkill(agent, source, "demo.md", false)).toEqual({ name: "demo-skill", exists: true });
    expect(readFileSync(join(agent, "skills/demo-skill/SKILL.md"), "utf8")).toContain("first body");
    expect(await installSkill(agent, source, "demo.md", true)).toEqual({ name: "demo-skill", exists: false });
    expect(readFileSync(join(agent, "skills/demo-skill/SKILL.md"), "utf8")).toContain("second body");
  });
  test("deleting a skill that is a link unlinks it and keeps the target", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep"), "safe");
    mkdirSync(join(agent, "skills"), { recursive: true });
    symlinkSync(outside, join(agent, "skills/linked"));
    deleteSkill(agent, "linked");
    expect(existsSync(join(agent, "skills/linked"))).toBe(false);
    expect(readFileSync(join(outside, "keep"), "utf8")).toBe("safe");
    expect(() => deleteSkill(agent, "../escape")).toThrow(/not inside/);
    expect(() => deleteSkill(agent, "absent")).toThrow(/not installed/);
  });
});

describe("the prompt", () => {
  test("quotes the agent directory, runs as a read-only inspection and carries no file content", async () => {
    const install = join(root, "Alinery's $(touch INJECTED) 日本語");
    const dir = join(install, "vinculum/config/agent");
    mkdirSync(join(dir, "skills/demo"), { recursive: true });
    writeFileSync(join(dir, "mcp.json"), "private-content-mcp");
    writeFileSync(join(dir, "skills/demo/SKILL.md"), "private-content-skill");
    const prompt = customizationPrompt(join(install, "app.toml"), dir);
    expect(prompt).toContain("Vinculum is Alinery's own agent harness");
    expect(prompt).not.toMatch(/\bomp\b|\bpi\b|\.pi\b|pi-durable|earendil/i);
    expect(prompt).toContain("Alinery installation identifier: Alinery's $(touch INJECTED) 日本語");
    expect(prompt).not.toContain("private-content");
    const start = prompt.indexOf("\n(\n");
    const end = prompt.indexOf("\n)\n", start) + 3;
    const run = Bun.spawn(["/bin/sh", "-c", prompt.slice(start, end)], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(run.stdout).text();
    expect(await run.exited).toBe(0);
    expect(out).toContain("SKILL.md");
    expect(out).toContain("mcp.json");
    expect(out).not.toContain("private-content");
    expect(existsSync(join(root, "INJECTED"))).toBe(false);
  });
});

describe("included skills", () => {
  let included: string;
  const includedSkill = (name: string) => {
    mkdirSync(join(included, name), { recursive: true });
    writeFileSync(join(included, name, "SKILL.md"), skillMd(name, `Included ${name}`, "Body"));
  };
  beforeEach(() => {
    included = join(root, "runtime", "skills");
    for (const name of ["docx", "pdf", "invoice-generator"]) includedSkill(name);
    writeFileSync(join(included, "included.json"), JSON.stringify({ off_by_default: ["invoice-generator"] }));
  });
  const skill = (name: string) => customizationsFromDir(agent, included).items.find((i) => i.kind === "Skill" && i.name === name);

  test("start at their defaults, and only the ones on reach the catalog", () => {
    expect([skill("docx")?.enabled, skill("invoice-generator")?.enabled, skill("docx")?.included]).toEqual([true, false, true]);
    const catalog = skillCatalog(agent, included) ?? "";
    expect(catalog).toContain("Included docx");
    expect(catalog).not.toContain("invoice-generator");
    expect(customizationsFromDir(agent, included).skills?.on).toBe(2);
  });

  test("switch on and off, the user's own skills too", () => {
    file("skills/mine/SKILL.md", skillMd("mine", "My skill", "Body"));
    setSkillEnabled(agent, included, "invoice-generator", true);
    setSkillEnabled(agent, included, "docx", false);
    setSkillEnabled(agent, included, "mine", false);
    const catalog = skillCatalog(agent, included) ?? "";
    expect(catalog).toContain("Included invoice-generator");
    expect(catalog).not.toContain("Included docx");
    expect(catalog).not.toContain("My skill");
    expect(() => setSkillEnabled(agent, included, "nope", true)).toThrow("not installed");
  });

  test("a user's skill of the same name replaces the included one", () => {
    file("skills/pdf/SKILL.md", skillMd("pdf", "My own pdf", "Body"));
    const catalog = skillCatalog(agent, included) ?? "";
    expect(catalog).toContain("My own pdf");
    expect(catalog).not.toContain("Included pdf");
    expect(customizationsFromDir(agent, included).items.find((i) => i.included && i.name === "pdf")?.offered).toBe(false);
  });

  test("removed stay removed until restored, at their default again", () => {
    setSkillEnabled(agent, included, "pdf", false);
    removeIncludedSkill(agent, included, "pdf");
    expect(skill("pdf")).toBeUndefined();
    expect(customizationsFromDir(agent, included).skills?.removed).toEqual(["pdf"]);
    expect(existsSync(join(included, "pdf", "SKILL.md"))).toBe(true);
    expect(() => removeIncludedSkill(agent, included, "mine")).toThrow("not an included skill");
    restoreIncludedSkills(agent);
    expect(skill("pdf")?.enabled).toBe(true);
  });

  test("turning one on past the limit is refused", () => {
    for (let n = 0; n < 63; n++) file(`skills/s${n}/SKILL.md`, skillMd(`s${n}`, "Mine", "Body"));
    expect(customizationsFromDir(agent, included).skills?.on).toBe(65);
    setSkillEnabled(agent, included, "s0", false);
    expect(() => setSkillEnabled(agent, included, "invoice-generator", true)).toThrow("At most 64");
    setSkillEnabled(agent, included, "docx", true);
    setSkillEnabled(agent, included, "s1", false);
    setSkillEnabled(agent, included, "invoice-generator", true);
    expect(customizationsFromDir(agent, included).skills?.on).toBe(64);
  });
});
