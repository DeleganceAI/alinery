import { defineConfig } from "vitest/config";

// Test discovery used to live in the `npm test` script as
// `vitest run --dir . --exclude='**/src-tauri/**'`. Two problems with that: `--exclude`
// *replaces* vitest's default exclude list rather than adding to it, and the whole thing
// had to be repeated by every caller. An explicit `include` says the same thing without
// touching the defaults — src-tauri simply never matches, so the Rust tree and the
// runner's `node --test` suites stay out on their own.
export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
    // jsdom globally rather than a per-file `@vitest-environment` pragma: the pure-logic
    // tests do not care, and a pragma is one more thing to remember (and to forget) when
    // writing a component test.
    environment: "jsdom",
    setupFiles: ["src/test/setupStorage.ts", "src/test/setupCanvas.ts"],
    // jsdom's unimplemented canvas logs "Not implemented: HTMLCanvasElement"
    // on every ThinkingOrb mount. setupCanvas.ts swallows getContext; this
    // drops any remaining copy so it cannot fail the run.
    onConsoleLog(log) {
      if (log.includes("Not implemented: HTMLCanvasElement")) return false;
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      // main.tsx is the render entrypoint and vite-env.d.ts is types only; neither has
      // anything to assert. Test files should not count towards their own coverage.
      exclude: ["src/**/*.test.{ts,tsx}", "src/main.tsx", "src/vite-env.d.ts"],
      reporter: ["text", "html"],
    },
  },
});
