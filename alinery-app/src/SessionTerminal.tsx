import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { APPEARANCE_EVENT } from "./appearance";
import * as ipc from "./ipc";
import { observationNow } from "./sync/sessionObservation";
import { type OpenSessionArgs, openSession, readSessionHistory } from "./sync/sessions";
import { terminalLink } from "./sync/terminal";
import { attachGpuRenderer } from "./terminalRenderer";
import { restoreViewport, saveViewport } from "./terminalViewport";
import type { SessionObservation } from "./types";
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

// `streamToken` is unique per attach within a mount, so a stale timer cannot act on a newer attach.
let nextStreamToken = 1;

export type SessionTerminalConnectionState = "opening" | "open" | "recovering" | "failed";
// One xterm pane bound to one pty session. Bytes are written straight to the
// terminal — never through React state (pty output is thousands of tiny writes/sec).
// M3: taskSlug + phase let a FRESH spawn seed Vinculum with the phase prompt. On
// reattach the backend ignores them (Vinculum already has it), so passing them always
// is safe.
/**
 * What a terminal needs beside its byte stream (`TerminalService`, sync/terminal.ts). Default: the
 * active repo; a chat thread passes its own repo, and has nothing to start.
 */
export type SessionTerminalIo = {
  /** Spawn or resume the shell. Not called to rejoin a running one. */
  open: (args: OpenSessionArgs) => Promise<void>;
  /** The repo key the daemon is reached by. */
  repo: () => Promise<string>;
  status: () => Promise<SessionObservation>;
};

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
  keepViewport,
  onConnectionStateChange,
  io,
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
  // Put a scrolled-back view back after a remount (the drawer swaps panes on tab switch).
  keepViewport?: boolean;
  onConnectionStateChange?: (state: SessionTerminalConnectionState) => void;
  /** Must keep a stable identity: a new object tears down and reattaches the terminal. */
  io?: SessionTerminalIo;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const sessionIo: SessionTerminalIo = io ?? {
      open: async (args) => openSession((await ipc.readAppConfig()).active_repo, args),
      repo: async () => (await ipc.readAppConfig()).active_repo,
      status: async () => observationNow((await ipc.readAppConfig()).active_repo, taskSlug, sessionId),
    };
    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      // main.tsx waits for the bundled mono face before the first render, so xterm measures its cells, not the fallback's.
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "Menlo, monospace",
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

    // The pty keeps running in the daemon after we navigate away (the "bag" of live sessions).
    // Detaching stops the stream, but a few bytes may already be in flight — guard against writing
    // to a disposed terminal so they're dropped instead of thrown at a torn-down xterm.
    let disposed = false;

    if (readOnly) {
      // Read-only history replay (issue #24 P7): fetch the session's recorded activity
      // chunks once and write them. NO ResumeSession/attach, NO stdin, NO daemon resize —
      // this pane never touches the daemon, so it works after the pty (and daemon) are gone.
      sessionIo
        .repo()
        .then((repo) => readSessionHistory(repo, { id: sessionId, taskSlug: taskSlug || null }))
        .then((bytes) => {
          if (disposed) return;
          if (bytes.byteLength) term.write(new Uint8Array(bytes));
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

    // Start the shell (spawn or resume) if asked to, THEN attach: the stream replays the screen from
    // the last offset this pane rendered, so a reattach repeats and loses nothing.
    let currentStreamToken = 0;
    let reattachCount = 0;
    let lastClose = 0;
    let opened = false;
    let link: ReturnType<typeof terminalLink> | null = null;
    // The live view stopped because the daemon could not be reached (a remote host that dropped).
    let paused = false;
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
      if (keepViewport) restoreViewport(sessionId, term);
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
      void Promise.resolve(link?.resize(cols - 1, rows))
        .catch(() => {})
        .finally(() => {
          replayRestoreTimer = window.setTimeout(() => {
            if (disposed || currentStreamToken !== streamToken) return;
            term.resize(cols, rows);
            lastResize = `${cols}x${rows}`;
            void link?.resize(cols, rows).catch(() => {});
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

    // The shell ended: its stream closing is not a drop to recover from.
    let exited = false;
    const onStreamClosed = async () => {
      const streamToken = currentStreamToken;
      if (disposed || exited) return;
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
        const obs = await sessionIo.status();
        if (disposed || exited || streamToken !== currentStreamToken || (obs.lifecycle.state !== "live" && obs.lifecycle.state !== "live_exited")) {
          return;
        }
      } catch (e) {
        if (!disposed && streamToken === currentStreamToken) {
          term.writeln(`\r\n[live view paused — status unavailable; reopen to resume] ${String(e)}`);
          paused = true;
          onConnectionStateChange?.("failed");
        }
        return;
      }
      setTimeout(() => {
        if (disposed || streamToken !== currentStreamToken) return;
        void doAttach(true);
      }, 400 * reattachCount);
    };

    // Start the shell if this mount spawns or resumes it, then attach from the last offset. The stream
    // carries the geometry, so no separate resize follows.
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
      try {
        // A reattach only rejoins the live pty; it never re-spawns or re-resumes the harness.
        if (!reattach && intent !== "attach") {
          await sessionIo.open({
            id: sessionId,
            cwd,
            taskSlug: taskSlug || null,
            // Seed the phase prompt only on a genuine fresh spawn.
            phase: intent === "spawn" ? phase || null : null,
            model,
            harness,
            intent,
            resumeToken: resumeToken ?? null,
            cols: geometryReady ? term.cols : null,
            rows: geometryReady ? term.rows : null,
          });
          if (disposed || currentStreamToken !== streamToken) return false;
        }
        const repo = await sessionIo.repo();
        if (disposed || currentStreamToken !== streamToken) return false;
        link ??= terminalLink(
          repo,
          { taskSlug, id: sessionId },
          {
            data: (bytes) => {
              if (!disposed) term.write(bytes, () => scheduleReplayViewportSync(currentStreamToken));
            },
            exit: () => {
              exited = true;
            },
            closed: () => void onStreamClosed(),
            reset: () => term.reset(),
          },
        );
        await link.attach(geometryReady ? { cols: term.cols, rows: term.rows } : null);
        if (disposed) link.detach();
        if (disposed || currentStreamToken !== streamToken) return false;
        opened = true;
        lastResize = geometryReady ? `${term.cols}x${term.rows}` : lastResize;
        onConnectionStateChange?.("open");
        return true;
      } catch (e) {
        if (!disposed && currentStreamToken === streamToken) {
          const message = reattach ? "\r\n[live view paused — stream recovery failed; reopen to resume] " : "\r\n[spawn failed] ";
          term.writeln(message + String(e));
          paused = reattach;
        }
        onConnectionStateChange?.("failed");
        return false;
      }
    };

    const start = async () => {
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
    void start();

    // A remote host that dropped is back: rejoin the live pty the lost stream left paused.
    const stopHostWatch = ipc.onRemoteHostConnected(() => {
      if (disposed || !paused) return;
      paused = false;
      reattachCount = 0;
      void doAttach(true);
    });

    // Keystrokes -> pty. They wait in the link until the attach has an id.
    const dataSub = term.onData((d) => void link?.write(d).catch(() => {}));

    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (disposed || !fitVisibleTerminal() || !opened) return;
        const size = `${term.cols}x${term.rows}`;
        if (size === lastResize) return;
        lastResize = size;
        void link?.resize(term.cols, term.rows).catch(() => {});
      });
    });
    ro.observe(host);

    return () => {
      disposed = true; // gates every term.write, so in-flight bytes are dropped, not thrown at a torn-down xterm
      window.removeEventListener(APPEARANCE_EVENT, onAppearance);
      stopHostWatch();
      window.clearTimeout(viewportIdleTimer);
      window.clearTimeout(viewportHardTimer);
      window.clearTimeout(replayRestoreTimer);
      // Detach (don't kill): the pty keeps running in the background so reopening
      // this session reattaches to the same PTY instead of spawning a fresh one.
      link?.detach();
      ro.disconnect();
      cancelAnimationFrame(resizeFrame);
      dataSub.dispose();
      if (keepViewport) saveViewport(sessionId, term);
      term.dispose();
    };
  }, [sessionId, cwd, taskSlug, phase, harness, model, intent, resumeToken, readOnly, keepViewport, terminalFontSize, onConnectionStateChange, io]);

  return <div ref={hostRef} style={{ width: "100%", height: "100%" }} />;
}
