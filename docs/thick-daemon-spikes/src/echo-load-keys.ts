// Keystroke source for echo-load.ts: posts an absolute send timestamp at a fixed rate, off the main loop.
declare const self: Worker;
self.onmessage = async (e: MessageEvent<{ count: number; hz: number }>) => {
  const { count, hz } = e.data;
  const period = 1000 / hz;
  const start = performance.now();
  for (let i = 0; i < count; i++) {
    const due = start + i * period;
    const wait = due - performance.now();
    if (wait > 0) await Bun.sleep(wait);
    postMessage(performance.timeOrigin + performance.now());
  }
};
