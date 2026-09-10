// Which button a confirm dialog hands the keyboard to. Pure and React-free so it can be
// unit-tested without a DOM: the rule it encodes is a safety property, not a style choice.
//
// Enter on the focused button accepts it. Focusing the destructive choice therefore made
// an accidental double-Enter enough to kill sessions or overwrite storage — the dialog
// rendered correctly and still did the wrong thing. Safe-by-default focus is the fix;
// accepting a destructive action must cost a deliberate click or an explicit Tab.

export type ConfirmChoice = {
  /** returned by askConfirm when this button is clicked */
  key: string;
  label: string;
  tone?: "danger" | "ghost";
};

/** The focus-relevant slice of a ConfirmRequest. */
export type FocusableRequest = {
  /** Left-to-right buttons. Defaults to a danger Confirm + ghost Cancel. */
  choices?: ConfirmChoice[];
  /** Returned on Esc, scrim click and ✕. Defaults to "cancel". */
  cancelKey?: string;
  /**
   * Which choice receives initial focus (Enter). Defaults to `cancelKey` so destructive
   * confirms never auto-accept. Multi-choice dialogs (quit) set this to leave-running,
   * never "close all".
   */
  defaultKey?: string;
};

export const DEFAULT_CHOICES: ConfirmChoice[] = [
  { key: "confirm", label: "Confirm", tone: "danger" },
  { key: "cancel", label: "Cancel", tone: "ghost" },
];

/**
 * Which choice key receives autoFocus, in falling order of preference:
 * an explicit `defaultKey` that exists, the cancel choice, the last non-danger choice,
 * and only as a last resort the final button. A danger button is never chosen while any
 * safe alternative is on screen.
 */
export function defaultFocusKey(req: FocusableRequest): string {
  const cancelKey = req.cancelKey ?? "cancel";
  const choices = req.choices ?? DEFAULT_CHOICES;
  if (req.defaultKey && choices.some((c) => c.key === req.defaultKey)) {
    return req.defaultKey;
  }
  if (choices.some((c) => c.key === cancelKey)) {
    return cancelKey;
  }
  // Prefer last non-danger (safe), else last choice.
  for (let i = choices.length - 1; i >= 0; i--) {
    if (choices[i].tone !== "danger") return choices[i].key;
  }
  return choices[choices.length - 1]?.key ?? cancelKey;
}
