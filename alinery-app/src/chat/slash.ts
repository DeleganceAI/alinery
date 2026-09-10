import { findCommand, parseSlash } from "./commands";
import type { ChatCommand } from "./types";

const MCP_HATCH = new Set(["reauth", "unauth", "smithery-login", "smithery-logout", "reconnect", "notifications"]);
const COMPACT_MODES = new Set(["soft", "remote", "snapcompact"]);

export type ProvidersDialogTab = "accounts" | "models";

export type SlashDispatch =
  | { kind: "open-providers"; tab: ProvidersDialogTab; args: string }
  | { kind: "hatch"; name: string; reason: string }
  | { kind: "get-tools" }
  | { kind: "mcp-list" }
  | { kind: "mcp-prompt"; message: string }
  | { kind: "compact"; customInstructions?: string }
  | { kind: "compact-mode"; message: string }
  | { kind: "prompt"; message: string }
  | { kind: "unknown-prompt"; message: string };

export function routeSlash(raw: string, catalog: ChatCommand[]): SlashDispatch | null {
  const parsed = parseSlash(raw);
  if (!parsed) return null;
  const name = parsed.name.toLowerCase();
  const args = parsed.args;
  const message = args ? `/${parsed.name} ${args}` : `/${parsed.name}`;

  if (name === "logout") {
    return {
      kind: "hatch",
      name,
      reason: "OMP logout is Terminal-only. Switch this session to Terminal to log out.",
    };
  }

  if (name === "login" || name === "provider" || name === "providers" || name === "setup") {
    return { kind: "open-providers", tab: "accounts", args };
  }

  if (name === "model" || name === "models") {
    return { kind: "open-providers", tab: "models", args };
  }

  if (name === "tools") {
    return { kind: "get-tools" };
  }

  if (name === "mcp") {
    const sub = args.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (!sub || sub === "list") return { kind: "mcp-list" };
    if (MCP_HATCH.has(sub)) {
      return {
        kind: "hatch",
        name: `mcp ${sub}`,
        reason: `/${name} ${sub} needs the Terminal UI.`,
      };
    }
    return { kind: "mcp-prompt", message: `/mcp ${args}` };
  }

  if (name === "compact") {
    const mode = args.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (COMPACT_MODES.has(mode)) return { kind: "compact-mode", message };
    return { kind: "compact", customInstructions: args || undefined };
  }

  const known = findCommand(parsed.name, catalog);
  if (known) return { kind: "prompt", message };
  if (name.startsWith("skill:")) return { kind: "prompt", message };
  return { kind: "unknown-prompt", message };
}

export function parseProviderModel(args: string): { provider: string; modelId: string } | null {
  const t = args.trim();
  if (!t) return null;
  const slash = t.indexOf("/");
  if (slash <= 0 || slash === t.length - 1) return null;
  return { provider: t.slice(0, slash), modelId: t.slice(slash + 1) };
}

export type McpServerRow = {
  name: string;
  type: string;
  enabled: boolean;
  location: string;
};

/** Parse ACP `/mcp list` command_output lines: `name | type | enabled|disabled | location [user|project]`. */
export function parseMcpListOutput(text: string): McpServerRow[] | "empty" {
  const trimmed = text.trim();
  if (!trimmed || /no mcp servers configured/i.test(trimmed)) return "empty";
  const rows: McpServerRow[] = [];
  for (const line of trimmed.split("\n")) {
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 3) continue;
    const [name, type, state, location = ""] = parts;
    if (!name) continue;
    const enabled = !/^disabled$/i.test(state);
    if (!/^enabled$/i.test(state) && !/^disabled$/i.test(state)) continue;
    rows.push({ name, type, enabled, location });
  }
  return rows;
}
