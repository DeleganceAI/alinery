import { useCallback, useEffect, useState } from "react";
import * as ipc from "./ipc";

export type McpStatus = {
  enabled: boolean;
  running: boolean;
  clients: number;
  socket_reachable: boolean;
  binary_found: boolean;
  binary_path: string;
  repo: string;
  socket_path: string;
  error: string;
};

export type McpStatusHandle = McpStatus & { refresh: () => void };

const OFFLINE: McpStatus = {
  enabled: true,
  running: false,
  clients: 0,
  socket_reachable: false,
  binary_found: true,
  binary_path: "",
  repo: "",
  socket_path: "",
  error: "",
};

export function mcpIsUp(m: McpStatus): boolean {
  return m.enabled && m.running;
}

/** Severity of the current status: drives icon/color; the label carries the meaning. */
export function mcpStatusKind(m: McpStatus): "ok" | "muted" | "error" {
  if (!m.enabled) return "muted";
  if (!m.repo) return "muted";
  if (!m.binary_found) return "error";
  if (mcpIsUp(m)) return "ok";
  return "error";
}

export function mcpDotColor(m: McpStatus): string {
  const kind = mcpStatusKind(m);
  if (kind === "muted") return "var(--text-faint)";
  if (kind === "ok") return "var(--success)";
  return "var(--danger)";
}

// Single label source — Settings shows as-is; footer prefixes "MCP ".
export function mcpStatusLabel(m: McpStatus): string {
  if (!m.repo) return "No repo";
  if (!m.binary_found) return "Binary missing";
  if (!m.enabled) return "Off";
  if (!mcpIsUp(m)) return "Down";
  if (m.clients === 0) return "Idle";
  return m.clients === 1 ? "1 client" : `${m.clients} clients`;
}

export function mcpFooterLabel(m: McpStatus): string {
  const label = mcpStatusLabel(m);
  if (label === "No repo") return "";
  // Footer reads as one phrase ("MCP idle"), so the status loses its leading capital
  // unless it starts with a count.
  return `MCP ${/^\d/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1)}`;
}

// Poll mcp_status() on a 1.5s interval (mirrors useDaemonStatus).
export function useMcpStatus(): McpStatusHandle {
  const [status, setStatus] = useState<McpStatus>(OFFLINE);

  const refresh = useCallback(() => {
    ipc
      .mcpStatus()
      .then(setStatus)
      .catch(() => setStatus(OFFLINE));
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      ipc
        .mcpStatus()
        .then((s) => alive && setStatus(s))
        .catch(() => alive && setStatus(OFFLINE));
    tick();
    const t = setInterval(tick, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return { ...status, refresh };
}
