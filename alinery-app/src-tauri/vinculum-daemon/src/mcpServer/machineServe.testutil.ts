// Runs a machine MCP for a test at a chosen protocol: `bun machineServe.testutil.ts <dir> <protocol> [idleMs]`.
import { machinePaths, serveMachine } from "./machine.ts";

const [dir, protocol, idle] = process.argv.slice(2);
process.exit(await serveMachine({ paths: machinePaths(dir), protocol: Number(protocol), build: "test-build", idleMs: Number(idle) || undefined }));
