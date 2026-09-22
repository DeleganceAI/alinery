import { JSDOM } from "jsdom";

// Node 22+ defines its own `globalThis.localStorage`. vitest's jsdom environment copies
// jsdom's window properties onto the real global, but `getWindowKeys` skips any key that
// already exists on `globalThis` unless it is on vitest's hardcoded KEYS allowlist — and
// that list holds interface *constructors* ("Storage"), never the global *instance*
// ("localStorage"). So Node's own localStorage wins the check and jsdom's Storage is never
// installed; the teardown bookkeeping then leaves the property present but undefined, and
// every `window.localStorage.clear()` in an afterEach throws instead of clearing.
//
// Install a real Storage area from a throwaway jsdom window before any test can stub it.
// `configurable` + `writable` matter: tests call `vi.stubGlobal("localStorage", …)` and
// `vi.unstubAllGlobals()`, and vitest restores whatever value it saw first. A stub cycle
// therefore round-trips back to this object rather than to undefined, which is what the
// mass teardown failures were.
//
// Node-environment suites (scripts/*.test.ts) have no document and must keep Node's own
// global untouched, so the install is skipped there. jsdom's Storage is spec-shaped for the
// methods the app uses (getItem/setItem/removeItem/clear); it does not implement numeric
// indexed access, which nothing in the app relies on.
if (typeof document !== "undefined" && !globalThis.localStorage) {
  const storageWindow = new JSDOM("", { url: "http://localhost/" }).window;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: storageWindow.localStorage,
  });
}
