import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockIpc } from "./test/mockIpc";
import type { AccountSignOutResult, AccountStatus, DesktopCreditsView } from "./types";

const signedOut: AccountStatus = { signedIn: false, email: null, plan: null, paid: false, unavailable: false };
const signedIn: AccountStatus = { signedIn: true, email: "a@example.com", plan: "Founders Edition", paid: true, unavailable: false };
const signedOutRemote: AccountSignOutResult = { ...signedOut, remoteRevoked: true };
const signedOutLocal: AccountSignOutResult = { ...signedOut, remoteRevoked: false };

const mocks = vi.hoisted(() => ({
  accountStatus: vi.fn<() => Promise<AccountStatus>>(),
  accountRefresh: vi.fn<() => Promise<AccountStatus>>(),
  accountSignIn: vi.fn<() => Promise<AccountStatus>>(),
  accountCancelSignIn: vi.fn<() => Promise<void>>(),
  accountSignOut: vi.fn<() => Promise<AccountSignOutResult>>(),
  accountOpen: vi.fn<() => Promise<void>>(),
  accountCredits: vi.fn<() => Promise<DesktopCreditsView>>(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  onOpenSettings: vi.fn(),
}));

vi.mock("./ipc", () =>
  mockIpc({
    accountStatus: mocks.accountStatus,
    accountRefresh: mocks.accountRefresh,
    accountSignIn: mocks.accountSignIn,
    accountCancelSignIn: mocks.accountCancelSignIn,
    accountSignOut: mocks.accountSignOut,
    accountOpen: mocks.accountOpen,
    accountCredits: mocks.accountCredits,
  }),
);

vi.mock("./toast", () => ({
  toast: Object.assign(vi.fn(), {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: vi.fn(),
  }),
}));

import { AccountMenu } from "./AccountMenu";

function renderMenu() {
  return render(<AccountMenu onOpenSettings={mocks.onOpenSettings} />);
}

const creditsHidden: DesktopCreditsView = {
  visible: false,
  signedOut: false,
  plan: null,
  paid: false,
  balanceCents: null,
  cutoff: false,
  upsell: null,
  accountUrl: null,
  plansUrl: null,
};

beforeEach(() => {
  mocks.accountCredits.mockResolvedValue(creditsHidden);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("loading", () => {
  it("shows Checking account and does not start sign-in", async () => {
    mocks.accountStatus.mockReturnValue(new Promise(() => {}));
    renderMenu();

    const checking = screen.getByRole("button", { name: "Checking account" });
    expect(checking).toHaveProperty("disabled", true);
    fireEvent.click(checking);
    expect(mocks.accountSignIn).not.toHaveBeenCalled();
  });
});

describe("signed out", () => {
  it("opens a dropdown with Settings and Sign in, never a login form", async () => {
    mocks.accountStatus.mockResolvedValue(signedOut);
    renderMenu();

    const trigger = await screen.findByRole("button", { name: "Account" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.querySelector("input")).toBeNull();
    expect(mocks.accountRefresh).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    expect(screen.getByRole("menuitem", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Settings" }).textContent).toContain("9");

    mocks.accountSignIn.mockResolvedValue({ ...signedIn, plan: null });
    mocks.accountRefresh.mockResolvedValue(signedIn);
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign in" }));

    await waitFor(() => expect(mocks.accountSignIn).toHaveBeenCalledTimes(1));
    // Sign-in resolves without the entitlement lookup, so the plan arrives on the
    // follow-up refresh rather than keeping Cancel sign-in on screen for it.
    await waitFor(() => expect(mocks.accountRefresh).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole("button", { name: "Account" }));
    expect(await screen.findByText("Founders Edition")).toBeTruthy();
  });

  it("opens Settings from the signed-out menu", async () => {
    mocks.accountStatus.mockResolvedValue(signedOut);
    renderMenu();

    fireEvent.click(await screen.findByRole("button", { name: "Account" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(mocks.onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("surfaces a sign-in failure without crashing the chip", async () => {
    mocks.accountStatus.mockResolvedValue(signedOut);
    mocks.accountSignIn.mockRejectedValue(new Error("Sign-in timed out"));
    renderMenu();

    fireEvent.click(await screen.findByRole("button", { name: "Account" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign in" }));
    await waitFor(() => expect(mocks.accountSignIn).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: "Account" })).toBeTruthy();
    expect(mocks.toastError).toHaveBeenCalled();
  });

  it("does not toast a sign-in failure that resolves after the chip unmounts", async () => {
    mocks.accountStatus.mockResolvedValue(signedOut);
    let rejectSignIn: (error: Error) => void = () => {};
    mocks.accountSignIn.mockReturnValue(
      new Promise((_, reject) => {
        rejectSignIn = reject;
      }),
    );
    const { unmount } = renderMenu();

    fireEvent.click(await screen.findByRole("button", { name: "Account" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign in" }));
    await waitFor(() => expect(mocks.accountSignIn).toHaveBeenCalledTimes(1));
    unmount();
    rejectSignIn(new Error("Sign-in timed out"));
    // A macrotask, not one microtask: the rejection has to travel .then -> .catch -> .finally
    // before the toast would fire, and asserting earlier passes even with the guard removed.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("cancels an in-flight sign-in without toasting", async () => {
    mocks.accountStatus.mockResolvedValue(signedOut);
    let rejectSignIn: (error: Error) => void = () => {};
    mocks.accountSignIn.mockReturnValue(
      new Promise((_, reject) => {
        rejectSignIn = reject;
      }),
    );
    mocks.accountCancelSignIn.mockResolvedValue(undefined);
    renderMenu();

    fireEvent.click(await screen.findByRole("button", { name: "Account" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign in" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel sign-in" }));
    expect(mocks.accountCancelSignIn).toHaveBeenCalledTimes(1);
    rejectSignIn(new Error("Sign-in cancelled"));
    expect(await screen.findByRole("button", { name: "Account" })).toBeTruthy();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("ignores a second Sign in click while pairing is already in flight", async () => {
    mocks.accountStatus.mockResolvedValue(signedOut);
    mocks.accountSignIn.mockReturnValue(new Promise(() => {}));
    renderMenu();

    fireEvent.click(await screen.findByRole("button", { name: "Account" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign in" }));
    expect(mocks.accountSignIn).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Cancel sign-in" })).toBeTruthy();
  });
});

describe("signed in", () => {
  it("keeps email out of the titlebar and opens account from the identity row", async () => {
    mocks.accountStatus.mockResolvedValue(signedIn);
    mocks.accountRefresh.mockReturnValue(new Promise(() => {}));
    mocks.accountOpen.mockResolvedValue(undefined);
    renderMenu();

    const trigger = await screen.findByRole("button", { name: "Account" });
    expect(mocks.accountRefresh).toHaveBeenCalledTimes(1);
    expect(trigger.textContent).not.toContain("a@example.com");
    // Not just the label: a native tooltip shows the value on hover and during screen
    // sharing, without the dropdown that owns the email ever being opened.
    expect(trigger.getAttribute("title")).toBe("Account");
    expect(screen.queryByText("a@example.com")).toBeNull();
    expect(screen.queryByRole("menuitem")).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByText("a@example.com")).toBeTruthy();
    expect(screen.getByText("Founders Edition")).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Open account" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitem", { name: /a@example.com/ }));
    await waitFor(() => expect(mocks.accountOpen).toHaveBeenCalledTimes(1));
  });

  it("surfaces paid credits below the email and above Settings", async () => {
    mocks.accountStatus.mockResolvedValue(signedIn);
    mocks.accountRefresh.mockResolvedValue(signedIn);
    mocks.accountCredits.mockResolvedValue({
      visible: true,
      signedOut: false,
      plan: "founders",
      paid: true,
      balanceCents: 1300,
      cutoff: false,
      upsell: null,
      accountUrl: "https://accounts.alinery.ai/account",
      plansUrl: "https://accounts.alinery.ai/plans",
    });
    mocks.accountOpen.mockResolvedValue(undefined);
    renderMenu();

    fireEvent.click(await screen.findByRole("button", { name: "Account" }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Credits $13.00" })).toBeTruthy());
    const items = screen.getAllByRole("menuitem").map((el) => el.textContent);
    expect(items.indexOf("Credits $13.00")).toBeGreaterThan(items.findIndex((text) => text?.includes("a@example.com")));
    expect(items.indexOf("Credits $13.00")).toBeLessThan(items.indexOf("Settings9"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Credits $13.00" }));
    await waitFor(() => expect(mocks.accountOpen).toHaveBeenCalledTimes(1));
  });

  it("offers Buy credits in the dropdown when a paid balance is empty", async () => {
    mocks.accountStatus.mockResolvedValue(signedIn);
    mocks.accountRefresh.mockResolvedValue(signedIn);
    mocks.accountCredits.mockResolvedValue({
      visible: true,
      signedOut: false,
      plan: "founders",
      paid: true,
      balanceCents: 0,
      cutoff: false,
      upsell: "buy-credits",
      accountUrl: "https://accounts.alinery.ai/account",
      plansUrl: "https://accounts.alinery.ai/plans",
    });
    renderMenu();
    fireEvent.click(await screen.findByRole("button", { name: "Account" }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Buy credits" })).toBeTruthy());
    expect(screen.queryByRole("menuitem", { name: /Credits/ })).toBeNull();
  });

  it("opens Settings from the signed-in menu", async () => {
    mocks.accountStatus.mockResolvedValue(signedIn);
    mocks.accountRefresh.mockResolvedValue(signedIn);
    renderMenu();

    fireEvent.click(await screen.findByRole("button", { name: "Account" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(mocks.onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("returns to Account after Sign out", async () => {
    mocks.accountStatus.mockResolvedValue(signedIn);
    mocks.accountRefresh.mockResolvedValue(signedIn);
    mocks.accountSignOut.mockResolvedValue(signedOutRemote);
    renderMenu();

    fireEvent.click(await screen.findByRole("button", { name: "Account" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));

    await waitFor(() => expect(mocks.accountSignOut).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: "Account" })).toBeTruthy();
    expect(mocks.toastInfo).not.toHaveBeenCalled();
  });

  it("does not restore Account when a late refresh resolves after Sign out", async () => {
    let resolveRefresh = (_status: AccountStatus) => {};
    mocks.accountStatus.mockResolvedValue(signedIn);
    mocks.accountRefresh.mockReturnValue(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    mocks.accountSignOut.mockResolvedValue(signedOutRemote);
    renderMenu();

    fireEvent.click(await screen.findByRole("button", { name: "Account" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(await screen.findByRole("button", { name: "Account" })).toBeTruthy();

    resolveRefresh({ ...signedIn, unavailable: true });
    await waitFor(() => expect(mocks.accountRefresh).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    expect(screen.getByRole("menuitem", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByText("a@example.com")).toBeNull();
  });

  it("keeps a remaining pairing instead of flashing Sign in", async () => {
    const remaining: AccountSignOutResult = { ...signedIn, email: "b@example.com", remoteRevoked: true };
    mocks.accountStatus.mockResolvedValue(signedIn);
    mocks.accountRefresh.mockResolvedValue(signedIn);
    mocks.accountSignOut.mockResolvedValue(remaining);
    renderMenu();

    fireEvent.click(await screen.findByRole("button", { name: "Account" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));

    await waitFor(() => expect(mocks.accountSignOut).toHaveBeenCalledTimes(1));
    const trigger = await screen.findByRole("button", { name: "Account" });
    fireEvent.click(trigger);
    expect(screen.getByText("b@example.com")).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Sign in" })).toBeNull();
    expect(mocks.toastInfo).not.toHaveBeenCalled();
  });

  it("stays signed out locally when remote revoke fails", async () => {
    mocks.accountStatus.mockResolvedValue(signedIn);
    mocks.accountRefresh.mockResolvedValue(signedIn);
    mocks.accountSignOut.mockResolvedValue(signedOutLocal);
    renderMenu();

    fireEvent.click(await screen.findByRole("button", { name: "Account" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));

    await waitFor(() => expect(mocks.accountSignOut).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: "Account" })).toBeTruthy();
    expect(mocks.toastInfo).toHaveBeenCalledWith("Signed out on this device, but the server session may still be active.");
  });

  it("closes the dropdown on Escape and returns focus to the trigger", async () => {
    mocks.accountStatus.mockResolvedValue(signedIn);
    mocks.accountRefresh.mockResolvedValue(signedIn);
    renderMenu();

    const trigger = await screen.findByRole("button", { name: "Account" });
    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

// The chip keeps one neutral person glyph in every resting state. The accessible
// name and the dropdown content, not a visual state marker, communicate account state.
describe("account chip glyph", () => {
  const glyphOf = (button: HTMLElement) => button.querySelector("svg")?.getAttribute("class") ?? "";

  it("uses the neutral person glyph when signed out", async () => {
    mocks.accountStatus.mockResolvedValue(signedOut);
    renderMenu();

    const chip = await screen.findByRole("button", { name: "Account" });
    expect(glyphOf(chip)).toContain("lucide-user-round");
    expect(chip.className).toBe("iconbtn account-chip");
  });

  it("uses the same neutral person glyph when signed in", async () => {
    mocks.accountStatus.mockResolvedValue(signedIn);
    mocks.accountRefresh.mockResolvedValue(signedIn);
    renderMenu();

    const chip = await screen.findByRole("button", { name: "Account" });
    expect(glyphOf(chip)).toContain("lucide-user-round");
    expect(chip.className).toBe("iconbtn account-chip");
  });

  it("swaps in the cancel glyph only while a sign-in is in flight", async () => {
    mocks.accountStatus.mockResolvedValue(signedOut);
    mocks.accountSignIn.mockReturnValue(new Promise(() => {}));
    renderMenu();

    fireEvent.click(await screen.findByRole("button", { name: "Account" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign in" }));

    const cancel = await screen.findByRole("button", { name: "Cancel sign-in" });
    expect(glyphOf(cancel)).toContain("lucide-x");
    expect(glyphOf(cancel)).not.toContain("lucide-user-round");
  });
});
