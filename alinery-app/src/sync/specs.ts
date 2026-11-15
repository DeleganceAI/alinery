// The repository's requirement files (`specs/requirements.md`, `specs/tooling.md`, `specs/architecture.md`): the daemon's
// SettingsService.ReadSpecs and WriteSpec. The read is the working tree, so a file being edited shows as it is; whether
// HEAD holds the same text is `committed`. A write creates or replaces one file and never commits.
import { createClient } from "@connectrpc/connect";
import { SettingsService } from "alinery-proto/alinery/v1/settings_pb";
import { daemonTransport } from "../daemon/transport";
import { call } from "./hostCall";
import { newMutationMeta } from "./mutation";

export type SpecFile = { name: string; present: boolean; text: string; committed: boolean; tooLarge: boolean };
export type Specs = { files: SpecFile[]; maxChars: number };

const settings = (repo: string) => createClient(SettingsService, daemonTransport(repo));

export async function readSpecs(repo: string): Promise<Specs> {
  const r = await call(() => settings(repo).readSpecs({}));
  return { files: r.files.map((f) => ({ name: f.name, present: f.present, text: f.text, committed: f.committed, tooLarge: f.tooLarge })), maxChars: r.maxChars };
}

export async function writeSpec(repo: string, name: string, text: string): Promise<void> {
  await call(() => settings(repo).writeSpec({ meta: newMutationMeta(), name, text }));
}
