import type { ArtifactComment } from "./ArtifactMarkdown";
import type { SharedArtifactRow, SharedCommentRow, SharedTaskRow, TeamShareDetail } from "./types";

export type SharedTask = {
  slug: string;
  name: string;
  branch: string;
  playbook: string;
  archived: boolean;
  draft: boolean;
  /** Epoch seconds, as `BoardTask` keeps them. */
  created: number;
  updated: number;
  artifacts: SharedArtifactRow[];
  commentCount: number;
};

type TomlScalar = string | number | boolean;

/** The scalar keys of task.md, by `section.key` (top-level keys have no section). Arrays and tables are left out. */
function tomlScalars(text: string): Map<string, TomlScalar> {
  const out = new Map<string, TomlScalar>();
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const header = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (header) {
      section = header[1];
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!pair) continue;
    const key = section ? `${section}.${pair[1]}` : pair[1];
    const value = pair[2].trim();
    if (value.startsWith('"')) {
      try {
        out.set(key, JSON.parse(value) as string);
      } catch {
        // A string this parser cannot read leaves the field at its default.
      }
    } else if (value === "true" || value === "false") {
      out.set(key, value === "true");
    } else if (/^-?\d+$/.test(value)) {
      out.set(key, Number(value));
    }
  }
  return out;
}

const seconds = (iso: string | undefined) => {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
};

export function sharedTasks(detail: TeamShareDetail): SharedTask[] {
  return detail.tasks
    .filter((row): row is SharedTaskRow & { task_slug: string } => Boolean(row.task_slug))
    .map((row) => {
      const fields = tomlScalars(row.body ?? "");
      const text = (key: string) => {
        const value = fields.get(key);
        return typeof value === "string" ? value : "";
      };
      const artifacts = detail.artifacts
        .filter((artifact) => artifact.task_slug === row.task_slug && artifact.filename)
        .sort((a, b) => (a.filename ?? "").localeCompare(b.filename ?? ""));
      const created = fields.get("created");
      const updated = Math.max(seconds(row.updated_at), ...artifacts.map((artifact) => seconds(artifact.updated_at)));
      return {
        slug: row.task_slug,
        name: text("name") || row.task_slug,
        branch: text("branch"),
        playbook: text("playbook_ref.key") || text("playbook") || "Free-form",
        archived: fields.get("archived") === true,
        draft: fields.get("draft") === true,
        created: typeof created === "number" ? created : 0,
        updated,
        artifacts,
        commentCount: detail.comments.filter((comment) => comment.task_slug === row.task_slug).length,
      };
    });
}

/** A shared comment in the shape `ArtifactMarkdown` pins to a block. */
export function sharedArtifactComments(rows: SharedCommentRow[], taskSlug: string, filename: string): ArtifactComment[] {
  return rows
    .filter((row) => row.task_slug === taskSlug && row.filename === filename && row.id)
    .map((row) => ({
      id: row.id ?? "",
      artifact: filename,
      anchor_id: row.anchor_id ?? "",
      anchor_kind: row.anchor_kind ?? "",
      anchor_label: row.anchor_label ?? "",
      anchor_excerpt: row.anchor_excerpt ?? "",
      line_start: row.line_start ?? 0,
      line_end: row.line_end ?? 0,
      body: row.body ?? "",
      author: row.author_email ?? null,
      created_at_ms: row.created_at ? Date.parse(row.created_at) || 0 : 0,
    }));
}
