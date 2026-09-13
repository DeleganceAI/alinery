import { UserRound, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import * as ipc from "./ipc";
import { toast } from "./toast";
import type { AccountStatus } from "./types";

/** Titlebar account chip. Icon only — email and plan live in the dropdown.
 *  UserRound keeps the same neutral treatment in every resting state, so the slot
 *  always reads as "account"; only an in-flight sign-in swaps in X to cancel.
 *  Session is in auth.json; the pairing nonce is never persisted.
 *  Settings lives here (not the top-bar tabs); ⌘9 / , still open it via hotkeys. */
export function AccountMenu({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const generation = useRef(0);
  const signingIn = useRef(false);

  // Local status first, then one network pass that rotates the token and re-checks the
  // entitlement. Shared by mount and post-sign-in: a fresh pairing gets its plan here
  // instead of inside the sign-in promise, which must stay no longer than Cancel sign-in
  // can act on (see account.rs `finish_sign_in`).
  const hydrate = (gen: number) => {
    ipc
      .accountRefresh()
      .then((updated) => {
        if (gen === generation.current) setStatus(updated);
      })
      .catch(() => {});
  };

  useEffect(() => {
    const gen = generation.current;
    ipc
      .accountStatus()
      .then((s) => {
        if (gen !== generation.current) return;
        setStatus(s);
        if (s.signedIn) hydrate(gen);
      })
      .catch(() => {
        if (gen === generation.current) setStatus({ signedIn: false, email: null, plan: null, paid: false, unavailable: false });
      });
    // Bumping the generation retires every in-flight reply, unmount included.
    return () => {
      generation.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>("button")?.focus();
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>("button") ?? []);
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown" ? (at + 1 + items.length) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const signIn = () => {
    if (signingIn.current) return;
    signingIn.current = true;
    setBusy(true);
    const gen = generation.current;
    ipc
      .accountSignIn()
      .then((s) => {
        if (gen !== generation.current) return;
        setStatus(s);
        hydrate(gen);
      })
      .catch((e) => {
        // Same retirement rule as the success path above: an unmounted titlebar has no chip to
        // toast about, and a sign-out has already moved on from this attempt.
        if (gen !== generation.current) return;
        if (!/cancelled/i.test(String(e))) toast.error(`Couldn't sign in: ${String(e)}`);
      })
      .finally(() => {
        signingIn.current = false;
        setBusy(false);
      });
  };

  const cancelSignIn = () => {
    ipc.accountCancelSignIn().catch(() => {});
  };

  const run = (action: () => void) => () => {
    setOpen(false);
    trigger.current?.focus();
    action();
  };

  const signOut = () => {
    generation.current += 1;
    setBusy(true);
    ipc
      .accountSignOut()
      .then((s) => {
        setStatus(s);
        setOpen(false);
        if (s.signedIn) {
          // A newer pairing replaced the session we signed out of. Keep that chip;
          // flashing Sign in would let the user start another pairing over it.
          return;
        }
        if (!s.remoteRevoked) {
          toast.info("Signed out on this device, but the server session may still be active.");
        }
      })
      .catch((e) => toast.error(`Couldn't sign out: ${String(e)}`))
      .finally(() => setBusy(false));
  };

  const openAccount = () => {
    ipc.accountOpen().catch((e) => toast.error(`Couldn't open the account page: ${String(e)}`));
  };

  if (status === null) {
    return (
      <button type="button" className="iconbtn account-chip" aria-label="Checking account" aria-busy={true} data-tauri-drag-region="false" disabled>
        <UserRound size={16} strokeWidth={1.5} aria-hidden="true" />
      </button>
    );
  }

  // In-flight pairing: Cancel is a one-shot chip, not a menu, so Escape/outside-click do not
  // strand an unfinished browser flow behind a closed dropdown.
  if (!status.signedIn && busy) {
    return (
      <button type="button" className="iconbtn account-chip" title="Cancel sign-in" aria-label="Cancel sign-in" data-tauri-drag-region="false" onClick={cancelSignIn}>
        <X size={16} strokeWidth={1.5} aria-hidden="true" />
      </button>
    );
  }

  const chipLabel = !status.signedIn ? "Account" : status.unavailable ? "Account unavailable" : "Account";
  const settingsItem = (
    <button type="button" role="menuitem" className="account-chip-action" disabled={busy} onClick={run(onOpenSettings)}>
      Settings
      <span className="k" aria-hidden="true">
        9
      </span>
    </button>
  );

  return (
    <div className="account-chip-menu" ref={box} data-tauri-drag-region="false">
      <button
        type="button"
        ref={trigger}
        className="iconbtn account-chip"
        // Generic on purpose: a native tooltip would leak the address on hover, and during
        // screen sharing, without the user ever opening the dropdown that owns it.
        title={chipLabel}
        aria-label={chipLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tauri-drag-region="false"
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
      >
        <UserRound size={16} strokeWidth={1.5} aria-hidden="true" />
      </button>
      {open && (
        <div className="repo-menu account-chip-list" role="menu" ref={menu} onKeyDown={onMenuKey}>
          {status.signedIn ? (
            <>
              <button type="button" role="menuitem" className="account-chip-identity" disabled={busy} onClick={run(openAccount)}>
                <span className="account-chip-email">{status.email ?? "Signed in"}</span>
                {status.plan ? <span className="account-chip-plan">{status.plan}</span> : null}
              </button>
              {settingsItem}
              <button type="button" role="menuitem" className="account-chip-action" disabled={busy} onClick={run(signOut)}>
                Sign out
              </button>
            </>
          ) : (
            <>
              {settingsItem}
              <button type="button" role="menuitem" className="account-chip-action" disabled={busy} onClick={run(signIn)}>
                Sign in
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
