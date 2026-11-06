// The GitHub issue import (plan S4.10). The request goes out from this machine with this machine's credentials, whichever machine the
// repository is on; the two facts that live with the repository come from its daemon: the `origin` URL a bare `#123` resolves against,
// and the repository's own GitHub token override (null: it has none, so the global token applies).
import * as ipc from "../ipc";
import type { GitHubIssue } from "../types";
import { originUrlForRepo } from "./git";
import { readRepoSettings } from "./settings";

export async function importGithubIssue(repo: string, reference: string): Promise<GitHubIssue> {
  const [originUrl, settings] = await Promise.all([originUrlForRepo(repo), readRepoSettings(repo)]);
  return ipc.importGithubForRepo(repo, reference, originUrl, settings.overrides.github?.token ?? null);
}
