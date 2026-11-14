// One library, one status vocabulary. Each playbook answers three questions: where it came from (origin), where it
// lives (range), and whether it matches the community copy (state). The Playbooks page reads only this.
import type { CommunityImportRow, CommunitySummary, DownloadStatusRow, PlaybookCandidate, PlaybookRef, PublicationLink } from "./types";

export type Origin = { kind: "alinery" } | { kind: "mine" } | { kind: "team" } | { kind: "download"; label: string; id: string };
export type Range = "All repos" | "This repo";
export type LinkState =
  | "builtin" // ships with Alinery
  | "team" // committed in the repository's alinery/playbooks, changed through git
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
  /** The listing you publish this as: linked when you published it, else matched by key. */
  publication: CommunitySummary | null;
  importRow: CommunityImportRow | null;
  download: DownloadStatusRow | null;
};

export const SIGNAL_STATES = new Set<LinkState>(["update", "changed", "diverged", "withdrawn"]);

export function rangeOf(reference: PlaybookRef): Range {
  return reference.scope === "repo" ? "This repo" : "All repos";
}

export function originLabel(origin: Origin): string {
  return origin.kind === "alinery" ? "Alinery" : origin.kind === "mine" ? "Mine" : origin.kind === "team" ? "Team" : `@${origin.label}`;
}

/** The status column's words and tone. */
export function statusOf(row: Pick<LibraryRow, "state" | "publication" | "importRow" | "download">): { label: string; tone: Tone } {
  const have = row.importRow?.importedVersion ?? row.download?.importedVersion;
  const remote = row.download?.remoteVersion;
  switch (row.state) {
    case "builtin":
      return { label: "Built in", tone: "dim" };
    case "team":
      return { label: "Team · read-only", tone: "dim" };
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
  /** Which local playbook each of your listings was published from. */
  published: PublicationLink[];
};

// ponytail: a committed playbook is told by its path; a repository that itself sits under some `alinery/playbooks/` would read as Team.
const isTeam = (candidate: PlaybookCandidate) => candidate.source.reference.scope === "repo" && !!candidate.source.path?.includes("/alinery/playbooks/");

export function libraryRows({ candidates, imports, downloads, mine, published }: Inputs): LibraryRow[] {
  const downloadById = new Map((downloads ?? []).map((row) => [row.id, row]));
  const linked = new Set(published.map((link) => link.id));
  const used = new Set<string>();
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
    if (isTeam(candidate)) return { ...base, origin: { kind: "team" }, state: candidate.diagnostics.length ? "broken" : "team" };
    const importRow = imports.find((item) => item.localKey === reference.key && (item.localScope ?? "repo") === reference.scope);
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
    // A listing published before links were recorded matches by key, and only while no other copy is linked to it.
    const link = published.find((item) => item.reference.scope === reference.scope && item.reference.key === reference.key);
    const publication =
      (link ? mine?.find((item) => item.id === link.id) : mine?.find((item) => item.playbookKey === reference.key && !linked.has(item.id) && !used.has(item.id))) ?? null;
    if (publication) used.add(publication.id);
    const hash = candidate.body_sha256;
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
  for (const publication of mine ?? []) {
    if (used.has(publication.id) || imports.some((item) => item.id === publication.id)) continue;
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

/** `at` is the line's place in the diff, a stable key for rendering. */
export type DiffLine = { at: number; kind: "same" | "del" | "add"; text: string };

/** Line diff of `before` → `after` by longest common subsequence: `del` only in before, `add` only in after.
 * ponytail: O(lines²) memory; a 256 KiB playbook is a few thousand lines, so a Myers diff waits until that hurts. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) lcs[i * width + j] = a[i] === b[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const at = out.length;
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ at, kind: "same", text: a[i] });
      i++;
      j++;
    } else if (i < a.length && (j === b.length || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) out.push({ at, kind: "del", text: a[i++] });
    else out.push({ at, kind: "add", text: b[j++] });
  }
  return out;
}
