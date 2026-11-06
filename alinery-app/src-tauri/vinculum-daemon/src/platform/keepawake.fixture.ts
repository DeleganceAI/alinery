// A stand-in daemon for keepawake.test.ts: holds the keep-awake child, prints its pid, then waits to be killed.
import { KeepAwake, holdCommand } from "./keepawake.ts";

const [appConfig, mode] = process.argv.slice(2);
const hold = new KeepAwake({
  appConfig,
  liveSessions: () => 1,
  // "cat" exercises the Linux mechanism (a stdin pipe the daemon holds) on any platform; "real" is this platform's own tool.
  command: mode === "real" ? undefined : () => ["/bin/cat"],
});
hold.start();
await new Promise((resolve) => setTimeout(resolve, 300));
// Another child, spawned after the hold, as a session's shell would be: it must not keep the hold's pipe open.
Bun.spawn(["/bin/sleep", "60"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
console.log(JSON.stringify({ pid: process.pid, hold: hold.holdPid, command: mode === "real" ? holdCommand(process.platform, process.pid) : null }));
await new Promise((resolve) => setTimeout(resolve, 60_000));
