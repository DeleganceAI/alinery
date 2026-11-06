// Product-usage telemetry from the daemon (plan S4.1, O17 c), ported from alinery-core `telemetry.rs`: the
// consent rule, the record shape, the allowlists, the ingest URL and the basic auth. Events are a closed
// union, so a caller can never put a path, a name or free text on the wire. This is the only file in the
// daemon that builds an ingest request (`check-telemetry-privacy.sh`). Events move here from the Rust
// `TelemetryEvent` as the session that owns their command lands: `SettingsChange` (S4.1), the draft and archive events (S4.3), the git events (S4.7).
import { type Global, parseGlobal } from "../domain/settings.ts";
import { readFileSync } from "node:fs";

// The write-only ingest credential of telemetry.rs, shipped as it is (O25 b): a Caddy proxy in front of
// OpenObserve lets it do exactly POST /api/default/alinery_usage/_json, so the network layer is the boundary.
const ORG = "default";
const STREAM = "alinery_usage";
const INGEST_USER = "saga-ingest@example.com";
const INGEST_PASSWORD = "XYXXx1fbYiiCgDlp";
export const SEND_TIMEOUT_MS = 2000;

const HARNESSES = ["omp", "vinculum", "no-harness"];
const PLAYBOOKS = ["superdevelop", "one-shot", "free-form", "review", "bug-hunting"];
const PHASES = [
  "research-questions",
  "research",
  "design",
  "structure",
  "tdd",
  "implementation",
  "pr",
  "review-context",
  "review-checks",
  "review-findings",
  "review-response",
  "rca",
  "solutions",
];
const allowlistedOrCustom = (raw: string, allow: string[]) => (allow.includes(raw) ? raw : "custom");
export const sanitizeHarness = (raw: string) => allowlistedOrCustom(raw, HARNESSES);
export const sanitizePlaybook = (raw: string) => allowlistedOrCustom(raw, PLAYBOOKS);
export const sanitizePhase = (raw: string) => (raw === "" ? "" : allowlistedOrCustom(raw, PHASES));

export type TelemetrySource = "app" | "mcp" | "alineryd";
export type SettingsChangeScope = "global" | "repo" | "appearance" | "harnesses";
export type TelemetryEvent =
  | { event: "settings.change"; source: TelemetrySource; scope: SettingsChangeScope }
  | { event: "task.draft_create"; source: TelemetrySource; hasWorktree: boolean; playbook: string; taskId: string }
  | { event: "task.draft_delete"; source: TelemetrySource; taskId: string }
  | { event: "task.archive"; source: TelemetrySource; taskId: string }
  | { event: "session.archive"; source: TelemetrySource; killedLive: boolean; sessionId: string; taskId: string }
  | { event: "session.kill"; source: TelemetrySource; sessionId: string; taskId: string }
  | { event: "git.commit"; source: TelemetrySource }
  | { event: "git.push"; source: TelemetrySource }
  | { event: "git.worktree_remove"; source: TelemetrySource }
  | { event: "artifact.comment_add"; source: TelemetrySource }
  | { event: "artifact.review_send"; source: TelemetrySource }
  | { event: "artifact.review_handoff"; source: TelemetrySource; targetPhase: string; harness: string };

/** telemetry.rs `insert_id`: the opaque per-task id goes on the wire when there is one. */
const withId = (taskId: string) => (taskId ? { task_id: taskId } : {});

function eventProps(e: TelemetryEvent): Record<string, unknown> {
  switch (e.event) {
    case "settings.change":
      return { source: e.source, scope: e.scope };
    case "task.draft_create":
      return { source: e.source, has_worktree: e.hasWorktree, playbook: sanitizePlaybook(e.playbook), ...withId(e.taskId) };
    case "task.draft_delete":
    case "task.archive":
      return { source: e.source, ...withId(e.taskId) };
    case "session.archive":
      return { source: e.source, killed_live: e.killedLive, ...(e.sessionId ? { session_id: e.sessionId } : {}), ...withId(e.taskId) };
    case "session.kill":
      return { source: e.source, ...(e.sessionId ? { session_id: e.sessionId } : {}), ...withId(e.taskId) };
    case "artifact.comment_add":
    case "artifact.review_send":
    case "git.commit":
    case "git.push":
    case "git.worktree_remove":
      return { source: e.source };
    case "artifact.review_handoff":
      return { source: e.source, target_phase: sanitizePhase(e.targetPhase), harness: sanitizeHarness(e.harness) };
  }
}

/** telemetry.rs `app_os`. */
const appOs = () => (process.platform === "darwin" ? "macos" : process.platform);

/** telemetry.rs `event_record`. `appVersion` is the app's `CARGO_PKG_VERSION`, which the app hands the daemon at start. */
export function eventRecord(e: TelemetryEvent, installId: string, appVersion: string) {
  return { event: e.event, app_version: appVersion, os: appOs(), anon_id: installId, props: eventProps(e) };
}

export const ingestUrl = (endpoint: string) => `${endpoint.replace(/\/+$/, "")}/api/${ORG}/${STREAM}/_json`;

type Prefs = Global["telemetry"];

/** telemetry.rs `consented`: nothing leaves the machine unless the user was asked, said yes, and an install id exists. */
export const consented = (p: Prefs) => p.enabled && p.prompted && p.installId !== "";

export type Sender = {
  /** Reads the consent from `app.toml` as it is now, so a change applies with no restart, and sends once. Never throws, never waits. */
  record(build: () => TelemetryEvent): void;
};

/**
 * One `fetch` per event with a 2 s timeout; any failure, an unreachable endpoint included, is dropped. No
 * queue and no retry, as in Rust today (telemetry.rs, the comment above `send`). The caller does not await
 * it, and `build` runs only once consent holds, so a user who declined pays for no reads.
 */
export function telemetrySender(appConfig: string, appVersion: string, fetchImpl: typeof fetch = fetch): Sender {
  return {
    record(build) {
      try {
        const global = parseGlobal(readFileSync(appConfig, "utf8"));
        if (!global || !consented(global.telemetry)) return;
        const prefs = global.telemetry;
        const body = JSON.stringify([eventRecord(build(), prefs.installId, appVersion)]);
        void fetchImpl(ingestUrl(prefs.endpoint), {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`${INGEST_USER}:${INGEST_PASSWORD}`).toString("base64")}` },
          body,
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        }).catch(() => {});
      } catch {
        /* a missing app.toml, or a send that threw: nothing is recorded */
      }
    },
  };
}
