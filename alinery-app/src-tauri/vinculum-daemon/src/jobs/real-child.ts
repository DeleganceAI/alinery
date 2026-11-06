// The real job child, as a script a test can start: `bun real-child.ts <kind>`. In the daemon the same call sits behind `--job` in main.ts.
import { runJobChild } from "./child.ts";

process.exit(await runJobChild(process.argv[2] ?? ""));
