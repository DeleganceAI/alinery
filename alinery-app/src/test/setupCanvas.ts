// jsdom has no canvas. thinking-orbs and mermaid call getContext("2d") on
// mount; jsdom's default is to log "Not implemented" and return null. The orb
// already bails on null, which is what unit tests want — they do not assert
// pixels, and a fake 2d context would start rAF loops that inflate timer
// counts. Replace getContext so the log never fires. Node-environment suites
// (scripts/*.test.ts) have no HTMLCanvasElement; skip them.
if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
}

if (typeof localStorage === "undefined") {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => store.delete(key),
    setItem: (key, value) => store.set(key, value),
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
}
