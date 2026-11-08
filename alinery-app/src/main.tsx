import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { installGlobalErrorReports } from "./globalErrors";
import "./theme.css";

installGlobalErrorReports();

// No <StrictMode>: its dev double-mount churns the heavyweight `claude` pty
// (mount spawns, cleanup detaches, remount reattaches). ResumeSession is idempotent
// in Rust (reattaches rather than double-spawning), but skipping the churn is cheaper.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
