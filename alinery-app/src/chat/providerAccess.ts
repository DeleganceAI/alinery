import { useCallback, useEffect, useRef, useState } from "react";
import * as ipc from "../ipc";
import { isRemoteRepo } from "../remoteRepo";
import * as providers from "../sync/providers";
import { type LoginProvider, loginProvidersFromCatalog, type ProviderCatalog, type ProviderLoginStatus } from "./providers";

function browsable(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * The loopback address a browser sign-in ends on, taken from the prompt the daemon asks with rather
 * than a port this app assumes: it is the daemon's own redirect URI, so it follows that runtime.
 * Only 127.0.0.1, which is what the app binds and what the daemon compares the origin against.
 */
export function loopbackTarget(placeholder: string | undefined): { port: number; path: string } | null {
  const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})(\/[^?#]*)?$/.exec(placeholder?.trim() ?? "");
  if (!match) return null;
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { port, path: match[2] ?? "/" };
}

/**
 * The accounts of one machine: `repo` names the daemon that holds them, so a chat in a repository on
 * this Mac signs in here even while the open repository is on another machine. Without it, the active
 * repository's daemon answers, which is what Settings (a repository choice, not a session) wants.
 */
export function useProviderAccess(enabled: boolean, repo?: string) {
  const [catalog, setCatalog] = useState<ProviderCatalog | null>(null);
  const [settled, setSettled] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<LoginProvider | null>(null);
  const [login, setLogin] = useState<ProviderLoginStatus | null>(null);
  const [signedIn, setSignedIn] = useState<string | null>(null);
  const loginId = useRef<string | null>(null);
  const loginHost = useRef<string | null>(null);
  const opened = useRef(new Set<string>());
  /** The `port+path` this window is listening on for the browser's redirect; null when not armed. */
  const armed = useRef<string | null>(null);
  /** An address this sign-in already failed to bind, so a taken port is tried once, not every poll. */
  const unbindable = useRef<string | null>(null);
  const [callbackArmed, setCallbackArmed] = useState(false);

  const disarm = useCallback(async () => {
    if (!armed.current) return;
    armed.current = null;
    setCallbackArmed(false);
    await ipc.providerCallbackDisarm().catch(() => undefined);
  }, []);

  const reload = useCallback(async () => {
    const next = await providers.providerCatalog(repo);
    setCatalog(next);
    setSettled(true);
    return next;
  }, [repo]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = async () => {
      let last = "daemon not connected";
      for (let attempt = 0; attempt < 8 && !cancelled; attempt += 1) {
        try {
          const next = await providers.providerCatalog(repo);
          if (cancelled) return;
          setCatalog(next);
          setError(null);
          setSettled(true);
          return;
        } catch (cause) {
          last = String(cause);
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      }
      if (!cancelled) {
        setError(last);
        setSettled(true);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [enabled, repo]);

  useEffect(() => {
    if (!busy || !loginId.current) return;
    let cancelled = false;
    const timer = setInterval(() => {
      const id = loginId.current;
      if (!id || cancelled) return;
      void providers.providerLoginPoll(id, loginHost.current ?? undefined).then(
        async (status) => {
          if (cancelled || loginId.current !== id) return;
          // The daemon drains events on every poll; keep them, or a device code shows for one tick and vanishes.
          setLogin((prev) => (prev?.loginId === status.loginId ? { ...status, events: [...prev.events, ...status.events] } : status));
          // A sign-in that runs on another machine ends on that machine's loopback, which this Mac's
          // browser cannot reach: listen for the redirect here instead, before the page is opened, so
          // the callback lands in this window rather than on an error page.
          const target = status.prompt?.type === "manual_code" ? loopbackTarget(status.prompt.placeholder) : null;
          const key = target ? `${target.port}${target.path}` : null;
          if (target && key && armed.current !== key && unbindable.current !== key && isRemoteRepo(loginHost.current ?? "")) {
            armed.current = key;
            const ready = await ipc.providerCallbackArm(target.port, target.path).then(
              () => true,
              () => false,
            );
            if (cancelled || loginId.current !== id) {
              void disarm();
              return;
            }
            // The port was taken (a local sign-in, or the Codex CLI): the panel's paste fallback stands.
            if (!ready) {
              armed.current = null;
              unbindable.current = key;
            }
            setCallbackArmed(ready);
          }
          for (const event of status.events ?? []) {
            // A device-code flow (xAI) sends no auth_url: its verification page is the one to open.
            const raw = event.type === "auth_url" ? event.url : event.type === "device_code" ? event.verificationUri : undefined;
            const url = browsable(raw);
            if (!url || opened.current.has(url)) continue;
            opened.current.add(url);
            void ipc.openUrl(url).catch((cause: unknown) => setError(String(cause)));
          }
          if (status.status === "done" || status.status === "error" || status.status === "cancelled") {
            loginId.current = null;
            setBusy(null);
            void disarm();
            if (status.status === "done") {
              setLogin(null);
              void reload().then(
                (next) => setSignedIn(next.providers.find((p) => p.id === busy)?.name ?? busy),
                (cause: unknown) => setError(String(cause)),
              );
            }
            if (status.status === "error") setError(status.failure || "Login failed");
          }
        },
        (cause: unknown) => {
          if (!cancelled) setError(String(cause));
        },
      );
    }, 400);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [busy, reload, disarm]);

  /** The browser came back to this window: reply the URL the daemon's prompt is waiting for. */
  const reply = useCallback(async (value: string) => {
    const id = loginId.current;
    if (!id) return;
    try {
      await providers.providerLoginReply(id, value, false, loginHost.current ?? undefined);
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  useEffect(
    () =>
      ipc.onProviderCallback((url) => {
        armed.current = null;
        setCallbackArmed(false);
        void reply(url);
      }),
    [reply],
  );

  // A dialog torn down without Cancel must not leave the port held until the deadline.
  useEffect(() => () => void disarm(), [disarm]);

  const start = useCallback(
    async (provider: string, method: "api_key" | "oauth") => {
      setError(null);
      setChoice(null);
      setSignedIn(null);
      try {
        const { status, host } = await providers.providerLoginStart(provider, method, repo);
        loginHost.current = host;
        loginId.current = status.loginId;
        unbindable.current = null;
        setLogin(status);
        setBusy(provider);
      } catch (cause) {
        setError(String(cause));
      }
    },
    [repo],
  );

  const cancel = useCallback(async () => {
    const id = loginId.current;
    loginId.current = null;
    setBusy(null);
    setLogin(null);
    setChoice(null);
    // The port goes back with the sign-in, or the next attempt has to fall back to pasting.
    void disarm();
    if (!id) return;
    try {
      await providers.providerLoginReply(id, "", true, loginHost.current ?? undefined);
    } catch {
      /* the dialog is already gone */
    }
  }, [disarm]);

  const logout = useCallback(
    async (provider: string) => {
      setError(null);
      try {
        setCatalog(await providers.providerLogout(provider, repo));
      } catch (cause) {
        setError(String(cause));
      }
    },
    [repo],
  );

  // Favorites for models a provider no longer serves linger in the app config, so the pickers keep offering them.
  // The store is the shell's, so the pruning happens here, in the background: the catalog is already updated.
  const pruneFavorites = useCallback((providerId: string, keep: ReadonlySet<string>) => {
    void ipc
      .readModelFavorites("vinculum")
      .then((favorites) =>
        Promise.allSettled(
          favorites.filter((favorite) => favorite.startsWith(`${providerId}/`) && !keep.has(favorite)).map((favorite) => ipc.setModelFavorite("vinculum", favorite, false)),
        ),
      )
      .catch(() => undefined);
  }, []);

  // The editor shows its own errors, so these leave the panel's error alone.
  const saveCustom = useCallback(
    async (config: string, replaces?: string) => {
      const previous = catalog;
      const next = await providers.customProviderSave(config, replaces, repo);
      setCatalog(next);
      // What `previous` served that `next` does not loses its stars: endpoints gone entirely (including a rename)
      // prune to nothing kept, and an edit that dropped models prunes just those.
      for (const row of previous?.custom ?? []) {
        pruneFavorites(row.id, new Set((next.custom.find((kept) => kept.id === row.id)?.models ?? []).map((model) => `${row.id}/${model}`)));
      }
    },
    [catalog, pruneFavorites, repo],
  );

  const checkCustom = useCallback((config: string, live: boolean) => providers.customProviderCheck(config, live, repo), [repo]);

  const deleteCustom = useCallback(
    async (id: string) => {
      setError(null);
      try {
        setCatalog(await providers.customProviderDelete(id, repo));
        // The endpoint and every model it served are gone; nothing of it keeps a star.
        pruneFavorites(id, new Set());
      } catch (cause) {
        setError(String(cause));
      }
    },
    [pruneFavorites, repo],
  );

  return {
    settled,
    catalog,
    loginProviders: loginProvidersFromCatalog(catalog),
    models: catalog?.models ?? [],
    custom: catalog?.custom ?? [],
    busy,
    error,
    choice,
    login,
    signedIn,
    /** True while this window is listening for the browser's redirect instead of asking for a paste. */
    callbackArmed,
    start,
    choose: setChoice,
    reply,
    cancel,
    logout,
    saveCustom,
    checkCustom,
    deleteCustom,
  };
}
