// The one place the daemon runs the host's Info-ZIP `zip` and `unzip` (plan O11 b): no zip library in TypeScript, because
// a library that writes no zip64 caps an archive at 4 GiB or 65,535 entries, and the host's tool does not. Every spawn
// here has an argument vector, never a shell, so a file name is never parsed by one.
import { rmSync } from "node:fs";

export type ToolResult = { code: number; stdout: string; stderr: string };

/** What a missing tool says, with the hint the setup probe gives for git (D6): the person installs it where the daemon runs. */
function missing(tool: string): Error {
  return new Error(`${tool} is not installed on the machine this repository lives on; install it there (for example \`apt install ${tool}\` or \`brew install ${tool}\`) and try again`);
}

async function run(tool: "zip" | "unzip", args: string[], options: { cwd?: string; input?: string } = {}): Promise<ToolResult> {
  let child: Bun.Subprocess<"ignore" | "pipe", "pipe", "pipe">;
  try {
    child = Bun.spawn([tool, ...args], {
      cwd: options.cwd,
      stdin: options.input === undefined ? "ignore" : new Blob([options.input]),
      stdout: "pipe",
      stderr: "pipe",
    }) as never;
  } catch {
    throw missing(tool);
  }
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

const fail = (what: string, r: ToolResult) => new Error(`${what}: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}`);

/**
 * `zip -q -X -D -nw <archive> -@` with its cwd at `base` and `names` on stdin: each name is added as written, relative to
 * `base`, with no directory entries, no extra attributes and no wildcard handling. A name that has vanished since it was
 * listed is a warning, not a failure (a session's file moving while a backup runs is normal): zip exits 0 for it, and 12 or
 * 18 when nothing was left to add or a file could not be read, which is the same thing here.
 */
export async function zipAdd(archive: string, base: string, names: string[]): Promise<void> {
  if (names.length === 0) return;
  const r = await run("zip", ["-q", "-X", "-D", "-nw", archive, "-@"], { cwd: base, input: `${names.join("\n")}\n` });
  if (r.code !== 0 && r.code !== 12 && r.code !== 18) throw fail("zip", r);
}

/** `zip -q -j -X <archive> <file>`: the file at the archive's root, whatever directory it came from. */
export async function zipAddRoot(archive: string, file: string): Promise<void> {
  const r = await run("zip", ["-q", "-j", "-X", archive, file]);
  if (r.code !== 0) throw fail("zip", r);
}

/** One entry's bytes as text (`unzip -p`). */
export async function unzipText(archive: string, entry: string): Promise<string> {
  const r = await run("unzip", ["-p", archive, entry]);
  if (r.code !== 0) throw fail(`${archive}: ${entry}`, r);
  return r.stdout;
}

/** `unzip -Z1`: every entry name, one per line. */
export async function unzipNames(archive: string): Promise<string[]> {
  const r = await run("unzip", ["-Z1", archive]);
  if (r.code !== 0) throw fail(archive, r);
  return r.stdout.split("\n").filter((l) => l !== "");
}

/**
 * The entry types: the first mode character of each line of `unzip -Z` (`-` file, `d` directory, `l` symlink, ...). `-Z1`
 * prints names only and cannot show a symlink; `-Z` does, on Apple's unzip and on Debian's alike.
 */
export async function unzipTypes(archive: string): Promise<string[]> {
  const r = await run("unzip", ["-Z", archive]);
  if (r.code !== 0) throw fail(archive, r);
  return r.stdout.split("\n").flatMap((l) => (/^[-dlbcps?][-rwxsStTa]{6,9}\s/.test(l) ? [l[0] as string] : []));
}

/**
 * `unzip -q -o <archive> -x <skip> -d <into>`. Never `-:`: with it Debian's unzip writes `../x` outside the target.
 * Exit 1 is a warning (a name unzip rewrote), not a failure.
 */
export async function unzipInto(archive: string, into: string, skip: string): Promise<void> {
  const r = await run("unzip", ["-q", "-o", archive, "-x", skip, "-d", into]);
  if (r.code !== 0 && r.code !== 1) {
    rmSync(into, { recursive: true, force: true });
    throw fail(archive, r);
  }
}

/** The uncompressed size of each entry, in the order `unzipNames` lists them (the fourth column of `unzip -Z`). */
export async function unzipSizes(archive: string): Promise<number[]> {
  const r = await run("unzip", ["-Z", archive]);
  if (r.code !== 0) throw fail(archive, r);
  return r.stdout.split("\n").flatMap((l) => (/^[-dlbcps?][-rwxsStTa]{6,9}\s/.test(l) ? [Number(l.trim().split(/\s+/)[3])] : []));
}
