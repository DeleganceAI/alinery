import type { CanvasEditMode, HostToolCall, OrbitronAgentAvailability, OrbitronAgentStatus } from "../types";

/**
 * The docked pane's width, in one place because three surfaces read it: the pane sizes
 * itself, the board's chrome steps aside by it, and the drag decides whether the pane is
 * still open. The minimum is the width the pane shipped at — narrower than that is not a
 * layout the product supports, it is how the user says "close this".
 *
 * `close` needs slack for the same reason a drag has a threshold: someone aiming for the
 * narrowest pane will overshoot by a few pixels, and a stray pixel must not throw away the
 * transcript. Past the slack the intent is unambiguous.
 */
export const AGENT_MIN_WIDTH = 320;
export const AGENT_CLOSE_SLACK = 48;
export const AGENT_MAX_FRACTION = 0.6;

export function resizeAgentPane(width: number, viewport: number): { width: number; close: boolean } {
  // A narrow window still gets the minimum: half a pane is worse than a crowded board.
  const max = Math.max(AGENT_MIN_WIDTH, Math.floor(viewport * AGENT_MAX_FRACTION));
  return {
    width: Math.max(AGENT_MIN_WIDTH, Math.min(max, Math.round(width))),
    close: width < AGENT_MIN_WIDTH - AGENT_CLOSE_SLACK,
  };
}

/**
 * Streaming text must not steal the scroll (DESIGN.md §Component behavior rules), so the
 * transcript follows the newest reply only while the reader is already at the bottom. The
 * slack absorbs sub-pixel scroll heights, which never land exactly on zero.
 */
export function atBottom(box: { scrollTop: number; clientHeight: number; scrollHeight: number }, slack = 24): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= slack;
}

export function statusLabel(status: OrbitronAgentStatus): string {
  switch (status) {
    case "idle":
      return "Idle";
    // Paired with a Thinking Orb, so the label is the static half of the pair and carries no
    // ellipsis of its own (DESIGN.md §Loading).
    case "thinking":
      return "Thinking";
    case "updatingBoard":
      return "Updating board";
    case "compacting":
      return "Compacting";
  }
}

export function canSend(input: { status: OrbitronAgentStatus; gate: "omp" | "key" | null }): boolean {
  if (input.gate) return false;
  return input.status !== "compacting";
}

export function gateKind(a: Pick<OrbitronAgentAvailability, "ompFound" | "keyPresent">): "omp" | "key" | null {
  if (!a.ompFound) return "omp";
  if (!a.keyPresent) return "key";
  return null;
}

export function summarizeHostTool(call: HostToolCall): string {
  switch (call.toolName) {
    case "board_get":
      return "Read board";
    case "concept_create":
      return `Create concept "${call.arguments.name}"`;
    case "concept_rename":
      return `Rename concept to "${call.arguments.name}"`;
    case "concept_delete":
      return `Delete concept ${call.arguments.id}`;
    case "task_place":
      return call.arguments.conceptId ? `Place ${call.arguments.slug}` : `Place ${call.arguments.slug} (free-float)`;
    case "task_unplace":
      return `Unplace ${call.arguments.slug}`;
    case "task_tag":
      return `Tag ${call.arguments.slug}`;
    case "task_untag":
      return `Untag ${call.arguments.slug}`;
    case "relation_upsert":
      return `Relate ${call.arguments.a} → ${call.arguments.b} (${call.arguments.kind})`;
    case "relation_delete":
      return `Unrelate ${call.arguments.a} → ${call.arguments.b}`;
    case "board_arrange":
      return "Arrange board";
  }
}

const HOST_TOOLS: Record<string, true> = {
  board_get: true,
  concept_create: true,
  concept_rename: true,
  concept_delete: true,
  task_place: true,
  task_unplace: true,
  task_tag: true,
  task_untag: true,
  relation_upsert: true,
  relation_delete: true,
  board_arrange: true,
};

export function parseHostToolCall(toolName: string, args: unknown): HostToolCall | null {
  if (!HOST_TOOLS[toolName]) return null;
  return { toolName, arguments: args ?? {} } as HostToolCall;
}

export const MODE_LABELS: { mode: CanvasEditMode; label: string }[] = [
  { mode: "autoEdit", label: "Auto Edit" },
  { mode: "requestApproval", label: "Request Approval" },
  { mode: "readOnly", label: "Read Only" },
];
