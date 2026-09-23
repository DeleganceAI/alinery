/** flushSync commits the DOM; one rAF still runs *before* paint. WKWebView rasterizes
    between frames, so two rAFs then a macrotask is the wait that actually puts a loader on screen. */
export function afterPaint(): Promise<void> {
  return new Promise((resolve) => {
    const yieldTurn = () => setTimeout(resolve, 0);
    if (typeof requestAnimationFrame !== "function") {
      yieldTurn();
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(yieldTurn));
  });
}
