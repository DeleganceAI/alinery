import { type ChatCommand, type CommandSource, SOURCE_GROUPS } from "./types";

export function parseSlash(raw: string): { name: string; args: string } | null {
  const t = raw.trim();
  if (!t.startsWith("/")) return null;
  const body = t.slice(1);
  const sp = body.search(/\s/);
  if (sp === -1) return { name: body, args: "" };
  return { name: body.slice(0, sp), args: body.slice(sp + 1).trim() };
}

export function findCommand(raw: string, catalog: ChatCommand[]): ChatCommand | undefined {
  const token = raw.replace(/^\//, "").trim().split(/\s+/)[0]?.toLowerCase();
  if (!token) return undefined;
  return catalog.find((c) => c.name.toLowerCase() === token || c.aliases?.some((a) => a.toLowerCase() === token));
}

export function matchCommands(raw: string, catalog: ChatCommand[]): ChatCommand[] {
  const q = raw.replace(/^\//, "").trim().toLowerCase();
  if (!q) return catalog;
  const scored = catalog
    .map((cmd) => {
      const names = [cmd.name, ...(cmd.aliases ?? [])];
      let score = 99;
      for (const n of names) {
        const lower = n.toLowerCase();
        if (lower === q) score = Math.min(score, 0);
        else if (lower.startsWith(q)) score = Math.min(score, 1);
        else if (lower.includes(q)) score = Math.min(score, 2);
      }
      if (cmd.description?.toLowerCase().includes(q)) score = Math.min(score, 3);
      return { cmd, score };
    })
    .filter((s) => s.score < 99);
  scored.sort((a, b) => a.score - b.score || a.cmd.name.localeCompare(b.cmd.name));
  return scored.map((s) => s.cmd);
}

export function groupCommands(cmds: ChatCommand[]): { group: string; items: ChatCommand[] }[] {
  const map = new Map<string, ChatCommand[]>();
  for (const cmd of cmds) {
    const group = cmd.source ?? "builtin";
    const list = map.get(group) ?? [];
    list.push(cmd);
    map.set(group, list);
  }
  const known = SOURCE_GROUPS.filter((g) => map.has(g)).map((g) => ({ group: g, items: map.get(g) ?? [] }));
  const extra = [...map.keys()]
    .filter((g) => !(SOURCE_GROUPS as readonly string[]).includes(g as CommandSource))
    .sort()
    .map((g) => ({ group: g, items: map.get(g) ?? [] }));
  return [...known, ...extra];
}
