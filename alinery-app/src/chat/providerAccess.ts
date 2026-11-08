import { useCallback, useEffect, useRef, useState } from "react";
import * as ipc from "../ipc";
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

export function useProviderAccess(enabled: boolean) {
  const [catalog, setCatalog] = useState<ProviderCatalog | null>(null);
  const [settled, setSettled] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<LoginProvider | null>(null);
  const [login, setLogin] = useState<ProviderLoginStatus | null>(null);
  const loginId = useRef<string | null>(null);
  const loginHost = useRef<string | null>(null);
  const opened = useRef(new Set<string>());

  const reload = useCallback(async () => {
    const next = await providers.providerCatalog();
    setCatalog(next);
    setSettled(true);
    return next;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = async () => {
      let last = "daemon not connected";
      for (let attempt = 0; attempt < 8 && !cancelled; attempt += 1) {
        try {
          const next = await providers.providerCatalog();
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
  }, [enabled]);

  useEffect(() => {
    if (!busy || !loginId.current) return;
    let cancelled = false;
    const timer = setInterval(() => {
      const id = loginId.current;
      if (!id || cancelled) return;
      void providers.providerLoginPoll(id, loginHost.current ?? undefined).then(
        (status) => {
          if (cancelled || loginId.current !== id) return;
          setLogin(status);
          for (const event of status.events ?? []) {
            if (event.type !== "auth_url") continue;
            const url = browsable(event.url);
            if (!url || opened.current.has(url)) continue;
            opened.current.add(url);
            void ipc.openUrl(url).catch((cause: unknown) => setError(String(cause)));
          }
          if (status.status === "done" || status.status === "error" || status.status === "cancelled") {
            loginId.current = null;
            setBusy(null);
            if (status.status === "done") void reload().catch((cause: unknown) => setError(String(cause)));
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
  }, [busy, reload]);

  const start = useCallback(async (provider: string, method: "api_key" | "oauth") => {
    setError(null);
    setChoice(null);
    try {
      const { status, host } = await providers.providerLoginStart(provider, method);
      loginHost.current = host;
      loginId.current = status.loginId;
      setLogin(status);
      setBusy(provider);
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  const reply = useCallback(async (value: string) => {
    const id = loginId.current;
    if (!id) return;
    try {
      await providers.providerLoginReply(id, value, false, loginHost.current ?? undefined);
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  const cancel = useCallback(async () => {
    const id = loginId.current;
    loginId.current = null;
    setBusy(null);
    setLogin(null);
    setChoice(null);
    if (!id) return;
    try {
      await providers.providerLoginReply(id, "", true, loginHost.current ?? undefined);
    } catch {
      /* the dialog is already gone */
    }
  }, []);

  const logout = useCallback(async (provider: string) => {
    setError(null);
    try {
      setCatalog(await providers.providerLogout(provider));
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  const saveCustom = useCallback(async (input: { id: string; name: string; baseUrl: string; apiKey: string; keepKey: boolean; models: string[] }) => {
    setError(null);
    try {
      setCatalog(await providers.customProviderSave(input));
    } catch (cause) {
      setError(String(cause));
      throw cause;
    }
  }, []);

  const deleteCustom = useCallback(async (id: string) => {
    setError(null);
    try {
      setCatalog(await providers.customProviderDelete(id));
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

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
    start,
    choose: setChoice,
    reply,
    cancel,
    logout,
    saveCustom,
    deleteCustom,
  };
}
