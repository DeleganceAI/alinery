import { beforeEach, expect, it, vi } from "vitest";
import { importGithubIssue } from "./imports";

const mocks = vi.hoisted(() => ({ importGithubForRepo: vi.fn(), originUrlForRepo: vi.fn(), readRepoSettings: vi.fn() }));
vi.mock("../ipc", () => ({ importGithubForRepo: mocks.importGithubForRepo }));
vi.mock("./git", () => ({ originUrlForRepo: mocks.originUrlForRepo }));
vi.mock("./settings", () => ({ readRepoSettings: mocks.readRepoSettings }));

const issue = { reference: "acme/widgets#7", title: "T", description: "D" };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.importGithubForRepo.mockResolvedValue(issue);
});

it("sends the repository's origin and its own token override with the request", async () => {
  mocks.originUrlForRepo.mockResolvedValue("https://github.com/acme/widgets.git");
  mocks.readRepoSettings.mockResolvedValue({ overrides: { github: { token: "repo-token" } } });
  await expect(importGithubIssue("alinery+ssh://box/srv/widgets", "#7")).resolves.toEqual(issue);
  expect(mocks.originUrlForRepo).toHaveBeenCalledWith("alinery+ssh://box/srv/widgets");
  expect(mocks.importGithubForRepo).toHaveBeenCalledWith("alinery+ssh://box/srv/widgets", "#7", "https://github.com/acme/widgets.git", "repo-token");
});

it("sends null for a repository with no origin and no override, so the global token applies", async () => {
  mocks.originUrlForRepo.mockResolvedValue(null);
  mocks.readRepoSettings.mockResolvedValue({ overrides: { github: { token: null } } });
  await importGithubIssue("/repo", "acme/widgets#7");
  expect(mocks.importGithubForRepo).toHaveBeenCalledWith("/repo", "acme/widgets#7", null, null);
});

it("keeps a blank override blank: it is a deliberate value, not 'none'", async () => {
  mocks.originUrlForRepo.mockResolvedValue(null);
  mocks.readRepoSettings.mockResolvedValue({ overrides: { github: { token: "" } } });
  await importGithubIssue("/repo", "acme/widgets#7");
  expect(mocks.importGithubForRepo).toHaveBeenCalledWith("/repo", "acme/widgets#7", null, "");
});

it("does not send the request when the daemon cannot answer", async () => {
  mocks.originUrlForRepo.mockRejectedValue(new Error("the repository's daemon is not reachable"));
  mocks.readRepoSettings.mockResolvedValue({ overrides: { github: { token: null } } });
  await expect(importGithubIssue("/repo", "#7")).rejects.toThrow("not reachable");
  expect(mocks.importGithubForRepo).not.toHaveBeenCalled();
});
