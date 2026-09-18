import { useState } from "react";
import ReactDOM from "react-dom/client";
import { ConfirmHost } from "./confirm";
import { Playbooks } from "./views/Playbooks";
import { CreateTaskPage } from "./views/CreateTaskPage";
import "./theme.css";
import "./App.css";

function Smoke({ repo }: { repo: string }) {
  const [page, setPage] = useState<"playbooks" | "create">("playbooks");
  return <div style={{ maxWidth: 1200, margin: "20px auto", padding: 20 }}>
    <p>Browser-only IPC adapter. Library operations execute the real Rust parser and filesystem library.</p>
    <nav aria-label="Smoke navigation" style={{ display: "flex", gap: 12, marginBottom: 20 }}>
      <button type="button" onClick={() => setPage("playbooks")}>Playbooks surface</button>
      <button type="button" onClick={() => setPage("create")}>Task creation surface</button>
    </nav>
    {page === "playbooks" ? <Playbooks repoPath={repo} /> : <CreateTaskPage activeRepo={repo} knownRepos={[repo]} onCancel={() => setPage("playbooks")} onCreated={() => { throw new Error("Task provisioning is verified by the separate real-daemon smoke"); }} />}
    <ConfirmHost />
  </div>;
}

const bridge = new URLSearchParams(window.location.search).get("bridge") || "http://127.0.0.1:31627";
const fixture = await fetch(`${bridge}/status`).then((response) => response.json());
if (typeof fixture.repo !== "string") throw new Error("Invalid smoke fixture response");
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<Smoke repo={fixture.repo} />);
