import { CircleQuestionMark, CircleX, Hand, MessageSquareDot } from "lucide-react";
import { ThinkingOrb } from "thinking-orbs";

// Alinery's one session-activity orb (DESIGN.md §Loading). `solving` carries a
// scramble-then-resolve beat, and a board can show a dozen of these at once, so
// both rates stay well under the package default to keep a busy board calm
// rather than twitching in peripheral vision.
export const ORB_STATE = "solving" as const;
// Warm-up and every non-session wait: nothing is progressing yet, so it idles.
export const ORB_SPEED = 0.35;
// Work is actually moving. Faster than the warm-up rate, so a session doing
// something reads as livelier than one still connecting.
export const ORB_SPEED_RUNNING = 0.5;

// Session-activity indicators. Running states use the Thinking Orb — the app's
// single repeating-animation language (DESIGN.md §Motion). The orb canvas is
// decorative beside its labelled parent, so it is aria-hidden; it follows the
// app theme via the root data-theme attribute and renders a static frame under
// prefers-reduced-motion (both built into the package).
//
// `running` is the only knob: the state never varies, and callers pick a rate
// by what is true, not by passing a number. `false` is the warm-up case —
// starting or loading, where the session is not doing anything yet.
export function RunningIndicator({ running = true }: { running?: boolean } = {}) {
  return <ThinkingOrb state={ORB_STATE} speed={running ? ORB_SPEED_RUNNING : ORB_SPEED} size={20} className="ind-orb" aria-hidden="true" />;
}

// Glyphs for the wait and exception states (DESIGN.md §Session indicators).
// Each is decorative beside its always-visible label, so it is aria-hidden and
// inherits color from the badge; size comes from `.statusdot-badge svg` so the
// UI scale applies. Stroke tracks label weight in StateIcon.
const STATE_ICON = {
  waiting_for_input: MessageSquareDot,
  waiting_for_approval: Hand,
  failed: CircleX,
  unknown: CircleQuestionMark,
} as const;

export type BadgeState = keyof typeof STATE_ICON;

export function StateIcon({ state }: { state: BadgeState }) {
  const Icon = STATE_ICON[state];
  // Stroke follows the label's weight (DESIGN.md §Iconography): 2 beside the
  // semibold states, 1.5 beside muted `unknown`, which sits at regular weight.
  return <Icon strokeWidth={state === "unknown" ? 1.5 : 2} aria-hidden="true" />;
}

// Finished-but-unseen marker: a static dot (never an orb — DESIGN.md forbids
// orbs for idle/waiting states). Colored --warning: it flags work awaiting review.
export function IdleDot() {
  return (
    <svg className="ind ind-dot" viewBox="0 0 10 10" aria-hidden="true">
      <circle cx="5" cy="5" r="5" />
    </svg>
  );
}
