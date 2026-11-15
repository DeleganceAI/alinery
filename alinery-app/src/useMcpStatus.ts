import { useEffect, useState } from "react";
import * as ipc from "./ipc";
import type { McpStatus } from "./types";

export type { McpStatus };

/** The binary and arguments a host's stdio config runs (the bridge to the machine MCP). Read once: they change only with the app. */
export function useMcpStatus(): McpStatus {
  const [status, setStatus] = useState<McpStatus>({ binary_path: "", host_args: [] });
  useEffect(() => {
    ipc.mcpStatus().then(setStatus, () => {});
  }, []);
  return status;
}
