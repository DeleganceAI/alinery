import ReactDOM from "react-dom/client";
import App from "./App";
import "./theme.css";

// No <StrictMode>: its dev double-mount churns the heavyweight `claude` pty
// (mount spawns, cleanup detaches, remount reattaches). open_session is idempotent
// in Rust (reattaches rather than double-spawning), but skipping the churn is cheaper.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
