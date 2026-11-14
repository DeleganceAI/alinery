import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { installGlobalErrorReports } from "./globalErrors";
// The alinery.ai faces, bundled so they load offline; theme.css keeps the system stacks behind them.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource/sora/400.css";
import "@fontsource/sora/600.css";
import "./theme.css";

installGlobalErrorReports();

// Load the faces before the first paint: no flash of the fallback, and a terminal that mounts at once
// measures its cell grid against Geist Mono. A face that fails to load leaves the fallback stack in use.
const faces = ['13px "Geist Variable"', '13px "Geist Mono Variable"', '400 16px "Sora"', '600 16px "Sora"'];
Promise.allSettled(faces.map((face) => document.fonts.load(face))).then(() =>
  // No <StrictMode>: its dev double-mount churns the heavyweight `claude` pty
  // (mount spawns, cleanup detaches, remount reattaches). ResumeSession is idempotent
  // in Rust (reattaches rather than double-spawning), but skipping the churn is cheaper.
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>,
  ),
);
