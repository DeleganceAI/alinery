// GPU terminal-grid renderer for the WKWebView surface.
//
// Ghostty paints its cell grid with Metal/OpenGL from a dedicated render thread
// (`src/renderer/generic.zig`). We cannot embed that stack: libghostty owns the
// PTY, the VT parser, and a native GPU surface, while Alinery's grid already
// lives in xterm.js inside WKWebView and the PTY already lives in alineryd.
// The matching move is xterm's WebGL2 renderer — same idea, same process, same
// byte pump. WKWebView already GPU-composites the React chrome.
//
// Kept out of SessionTerminal.tsx so the fallback policy can be tested without
// constructing a real Terminal.

export type TerminalRendererKind = "webgl" | "dom";

export type GpuRendererAddon = {
  dispose: () => void;
  onContextLoss: (listener: () => void) => unknown;
};

export type GpuRendererTerminal<TAddon extends GpuRendererAddon = GpuRendererAddon> = {
  loadAddon: (addon: TAddon) => void;
};

export function attachGpuRenderer<TAddon extends GpuRendererAddon>(term: GpuRendererTerminal<TAddon>, createAddon: () => TAddon): TerminalRendererKind {
  let addon: TAddon | undefined;
  try {
    addon = createAddon();
    addon.onContextLoss(() => {
      try {
        addon?.dispose();
      } catch {
        // Context loss can race term.dispose().
      }
    });
    term.loadAddon(addon);
    return "webgl";
  } catch {
    try {
      addon?.dispose();
    } catch {
      // Half-activated addon; DOM renderer is the fallback either way.
    }
    // No WebGL2 (or the addon rejected the context). xterm stays on its
    // default DOM renderer; the byte pump is unchanged.
    return "dom";
  }
}
