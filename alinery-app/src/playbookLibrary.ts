// One library, one status vocabulary. Each playbook answers three questions: where it came from (origin), where it
// lives (range), and whether it matches the community copy (state). The Playbooks page reads only this.
import type { CommunityImportRow, CommunitySummary, DownloadStatusRow, PlaybookCandidate, PlaybookRef } from "./types";

export type Origin = { kind: "alinery" } | { kind: "mine" } | { kind: "download"; label: string; id: string };
export type Range = "All repos" | "This repo";
export type LinkState =
  | "builtin" // ships with Alinery
  | "broken" // the definition does not read
  | "yours" // yours, and whether it is published is not known (signed out, or the list failed)
  | "private" // yours, never published
  | "live" // your listing matches this file
  | "changed" // you saved after publishing
  | "remote" // your listing, with no copy on this machine
  | "downloaded" // a download whose listing is not checked yet
  | "synced" // a download, unedited and current
  | "edited" // a download you edited, nothing newer upstream
  | "update" // the author published a newer version
  | "diverged" // edited here, and updated upstream
  | "withdrawn"; // the listing is gone

export type Tone = "dim" | "ok" | "act" | "warn" | "bad";

export type LibraryRow = {
  id: string;
  title: string;
  description: string;
  reference: PlaybookRef | null;
  candidate: PlaybookCandidate | null;
  origin: Origin;
  range: Range | null;
  state: LinkState;
  /** The listing you publish this as, matched by key. */
  publication: CommunitySummary | null;
  importRow: CommunityImportRow | null;
  download: DownloadStatusRow | null;
};

export const SIGNAL_STATES = new Set<LinkState>(["update", "changed", "diverged", "withdrawn"]);

export function rangeOf(reference: PlaybookRef): Range {
  return reference.scope === "repo" ? "This repo" : "All repos";
}

export function originLabel(origin: Origin): string {
  return origin.kind === "alinery" ? "Alinery" : origin.kind === "mine" ? "Mine" : `@${origin.label}`;
}

/** The status column's words and tone. */
export function statusOf(row: Pick<LibraryRow, "state" | "publication" | "importRow" | "download">): { label: string; tone: Tone } {
  const have = row.importRow?.importedVersion ?? row.download?.importedVersion;
  const remote = row.download?.remoteVersion;
  switch (row.state) {
    case "builtin":
      return { label: "Built in", tone: "dim" };
    case "broken":
      return { label: "Can't read", tone: "bad" };
    case "yours":
      return { label: "Yours", tone: "dim" };
    case "private":
      return { label: "Not published", tone: "dim" };
    case "live":
      return { label: `Live · v${row.publication?.version}`, tone: "ok" };
    case "changed":
      return { label: "Changes not published", tone: "act" };
    case "remote":
      return { label: `Live · v${row.publication?.version} · not here`, tone: "dim" };
    case "downloaded":
      return { label: `v${have}`, tone: "dim" };
    case "synced":
      return { label: `v${have} · current`, tone: "ok" };
    case "edited":
      return { label: `Edited · v${have}`, tone: "warn" };
    case "update":
      return { label: `v${have} → v${remote}`, tone: "act" };
    case "diverged":
      return { label: "Edited · update waiting", tone: "warn" };
    case "withdrawn":
      return { label: "Withdrawn by author", tone: "bad" };
  }
}

type Inputs = {
  candidates: PlaybookCandidate[];
  /** The repository's download registry. */
  imports: CommunityImportRow[];
  /** What the community says about each download; null until checked. */
  downloads: DownloadStatusRow[] | null;
  /** Your publications; null when not known (signed out or not loaded). */
  mine: CommunitySummary[] | null;
  /** sha256 of each local playbook's saved source, by `scope/key`, to compare with a listing's body hash. */
  sourceHashes: Map<string, string>;
};

export function libraryRows({ candidates, imports, downloads, mine, sourceHashes }: Inputs): LibraryRow[] {
  const downloadById = new Map((downloads ?? []).map((row) => [row.id, row]));
  const rows: LibraryRow[] = candidates.map((candidate) => {
    const reference = candidate.source.reference;
    const id = `${reference.scope}/${reference.key}`; // playbookRefKey, without shared.tsx's window imports
    const base = {
      id,
      title: candidate.title || reference.key,
      description: candidate.description || "",
      reference,
      candidate,
      range: rangeOf(reference),
      publication: null,
      importRow: null,
      download: null,
    };
    if (reference.scope === "bundled") return { ...base, origin: { kind: "alinery" }, state: candidate.diagnostics.length ? "broken" : "builtin" };
    // ponytail: a download is always repo scope today (communityImports.ts), so the registry's local key names it.
    const importRow = reference.scope === "repo" ? imports.find((item) => item.localKey === reference.key) : undefined;
    if (importRow) {
      const download = downloadById.get(importRow.id) ?? null;
      const edited = download?.locallyEdited ?? importRow.locallyEdited ?? false;
      const state: LinkState = candidate.diagnostics.length
        ? "broken"
        : download?.remoteMissing
          ? "withdrawn"
          : download?.updateAvailable
            ? edited
              ? "diverged"
              : "update"
            : edited
              ? "edited"
              : download && !download.error
                ? "synced"
                : "downloaded";
      return { ...base, origin: { kind: "download", label: importRow.label, id: importRow.id }, state, importRow, download };
    }
    // ponytail: publications match by key until the publish records its listing id beside the file (plan phase 2).
    const publication = mine?.find((item) => item.playbookKey === reference.key) ?? null;
    const hash = sourceHashes.get(id);
    const state: LinkState = candidate.diagnostics.length
      ? "broken"
      : mine === null
        ? "yours"
        : !publication
          ? "private"
          : hash !== undefined && hash !== publication.bodySha256
            ? "changed"
            : "live";
    return { ...base, origin: { kind: "mine" }, state, publication };
  });
  // Your listings with no copy here, so republishing or downloading your own work starts from the same list.
  const localKeys = new Set(candidates.filter((candidate) => candidate.source.reference.scope !== "bundled").map((candidate) => candidate.source.reference.key));
  for (const publication of mine ?? []) {
    if (localKeys.has(publication.playbookKey) || imports.some((item) => item.id === publication.id)) continue;
    rows.push({
      id: `listing:${publication.id}`,
      title: publication.title || publication.playbookKey,
      description: publication.description,
      reference: null,
      candidate: null,
      origin: { kind: "mine" },
      range: null,
      state: "remote",
      publication,
      importRow: null,
      download: null,
    });
  }
  return rows;
}

/** Lowercase hex sha256 of the UTF-8 text, the way the library hashes a published body. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
