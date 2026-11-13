// The one place the daemon starts child processes of its own and the one place it signals them, so
// scripts/tests/check-no-auto-session-kill.sh has a single file to trust. git has its own home (platform/git.ts).

/** Why a child is being signalled. Each caller of signalChild is listed with its reason in the gate. */
export type SignalReason = "session-kill" | "mcp-restart" | "job-cancel" | "keepawake-release" | "convert-timeout";

/** Bun.spawn in its own process group, so a signal aimed at the daemon's group does not reach the child. */
export function spawnDetached<const Opts extends Bun.SpawnOptions.OptionsObject<any, any, any>>(cmd: string[], options: Opts) {
  return Bun.spawn(cmd, { ...options, detached: true });
}

/** Signal a child. A child that has already exited is not an error. */
export function signalChild(child: Bun.Subprocess, signal: NodeJS.Signals | number, _reason: SignalReason): void {
  try {
    child.kill(signal);
  } catch {
    /* already gone */
  }
}
