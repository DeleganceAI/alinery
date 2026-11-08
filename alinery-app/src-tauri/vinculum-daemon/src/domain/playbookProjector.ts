// The playbook library's rows (plan S4.6): one `playbook/<scope>/<key>` row per definition the catalog lists, `playbook/_/picker`
// (the repository's preferences), `playbook/_/picker-global` (the ones a window with no repository uses) and `playbook/_/library`
// (what the scan could not read) and `playbook/_/community` (the import registry, S4.10). The library is three directories (the repository's two, the machine's one) and the compiled-in
// set, not one file per row, so the whole catalog is recomputed on a change and diffed against the keys it owned; the store drops
// an unchanged put. The feed says when to redo it; an RPC that wrote a file calls `refresh` itself, so its reply's cursor covers it.
import { create } from "@bufbuild/protobuf";
import { type Entity, EntitySchema } from "alinery-proto/alinery/v1/entities_pb";
import type { Store } from "../sync/store.ts";
import { registryRows } from "./communityImports.ts";
import { type Candidate, type Catalog, loadCatalog, loadPicker, type PickerPreferences, type Roots } from "./playbookLibrary.ts";
import type { DocDiagnostic } from "playbook-engine/src/playbook-md.ts";

export const playbookKey = (scope: string, key: string) => `playbook/${scope}/${key}`;
export const PICKER_KEY = "playbook/_/picker";
export const GLOBAL_PICKER_KEY = "playbook/_/picker-global";
export const LIBRARY_KEY = "playbook/_/library";
export const COMMUNITY_KEY = "playbook/_/community";

/** The paths (relative to `.alinery/`, as the watcher names them) whose change can change a row. */
export const LIBRARY_PREFIXES = ["playbooks/", "committed-playbooks/", "global-playbooks/"];
export const isLibraryPath = (rel: string) => LIBRARY_PREFIXES.some((p) => rel.startsWith(p));

const millis = (n: number | null) => (n === null ? undefined : BigInt(n));
export const diagnosticOf = (d: DocDiagnostic) => ({ code: d.code, message: d.message, line: d.line ?? undefined, field: d.field ?? undefined, severity: d.severity });
const refOf = (r: { scope: string; key: string }) => ({ scope: r.scope, key: r.key });

function candidateRow(c: Candidate): Entity {
  const ref = c.source.reference;
  return create(EntitySchema, {
    key: playbookKey(ref.scope, ref.key),
    value: {
      case: "playbook",
      value: {
        reference: refOf(ref),
        path: c.source.path ?? undefined,
        title: c.title ?? undefined,
        description: c.description ?? undefined,
        modifiedAtMs: millis(c.modified_at_ms),
        diagnostics: c.diagnostics.map(diagnosticOf),
      },
    },
  });
}

function pickerRow(key: string, preferences: PickerPreferences, error: string): Entity {
  return create(EntitySchema, {
    key,
    value: {
      case: "playbookPicker",
      value: {
        order: preferences.order.map(refOf),
        entries: preferences.entries.map((e) => ({
          reference: refOf(e.reference),
          preferred: e.preferred,
          hidden: e.hidden,
          collapsed: e.collapsed,
          badge: e.badge ?? undefined,
          color: e.color ?? undefined,
          lastImportedAtMs: millis(e.last_imported_at_ms),
        })),
        error,
      },
    },
  });
}

const EMPTY: PickerPreferences = { order: [], entries: [] };
const textOf = (e: unknown) => (e as Error)?.message ?? String(e);

export class PlaybookProjector {
  private owned = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly store: Store,
    private readonly roots: Roots,
    private readonly log: (line: string) => void = console.error,
    private readonly debounceMs = 50,
  ) {}

  /** The feed re-read `rel`: redo the rows soon if it is a library path. */
  changed(rel: string): void {
    if (!isLibraryPath(rel)) return;
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.refresh();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /** The rows as the files are now; one commit. */
  refresh(): void {
    try {
      const catalog: Catalog = loadCatalog(this.roots);
      const puts = catalog.candidates.map(candidateRow);
      const picker = (roots: Roots, key: string) => {
        try {
          return pickerRow(key, loadPicker(roots), "");
        } catch (e) {
          return pickerRow(key, EMPTY, textOf(e));
        }
      };
      puts.push(picker(this.roots, PICKER_KEY), picker({ ...this.roots, repoDir: "" }, GLOBAL_PICKER_KEY));
      // What the scan of the directories could not read; the picker's own refusal is on its row.
      puts.push(
        create(EntitySchema, {
          key: LIBRARY_KEY,
          value: { case: "playbookLibrary", value: { diagnostics: catalog.diagnostics.filter((d) => d.code !== "picker_preferences").map(diagnosticOf) } },
        }),
      );
      const community = registryRows(this.roots.repoDir);
      puts.push(
        create(EntitySchema, {
          key: COMMUNITY_KEY,
          value: {
            case: "playbookCommunity",
            value: {
              error: community.error,
              imports: community.rows.map((r) => ({
                id: r.id,
                label: r.label,
                playbookKey: r.playbook_key,
                localKey: r.local_key,
                importedVersion: BigInt(r.imported_version),
                localSha256: r.local_sha256,
                importedAt: r.imported_at,
                localMissing: r.local_missing,
                locallyEdited: r.locally_edited,
              })),
            },
          },
        }),
      );
      const keep = new Set(puts.map((e) => e.key));
      const gone = [...this.owned].filter((k) => !keep.has(k));
      this.owned = keep;
      this.store.commit(puts, gone);
    } catch (e) {
      this.log(`playbook library: ${textOf(e)}`);
    }
  }
}
