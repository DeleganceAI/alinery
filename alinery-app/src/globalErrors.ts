import { toast } from "./toast";

/**
 * The errors an {@link ErrorBoundary} cannot see: a rejected promise and a throw from an
 * event handler never pass through render, so React has nothing to catch and the app
 * carries on in a broken state with no sign of why. Surface them instead.
 *
 * Noise, not a crash: the app keeps running, so this only reports. `event.preventDefault`
 * is deliberately not called — the webview console is the full record (stack included),
 * and this is the short version a person can act on.
 */
function describe(reason: unknown): string {
  if (reason instanceof Error) return reason.message || reason.name;
  if (typeof reason === "string" && reason) return reason;
  try {
    return JSON.stringify(reason) ?? String(reason);
  } catch {
    return String(reason);
  }
}

export function installGlobalErrorReports(): void {
  window.addEventListener("unhandledrejection", (event) => {
    console.error("unhandled rejection", event.reason);
    toast.error(`Something failed in the background: ${describe(event.reason)}`);
  });
  window.addEventListener("error", (event) => {
    // A failed module/chunk load arrives here too, and it is the one that matters most
    // in a lazy view: React cannot recover from it, so say what did not load.
    const message = event.message || describe(event.error);
    if (!message) return;
    console.error("uncaught error", event.error ?? message);
    toast.error(`Something broke: ${message}`);
  });
}
