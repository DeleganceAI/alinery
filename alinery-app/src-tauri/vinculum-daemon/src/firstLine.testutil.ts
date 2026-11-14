// The first stdout line a test's fixture child prints, or a failure after `ms`: a fixture that never prints (a hung
// fixture, a mutated build) fails the test in seconds instead of blocking the run on an unbounded read.
export async function firstLine(child: Bun.Subprocess<"ignore" | "pipe", "pipe", "inherit" | "pipe">, ms = 10_000): Promise<string> {
  const reader = child.stdout.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    // No kill here (the signal gate keeps `.kill(` out of non-test files); every fixture ends itself after 60 s.
    timer = setTimeout(() => reject(new Error(`fixture printed nothing in ${ms} ms`)), ms);
  });
  try {
    return new TextDecoder().decode((await Promise.race([reader.read(), timeout])).value).trim();
  } finally {
    clearTimeout(timer);
  }
}
