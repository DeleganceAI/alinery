// Test helper: a real Rust process (alinery-core's lockfile.rs, via examples/hold_lock.rs) holding an flock.
import { fileURLToPath } from "node:url";

const tauriDir = fileURLToPath(new URL("../../../", import.meta.url));
let built: string | undefined;

/** Build the holder (slow on a cold target dir). Call from a beforeAll with a long timeout. */
export function holderBinary(): string {
  if (built) return built;
  const result = Bun.spawnSync(["cargo", "build", "-p", "alinery-core", "--example", "hold_lock", "--message-format=json"], { cwd: tauriDir, stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error("cargo build of the hold_lock example failed");
  for (const line of result.stdout.toString().split("\n")) {
    if (!line.includes('"executable"')) continue;
    const executable = (JSON.parse(line) as { executable?: string | null }).executable;
    if (executable?.endsWith("hold_lock")) built = executable;
  }
  if (!built) throw new Error("hold_lock executable not reported by cargo");
  return built;
}

/** Start the holder on `path`; resolves once the Rust process holds the lock. `release()` ends it. */
export async function holdFromRust(path: string): Promise<{ release: () => Promise<void> }> {
  const child = Bun.spawn([holderBinary(), path], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  if (!first.startsWith("held")) throw new Error(`rust holder did not take the lock: ${first}`);
  return {
    release: async () => {
      child.stdin.end();
      await child.exited;
    },
  };
}
