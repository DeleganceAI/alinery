import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * Without this, one throw anywhere in the tree unmounts the whole app and leaves
 * `#root` empty — which on a dark `--canvas` reads as an unexplained black window
 * in the real WKWebView, with nothing in alinery.log. Noise, never a blank UI.
 *
 * React only routes render/lifecycle errors here, so an event handler or a promise
 * still needs its own try/catch. Boundary errors also reach the webview console,
 * which the dev terminal shows.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("render failed", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="app-shell" style={{ padding: 24, overflow: "auto" }}>
        <h2 style={{ marginTop: 0 }}>Something broke while drawing this screen.</h2>
        <p style={{ color: "var(--text-muted)" }}>The app is still running and your sessions were not touched. Reload the window (Cmd+R) to recover.</p>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, userSelect: "text" }}>{String(error?.stack || error)}</pre>
      </div>
    );
  }
}
