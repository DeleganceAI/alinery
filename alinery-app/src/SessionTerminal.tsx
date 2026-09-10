import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { APPEARANCE_EVENT } from "./appearance";
import { decodeChannelFrame } from "./channelFrame";
import * as ipc from "./ipc";
import { attachGpuRenderer } from "./terminalRenderer";
import "@xterm/xterm/css/xterm.css";

// xterm needs concrete colors; these tokens are plain hexes in both built-in
// themes and in custom-palette overrides (appearance.ts keeps color-mix out of
// them for exactly this reason).
function terminalTheme() {
  const css = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const background = read("--terminal-bg", "#000104");
  const accent = read("--accent", "#587aff");
  const onAccent = read("--on-accent", background);
  return {
    background,
    foreground: read("--terminal-fg", "#f4f1ea"),
    cursor: accent,
    cursorAccent: onAccent,
    selectionBackground: accent,
    selectionForeground: onAccent,
    selectionInactiveBackground: accent,
  };
}

// `attachId` is unique per mounted pane and scopes daemon replacement/detach. `streamToken` is
// unique per socket pump within that mount so stale data/close events cannot affect a reattach.
let nextAttachId = 1;
let nextStreamToken = 1;

export type SessionTerminalConnectionState = "opening" | "open" | "recovering" | "failed";
// One xterm pane bound to one pty session. Bytes are written straight to the
// terminal — never through React state (pty output is thousands of tiny writes/sec).
// M3: taskSlug + phase let a FRESH spawn seed OMP with the phase prompt. On
// reattach the backend ignores them (OMP already has it), so passing them always
// is safe.
export function SessionTerminal({
  sessionId,
  cwd,
  taskSlug,
  phase,
  harness,
  model,
  intent,
  resumeToken,
  terminalFontSize,
  readOnly,
  onConnectionStateChange,
}: {
  sessionId: string;
  cwd: string;
  taskSlug: string;
  phase: string;
  harness: string;
  model: string;
  // Daemon op: "attach" (never spawns), "spawn" (fresh + seed phase), "resume" (P5, resume_args).
  intent: "attach" | "spawn" | "resume";
  resumeToken?: string;
  terminalFontSize: number;
  // Read-only replay: mount the capped activity sidecar, no daemon session, no stdin (P7).
  readOnly?: boolean;
  onConnectionStateChange?: (state: SessionTerminalConnectionState) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const attachId = nextAttachId++;
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: "Menlo, monospace",
      fontSize: terminalFontSize,
      // Reattached normal-buffer sessions replay up to 8 MiB of durable output. Keep enough
      // xterm history for that replay instead of silently truncating it to the default 1,000 rows.
      scrollback: 50_000,
      // Keep ANSI, indexed, and true-color foregrounds readable on either appearance.
      minimumContrastRatio: 4.5,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    // GPU cell grid (WebGL2) with DOM fallback. See terminalRenderer.ts.
    attachGpuRenderer(term, () => new WebglAddon());
    // xterm disables correction and spelling on its hidden textarea but leaves macOS
    // text completion and Writing Suggestions enabled. Disable both before focus can
    // wake NSSpellServer.
    const input = host.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    input?.setAttribute("autocomplete", "off");
    input?.setAttribute("writingsuggestions", "false");

    // Follow appearance changes live — an open terminal must not stay in the old theme.
    const onAppearance = () => {
      term.options.theme = terminalTheme();
    };
    window.addEventListener(APPEARANCE_EVENT, onAppearance);

    // The pty keeps running in Rust after we navigate away (the "bag" of live
    // sessions). detach_session below stops the reader forwarding to this channel,
    // but a few bytes may already be in flight — guard against writing to a disposed
    // terminal so they're dropped instead of thrown at a torn-down xterm.
    let disposed = false;

    if (readOnly) {
      // Read-only history replay (issue #24 P7): fetch the session's recorded activity
      // chunks once and write them. NO open_session/attach, NO stdin, NO daemon resize —
      // this pane never touches the daemon, so it works after the pty (and daemon) are gone.
      ipc
        .readSessionHistory({ id: sessionId, taskSlug: taskSlug || null })
        .then((bytes) => {
          if (disposed) return;
          if (bytes.length) term.write(new Uint8Array(bytes));
          else term.writeln("\r\n[no recorded activity for this session]");
        })
        .catch((e) => {
          if (!disposed) term.writeln(`\r\n[history unavailable] ${String(e)}`);
        });
      const roHist = new ResizeObserver(() => fit.fit());
      roHist.observe(host);
      return () => {
        disposed = true;
        window.removeEventListener(APPEARANCE_EVENT, onAppearance);
        roHist.disconnect();
        term.dispose();
      };
    }

    onConnectionStateChange?.("opening");

    // Open (reattach to the live pty, replaying its screen, or spawn fresh), THEN resize — so the
    // session exists in Rust before we size it. The close listener is installed first below so no
    // socket pump can close before recovery is armed.
    let currentStreamToken = 0;
    let reattachCount = 0;
    let lastClose = 0;
    let unlisten: (() => void) | null = null;
    let opened = false;
    let resizeFrame = 0;
    let lastResize = "";
    let viewportIdleTimer = 0;
    let viewportHardTimer = 0;
    let replayGeometryToken = 0;
    let replayRestoreTimer = 0;

    // A reconstructed replay can arrive without changing geometry. xterm and the attached TUI
    // then keep stale scroll bounds until the artifact divider drives both sides through a real
    // resize. Once replay delivery settles, reproduce that proven path with a one-column nudge,
    // restore the fitted geometry, and synchronize xterm's DOM scroll area.
    const syncViewportAfterReplay = (streamToken: number) => {
      if (disposed || currentStreamToken !== streamToken) return;
      const syncViewport = () => {
        const core = (
          term as unknown as {
            _core?: { viewport?: { syncScrollArea: (immediate?: boolean) => void } };
          }
        )._core;
        core?.viewport?.syncScrollArea(true);
        term.refresh(0, term.rows - 1);
      };
      syncViewport();
      window.clearTimeout(viewportIdleTimer);
      window.clearTimeout(viewportHardTimer);
      viewportIdleTimer = 0;
      viewportHardTimer = 0;

      if (replayGeometryToken !== streamToken || !opened || term.cols <= 10) return;
      replayGeometryToken = 0;
      const cols = term.cols;
      const rows = term.rows;
      term.resize(cols - 1, rows);
      lastResize = `${cols - 1}x${rows}`;
      void ipc
        .resizeSession(sessionId, cols - 1, rows)
        .catch(() => {})
        .finally(() => {
          replayRestoreTimer = window.setTimeout(() => {
            if (disposed || currentStreamToken !== streamToken) return;
            term.resize(cols, rows);
            lastResize = `${cols}x${rows}`;
            void ipc.resizeSession(sessionId, cols, rows).catch(() => {});
            requestAnimationFrame(syncViewport);
          }, 100);
        });
    };

    const scheduleReplayViewportSync = (streamToken: number) => {
      window.clearTimeout(viewportIdleTimer);
      viewportIdleTimer = window.setTimeout(() => syncViewportAfterReplay(streamToken), 100);
      if (!viewportHardTimer) {
        viewportHardTimer = window.setTimeout(() => syncViewportAfterReplay(streamToken), 500);
      }
    };

    const fitVisibleTerminal = () => {
      const dimensions = fit.proposeDimensions();
      if (!dimensions || dimensions.cols < 10 || dimensions.rows < 3) return false;
      if (term.cols !== dimensions.cols || term.rows !== dimensions.rows) {
        term.resize(dimensions.cols, dimensions.rows);
      }
      return true;
    };

    // A fresh binary Channel and stream token per (re)attach. Every app-channel body carries a
    // little-endian payload length followed by PTY bytes and optional zero padding; the envelope
    // keeps even tiny updates on Tauri's binary fetch path instead of `webview.eval`.
    const doAttach = async (reattach: boolean): Promise<boolean> => {
      const geometryReady = fitVisibleTerminal();
      const streamToken = nextStreamToken++;
      currentStreamToken = streamToken;
      window.clearTimeout(viewportIdleTimer);
      window.clearTimeout(viewportHardTimer);
      viewportIdleTimer = 0;
      viewportHardTimer = 0;
      window.clearTimeout(replayRestoreTimer);
      replayRestoreTimer = 0;
      replayGeometryToken = (reattach || intent === "attach") && harness !== "no-harness" ? streamToken : 0;
      const onBytes = new ipc.Channel<ArrayBuffer>();
      onBytes.onmessage = (bytes) => {
        if (disposed || currentStreamToken !== streamToken) return;
        const payload = decodeChannelFrame(bytes);
        if (payload && payload.length > 0) {
          term.write(payload, () => scheduleReplayViewportSync(streamToken));
        }
      };
      try {
        await ipc.openSession({
          id: sessionId,
          cwd,
          attachId,
          streamToken,
          taskSlug: taskSlug || null,
          // Seed the phase prompt only on a genuine fresh spawn — never on a reattach.
          phase: !reattach && intent === "spawn" ? phase || null : null,
          model,
          // A reattach must never re-spawn or re-resume the harness; it only rejoins the live pty.
          intent: reattach ? "attach" : intent,
          resumeToken: resumeToken ?? null,
          cols: geometryReady ? term.cols : null,
          rows: geometryReady ? term.rows : null,
          onBytes,
        });
        if (disposed || currentStreamToken !== streamToken) return false;
        opened = true;
        onConnectionStateChange?.("open");
        if (geometryReady) {
          await ipc.resizeSession(sessionId, term.cols, term.rows);
          lastResize = `${term.cols}x${term.rows}`;
        }
        return true;
      } catch (e) {
        if (!disposed && currentStreamToken === streamToken) {
          const message = reattach ? "\r\n[live view paused — stream recovery failed; reopen to resume] " : "\r\n[spawn failed] ";
          term.writeln(message + String(e));
        }
        onConnectionStateChange?.("failed");
        return false;
      }
    };

    // A slow or closed client is dropped by the daemon so it cannot block the harness. Recover
    // only the latest socket pump for this mounted pane, and bound churn so a genuinely slow view
    // degrades to a visible paused notice instead of a clear/reattach loop.
    const startMonitoredStream = async () => {
      try {
        const fn = await ipc.listen<{ id: string; attach_id: number; stream_token: number }>("session_stream_closed", async (ev) => {
          const streamToken = ev.payload.stream_token;
          if (disposed || ev.payload.id !== sessionId || ev.payload.attach_id !== attachId || streamToken !== currentStreamToken) {
            return;
          }
          onConnectionStateChange?.("recovering");
          const now = Date.now();
          if (now - lastClose > 30000) reattachCount = 0;
          lastClose = now;
          reattachCount += 1;
          if (reattachCount > 6) {
            term.writeln("\r\n[live view paused — output outpacing this view; reopen to resume]");
            onConnectionStateChange?.("failed");
            return;
          }
          try {
            const obs = await ipc.sessionStatus(sessionId, taskSlug || null);
            if (disposed || streamToken !== currentStreamToken || (obs.lifecycle.state !== "live" && obs.lifecycle.state !== "live_exited")) {
              return;
            }
          } catch (e) {
            if (!disposed && streamToken === currentStreamToken) {
              term.writeln(`\r\n[live view paused — status unavailable; reopen to resume] ${String(e)}`);
              onConnectionStateChange?.("failed");
            }
            return;
          }

          setTimeout(() => {
            if (disposed || streamToken !== currentStreamToken) return;
            term.clear();
            void doAttach(true);
          }, 400 * reattachCount);
        });
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      } catch (e) {
        if (!disposed) {
          term.writeln(`\r\n[live stream unavailable — reopen to retry] ${String(e)}`);
        }
        return;
      }

      if (disposed) return;
      await new Promise<void>((resolve) => {
        let framesLeft = 60;
        const tryFit = () => {
          if (disposed || fitVisibleTerminal() || --framesLeft === 0) {
            resolve();
          } else {
            requestAnimationFrame(tryFit);
          }
        };
        requestAnimationFrame(tryFit);
      });
      if (!disposed) await doAttach(false);
    };
    void startMonitoredStream();

    // Keystrokes -> pty. write_session no-ops in Rust until the session registers.
    const dataSub = term.onData((d) => ipc.writeSession(sessionId, d).catch(() => {}));

    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (disposed || !fitVisibleTerminal() || !opened) return;
        const size = `${term.cols}x${term.rows}`;
        if (size === lastResize) return;
        lastResize = size;
        ipc.resizeSession(sessionId, term.cols, term.rows).catch(() => {});
      });
    });
    ro.observe(host);

    return () => {
      disposed = true; // gates every term.write, so in-flight bytes are dropped, not thrown at a torn-down xterm
      window.removeEventListener(APPEARANCE_EVENT, onAppearance);
      if (unlisten) unlisten();
      window.clearTimeout(viewportIdleTimer);
      window.clearTimeout(viewportHardTimer);
      window.clearTimeout(replayRestoreTimer);
      // Detach (don't kill): the pty keeps running in the background so reopening
      // this session reattaches to the same PTY instead of spawning a fresh one.
      // attachId-scoped so a stale detach can't clobber a newer attach's live sink.
      ipc.detachSession(sessionId, attachId).catch(() => {});
      ro.disconnect();
      cancelAnimationFrame(resizeFrame);
      dataSub.dispose();
      term.dispose();
    };
  }, [sessionId, cwd, taskSlug, phase, harness, model, intent, resumeToken, readOnly, terminalFontSize, onConnectionStateChange]);

  return <div ref={hostRef} style={{ width: "100%", height: "100%" }} />;
}
