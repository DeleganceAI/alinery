import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { skillCatalog } from "./skills.ts";

function skill(dir: string, name: string, body: string) {
  const path = join(dir, "skills", name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), body);
}

describe("skill catalog", () => {
  test("offers one valid skill and skips the rest without pasting a body", () => {
    const agent = mkdtempSync(join(tmpdir(), "alinery-skills-"));
    skill(agent, "b-valid", "---\nname: valid-skill\ndescription: Use this one\n---\nSECRET BODY\n");
    skill(agent, "a-blank", "---\nname: missing-description\n---\nSECRET BODY\n");
    skill(agent, "c-hidden", "---\nname: hidden-skill\ndescription: Do not offer\ndisable-model-invocation: true\n---\nSECRET BODY\n");
    skill(agent, "d-collision", "---\nname: valid-skill\ndescription: Later copy\n---\nSECRET BODY\n");
    const catalog = skillCatalog(agent) ?? "";
    expect(catalog).toContain("valid-skill");
    expect(catalog).toContain("Use this one");
    expect(catalog).toContain(join(agent, "skills", "b-valid", "SKILL.md"));
    expect(catalog).not.toContain("SECRET BODY");
    expect(catalog).not.toContain("missing-description");
    expect(catalog).not.toContain("hidden-skill");
    expect(catalog).not.toContain("Later copy");
    expect(catalog).not.toContain("d-collision");
  });
});
