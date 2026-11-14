// A stand-in second daemon for ownership.test.ts: takes the fence, says so, and holds it until killed.
import { acquireRepoOwnership } from "./ownership.ts";

const [repo, lane, identity] = process.argv.slice(2);
try {
  await acquireRepoOwnership(repo, lane, identity);
  console.log("held");
  await new Promise((resolve) => setTimeout(resolve, 60_000));
} catch (error) {
  console.log(`refused ${(error as { code?: string }).code ?? "other"}`);
  process.exit(1);
}
