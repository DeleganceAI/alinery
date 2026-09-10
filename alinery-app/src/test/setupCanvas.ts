// jsdom has no canvas. thinking-orbs and mermaid call getContext("2d") on
// mount; jsdom's default is to log "Not implemented" and return null. The orb
// already bails on null, which is what unit tests want — they do not assert
// pixels, and a fake 2d context would start rAF loops that inflate timer
// counts. Replace getContext so the log never fires. Node-environment suites
// (scripts/*.test.ts) have no HTMLCanvasElement; skip them.
if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
}
