import { Check, ChevronRight, X } from "lucide-react";
import { memo, type ReactNode, useEffect, useState } from "react";
import { formatDuration } from "../chat/format";
import { countsAsStep, isLiveWork } from "../chat/journalRows";
import type { ChatEntry } from "../chat/types";

/** One unit of work: a tool call with the result that answered it, or a thought, or a subagent row. */
type Step = { entry: ChatEntry; result?: Extract<ChatEntry, { type: "tool_result" }> };

function stepsOf(entries: ChatEntry[]): Step[] {
  const steps: Step[] = [];
  // Results arrive in call order and may only be named "tool", so each answers the earliest call still waiting. A queue
  // keeps that linear: the live strip of a long run re-renders on every token.
  const waiting: Step[] = [];
  let next = 0;
  for (const entry of entries) {
    const step: Step = { entry };
    if (entry.type === "tool_result" && next < waiting.length) {
      waiting[next++].result = entry;
      continue;
    }
    steps.push(step);
    if (entry.type === "tool_call") waiting.push(step);
  }
  return steps;
}

/** A shell call reads best as the command it ran; everything else by its target, then its raw arguments. */
function callLine(entry: Extract<ChatEntry, { type: "tool_call" }>): string {
  try {
    const args: unknown = entry.args ? JSON.parse(entry.args) : null;
    if (args && typeof args === "object" && "command" in args && typeof args.command === "string") return `$ ${args.command}`;
  } catch {
    // Not JSON: fall through to the target or the raw text.
  }
  return entry.target || entry.args || "";
}

function stepKind(entry: ChatEntry): string {
  if (entry.actor.kind === "subagent") return entry.actor.name;
  if (entry.type === "tool_call" || entry.type === "tool_result") return entry.tool;
  if (entry.type === "thinking" || entry.type === "redacted_thinking") return "think";
  if (entry.type === "subagent_status") return entry.agent;
  return entry.type;
}

function stepLine(entry: ChatEntry): string {
  switch (entry.type) {
    case "tool_call":
      return callLine(entry);
    case "tool_result":
      return entry.text.split("\n")[0] ?? "";
    case "thinking":
      return entry.text.trim().split("\n")[0] ?? "";
    case "redacted_thinking":
      return "redacted";
    case "subagent_status":
      return `${entry.status} · ${entry.summary}`;
    case "text":
    case "harness":
      return entry.text.split("\n")[0] ?? "";
    default:
      return "";
  }
}

function stepBody(step: Step, live: boolean): ReactNode {
  const { entry, result } = step;
  if (entry.type === "thinking") {
    return (
      <pre className="chat-step-out chat-step-thought">
        {entry.text}
        {live ? <span className="chat-caret" aria-hidden /> : null}
      </pre>
    );
  }
  if (entry.type === "tool_call") {
    const parts = [entry.args && !entry.target && !callLine(entry).startsWith("$ ") ? entry.args : "", entry.detail ?? "", result?.text ?? ""].filter(Boolean);
    return parts.length > 0 ? <pre className="chat-step-out">{parts.join("\n\n")}</pre> : null;
  }
  if (entry.type === "tool_result" || entry.type === "text" || entry.type === "harness") return <pre className="chat-step-out">{entry.text}</pre>;
  return null;
}

function stepFailed(entry: ChatEntry) {
  return (entry.type === "tool_call" && (entry.status === "error" || entry.status === "denied")) || (entry.type === "subagent_status" && entry.status === "failed");
}

function StepRow({ step, defaultOpen }: { step: Step; defaultOpen: boolean }) {
  const live = isLiveWork(step.entry);
  const [open, setOpen] = useState(live || defaultOpen);
  useEffect(() => {
    if (live) setOpen(true);
  }, [live]);
  const body = open ? stepBody(step, live) : null;
  // An open thought shows its whole text below, so its one-line preview steps aside.
  const thoughtOpen = open && step.entry.type === "thinking";
  const expandable = step.entry.type !== "redacted_thinking";
  const ms = "durationMs" in step.entry ? step.entry.durationMs : undefined;
  return (
    <li className={`chat-step${stepFailed(step.entry) ? " failed" : ""}`}>
      <button type="button" className="chat-step-line" aria-expanded={expandable ? open : undefined} onClick={() => expandable && setOpen((v) => !v)}>
        <span className="chat-step-kind">{stepKind(step.entry)}</span>
        <span className={`chat-step-text${step.entry.type === "thinking" ? " thought" : ""}`}>{thoughtOpen ? "" : stepLine(step.entry)}</span>
        <span className="chat-step-time">{ms != null ? formatDuration(ms) : ""}</span>
        <span className="chat-step-mark" aria-hidden>
          {stepFailed(step.entry) ? <X size={12} /> : live ? null : step.entry.type === "tool_call" ? <Check size={12} /> : null}
        </span>
      </button>
      {body}
    </li>
  );
}

/**
 * A run of agent work as one line: how many steps, which tools, how long, and whether any failed. Open, each step is one
 * row and shows its output on a click. Nothing below the line is built while it is closed: tool output is most of a
 * journal. A live run opens itself and closes when it ends, unless the reader's settings keep work open.
 */
function ChatWorkStripImpl({
  entries,
  live,
  defaultOpen,
  collapseWhenDone,
  stepOpen,
}: {
  entries: ChatEntry[];
  live: boolean;
  defaultOpen: boolean;
  /** The Chat setting that folds thinking away once it finishes, applied to the whole run. */
  collapseWhenDone: boolean;
  stepOpen: (entry: ChatEntry) => boolean;
}) {
  const [open, setOpen] = useState(live || defaultOpen);
  useEffect(() => {
    if (live) setOpen(true);
    else if (collapseWhenDone) setOpen(defaultOpen);
  }, [live, defaultOpen, collapseWhenDone]);

  const steps = stepsOf(entries);
  const count = entries.filter(countsAsStep).length;
  const tools = new Map<string, number>();
  let thoughts = 0;
  let failed = 0;
  let ms = 0;
  for (const { entry } of steps) {
    if (entry.type === "tool_call") tools.set(entry.tool, (tools.get(entry.tool) ?? 0) + 1);
    if (entry.type === "thinking" || entry.type === "redacted_thinking") thoughts++;
    if (stepFailed(entry)) failed++;
    if ("durationMs" in entry && entry.durationMs != null) ms += entry.durationMs;
  }
  const current = live ? [...steps].reverse().find((s) => isLiveWork(s.entry)) : undefined;
  const counted = `${count} ${count === 1 ? "step" : "steps"}`;
  const toolLabels = [...tools].map(([tool, n]) => (n > 1 ? `${tool} ×${n}` : tool));
  const summary = [live ? "running" : "", counted, ...toolLabels, thoughts ? "thinking" : "", ms ? formatDuration(ms) : "", failed ? `${failed} failed` : ""]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className={`chat-work${live ? " live" : ""}`}>
      <button type="button" className="chat-work-line" aria-expanded={open} aria-label={summary} onClick={() => setOpen((v) => !v)}>
        <ChevronRight className="chat-work-chev" size={13} aria-hidden />
        {live ? <span className="chat-work-live">running</span> : null}
        <span className="chat-work-count">{counted}</span>
        {toolLabels.map((label) => (
          <span key={label} className="chat-work-tool">
            {label}
          </span>
        ))}
        {thoughts ? <span className="chat-work-tool">thinking</span> : null}
        {current ? <span className="chat-work-now">{stepLine(current.entry)}</span> : null}
        {ms ? <span className="chat-work-time">{formatDuration(ms)}</span> : null}
        {failed ? <span className="chat-work-failed">{failed} failed</span> : !live ? <Check className="chat-work-ok" size={12} aria-hidden /> : null}
      </button>
      {open ? (
        <ol className="chat-steps">
          {steps.map((step) => (
            <StepRow key={step.entry.id} step={step} defaultOpen={stepOpen(step.entry)} />
          ))}
        </ol>
      ) : null}
    </div>
  );
}

type StripProps = Parameters<typeof ChatWorkStripImpl>[0];

/** `journalItems` regroups on every streaming delta, so each strip gets a fresh array holding the same entries. Compare
 * the entries, not the array, or every strip in the journal re-renders on every token. */
function sameStrip(a: StripProps, b: StripProps): boolean {
  if (a.live !== b.live || a.defaultOpen !== b.defaultOpen || a.collapseWhenDone !== b.collapseWhenDone || a.stepOpen !== b.stepOpen) return false;
  if (a.entries === b.entries) return true;
  return a.entries.length === b.entries.length && a.entries.every((entry, i) => entry === b.entries[i]);
}

export const ChatWorkStrip = memo(ChatWorkStripImpl, sameStrip);
