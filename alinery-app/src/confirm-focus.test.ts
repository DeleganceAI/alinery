import { describe, expect, it } from "vitest";
import { type ConfirmChoice, defaultFocusKey } from "./confirm-focus";

// Review finding 8: every destructive dialog focused its danger button, so Enter on a
// freshly-opened confirm accepted it. These assertions are the contract that Enter is
// never the destructive answer.
describe("defaultFocusKey", () => {
  // confirmDanger's shape: danger first (product convention), cancel second.
  const dangerChoices: ConfirmChoice[] = [
    { key: "confirm", label: "Delete everything", tone: "danger" },
    { key: "cancel", label: "Cancel", tone: "ghost" },
  ];

  it("focuses cancel on a destructive confirm, not the danger button", () => {
    expect(defaultFocusKey({ choices: dangerChoices, defaultKey: "cancel" })).toBe("cancel");
  });

  it("focuses cancel even when confirmDanger forgets to pass defaultKey", () => {
    expect(defaultFocusKey({ choices: dangerChoices })).toBe("cancel");
  });

  it("defaults to cancel for the default two-button dialog", () => {
    expect(defaultFocusKey({})).toBe("cancel");
  });

  // The quit dialog: leave-running is the documented default, "close all" kills sessions.
  it("focuses leave-running on the quit dialog, never close-all", () => {
    const quitChoices: ConfirmChoice[] = [
      { key: "leave", label: "Quit, leave sessions running" },
      { key: "stop", label: "Quit & close all repos", tone: "danger" },
      { key: "cancel", label: "Cancel", tone: "ghost" },
    ];
    expect(defaultFocusKey({ choices: quitChoices, defaultKey: "leave" })).toBe("leave");
  });

  // First-run telemetry consent: Enter must accept Don't share, never Share.
  it("focuses opt-out on the first-run telemetry dialog", () => {
    const telemetryChoices: ConfirmChoice[] = [
      { key: "keep", label: "Share anonymous usage" },
      { key: "opt-out", label: "Don't share", tone: "ghost" },
    ];
    expect(defaultFocusKey({ choices: telemetryChoices, defaultKey: "opt-out", cancelKey: "later" })).toBe("opt-out");
  });

  it("honours a custom cancelKey", () => {
    expect(
      defaultFocusKey({
        choices: [
          { key: "wipe", label: "Wipe", tone: "danger" },
          { key: "nope", label: "Back", tone: "ghost" },
        ],
        cancelKey: "nope",
      }),
    ).toBe("nope");
  });

  it("ignores a defaultKey that is not among the choices", () => {
    expect(defaultFocusKey({ choices: dangerChoices, defaultKey: "typo" })).toBe("cancel");
  });

  it("falls back to the last non-danger choice when there is no cancel", () => {
    expect(
      defaultFocusKey({
        choices: [
          { key: "purge", label: "Purge", tone: "danger" },
          { key: "later", label: "Later" },
        ],
      }),
    ).toBe("later");
  });

  // Degenerate: danger is the only button. Focus has nowhere safe to go, but the rule
  // above it must have been tried first — this is the documented last resort.
  it("only focuses a danger button when it is the sole choice", () => {
    expect(defaultFocusKey({ choices: [{ key: "boom", label: "Boom", tone: "danger" }] })).toBe("boom");
  });

  it("never focuses a danger choice while any safe one exists", () => {
    const cases: ConfirmChoice[][] = [
      [
        { key: "a", label: "A", tone: "danger" },
        { key: "b", label: "B", tone: "danger" },
        { key: "c", label: "C", tone: "ghost" },
      ],
      [
        { key: "x", label: "X" },
        { key: "y", label: "Y", tone: "danger" },
      ],
    ];
    for (const choices of cases) {
      const focused = choices.find((c) => c.key === defaultFocusKey({ choices }));
      expect(focused?.tone).not.toBe("danger");
    }
  });
});
