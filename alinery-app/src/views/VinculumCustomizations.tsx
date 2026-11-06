import { useCallback, useEffect, useRef, useState } from "react";
import { copyTextToClipboard } from "../chat/CopyMessage";
import { askConfirm, confirmDanger } from "../confirm";
import * as ipc from "../ipc";
import * as agent from "../sync/agent";
import { toast } from "../toast";
import type { VinculumCustomizations as Inventory, VinculumCustomization, VinculumDaemonCustomizations, VinculumMcpServer } from "../types";

type Row = { name: string; detail: string; path?: string | null; skillDir?: string };

export function VinculumCustomizations() {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [live, setLive] = useState<VinculumDaemonCustomizations | null>(null);
  const [daemonDown, setDaemonDown] = useState(false);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState(false);
  const [copying, setCopying] = useState(false);
  const [opening, setOpening] = useState(false);
  // The directory is the daemon host's: the Finder shows it only when that host is this machine.
  const [local, setLocal] = useState(true);
  const [uploading, setUploading] = useState(false);
  const request = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++request.current;
    setPending(true);
    setError(false);
    try {
      const host = await agent.agentHost();
      const [files, status] = await Promise.all([
        agent.readCustomizations(),
        agent.readMcpStatus().then(
          (value) => ({ ok: true as const, value }),
          () => ({ ok: false as const, value: null }),
        ),
      ]);
      if (current !== request.current) return;
      setLocal(agent.agentDirIsLocal(host));
      setInventory(files);
      setLive(status.ok ? status.value : null);
      setDaemonDown(!status.ok);
    } catch {
      if (current === request.current) setError(true);
    } finally {
      if (current === request.current) setPending(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      request.current++;
    };
  }, [refresh]);

  const upload = async () => {
    setUploading(true);
    try {
      const path = await ipc.pickVinculumSkillDialog();
      if (!path) return;
      let result = await agent.installSkill(path, false);
      if (result.exists) {
        const replace = await askConfirm({
          title: `Replace ${result.name}?`,
          body: "The installed skill will be replaced. Nothing else in the agent directory changes.",
          choices: [
            { key: "replace", label: "Replace", tone: "danger" },
            { key: "cancel", label: "Cancel", tone: "ghost" },
          ],
          defaultKey: "cancel",
        });
        if (replace !== "replace") return;
        result = await agent.installSkill(path, true);
      }
      toast.success(`Installed ${result.name}`, "short");
      await refresh();
    } catch {
      toast.error("Couldn't install that skill.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <section aria-labelledby="vinculum-customizations-title">
      <h4 id="vinculum-customizations-title">Customizations</h4>
      <p className="hint">Customize this Vinculum installation, whose agent runtime is Pi, or ask an outside coding AI to help.</p>
      <div className="omp-customization-actions">
        {local && (
          <button
            type="button"
            className="btn ghost small"
            disabled={opening}
            onClick={async () => {
              setOpening(true);
              try {
                await ipc.openVinculumAgentDir();
              } catch {
                toast.error("Couldn't open the Vinculum agent folder.");
              } finally {
                setOpening(false);
              }
            }}
          >
            {opening ? "Opening…" : "Open configuration folder"}
          </button>
        )}
        <button
          type="button"
          className="btn ghost small"
          disabled={copying}
          onClick={async () => {
            setCopying(true);
            try {
              await copyTextToClipboard(await agent.customizationPrompt());
              toast.success("Instructions copied", "short");
            } catch {
              toast.error("Couldn't copy the customization instructions. Try again.");
            } finally {
              setCopying(false);
            }
          }}
        >
          {copying ? "Copying…" : "Copy instructions for an AI"}
        </button>
        <button type="button" className="btn ghost small" disabled={uploading} onClick={() => void upload()}>
          {uploading ? "Uploading…" : "Upload skill"}
        </button>
      </div>
      <div className="omp-inventory-heading">
        <h5>Installed customizations</h5>
        <button type="button" className="btn ghost small" disabled={pending} onClick={() => void refresh()}>
          {pending ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <p className="omp-inventory-scope dim">These files live in this installation's vinculum agent directory, not a project .pi directory and not ~/.pi.</p>
      <div aria-live="polite" aria-busy={pending}>
        {pending && !inventory && <p className="dim">Reading installed customizations…</p>}
        {error && (
          <p role="alert" className="field-error">
            Couldn't read installed customizations. {inventory ? "Showing previous results; they may be out of date." : "The inventory is unavailable."} Try Refresh again.
          </p>
        )}
        {inventory && inventory.errors.length > 0 && (
          <div role="alert" className="field-error">
            <p>Partial inventory — some customizations could not be read.</p>
            <ul>
              {inventory.errors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </div>
        )}
        {inventory && (
          <div className="vinculum-customization-groups">
            <Group title="Built-in tools" empty={daemonDown ? "The session daemon is not running." : "No built-in tools were reported."} rows={daemonDown ? [] : toolRows(live)} />
            <Group title="MCP servers" rows={mcpRows(inventory.items, live, daemonDown)} local={local} />
            <Group title="Skills" rows={skillRows(inventory.items)} onDelete={refresh} local={local} />
            <Group title="Extensions" empty="No extensions. They are listed and not loaded." rows={extensionRows(inventory.items)} local={local} />
          </div>
        )}
      </div>
    </section>
  );
}

function Group({ title, rows, empty, onDelete, local = true }: { title: string; rows: Row[]; empty?: string; onDelete?: () => Promise<void>; local?: boolean }) {
  return (
    <section aria-label={title}>
      <h5>{title}</h5>
      {rows.length === 0 ? (
        <p className="dim">{empty}</p>
      ) : (
        <ul aria-label={title} className="omp-customization-list">
          {rows.map((row) => (
            <li key={`${title}:${row.name}:${row.path ?? ""}`}>
              <div className="omp-customization-details">
                <strong>{row.name}</strong>
                <div className="omp-customization-source dim">{row.detail}</div>
              </div>
              {row.path && local && (
                <button
                  type="button"
                  className="btn ghost small"
                  aria-label={`Show ${row.name} in file manager`}
                  title={row.path}
                  onClick={() => {
                    if (row.path) void ipc.revealItemInDir(row.path).catch(() => toast.error("Couldn't show the customization in the file manager."));
                  }}
                >
                  Show in file manager
                </button>
              )}
              {row.skillDir && onDelete && (
                <button
                  type="button"
                  className="btn ghost small"
                  aria-label={`Delete ${row.name}`}
                  onClick={() => {
                    const dir = row.skillDir;
                    if (!dir) return;
                    void confirmDanger(`Delete ${row.name}?`, "This removes that skill directory. A linked skill removes only the link.").then(async (accepted) => {
                      if (!accepted) return;
                      try {
                        await agent.deleteSkill(dir);
                        await onDelete();
                      } catch {
                        toast.error("Couldn't delete that skill.");
                      }
                    });
                  }}
                >
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function toolRows(live: VinculumDaemonCustomizations | null): Row[] {
  return (live?.tools ?? []).map((name) => ({ name, detail: "Vinculum daemon" }));
}

function mcpRows(items: VinculumCustomization[], live: VinculumDaemonCustomizations | null, daemonDown: boolean): Row[] {
  const byName = new Map((live?.servers ?? []).map((server) => [server.name, server]));
  const builtin = byName.get("alinery");
  const rows: Row[] = [
    mcpRow(builtin ?? { name: "alinery", builtin: true, state: "error", error: daemonDown ? "The session daemon is not running." : "could not start" }, "Built-in"),
  ];
  const seen = new Set(["alinery"]);
  for (const item of items.filter((entry) => entry.kind === "MCP server")) {
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    rows.push(
      mcpRow(
        byName.get(item.name) ?? { name: item.name, builtin: false, state: daemonDown ? "error" : "error", error: daemonDown ? "The session daemon is not running." : undefined },
        item.source,
      ),
    );
  }
  return rows;
}

function mcpRow(server: VinculumMcpServer, source: string): Row {
  const state = server.state === "connected" ? "Connected" : server.state === "disabled" ? "Disabled" : `Not connected${server.error ? `: ${server.error}` : ""}`;
  return { name: server.name, detail: `${server.builtin ? "Built-in MCP server" : "MCP server"} · ${state} · ${source}` };
}

function skillRows(items: VinculumCustomization[]): Row[] {
  return items
    .filter((item) => item.kind === "Skill")
    .map((item) => ({
      name: item.name,
      detail: `Skill · ${item.source}${item.offered === false ? " · Not offered to the model" : ""}`,
      path: item.path,
      skillDir: skillDir(item.path),
    }));
}

function extensionRows(items: VinculumCustomization[]): Row[] {
  return items.filter((item) => item.kind === "Extension").map((item) => ({ name: item.name, detail: `Extension · ${item.source} · Listed, not loaded`, path: item.path }));
}

function skillDir(path: string | null): string | undefined {
  if (!path) return undefined;
  const parts = path.split("/");
  if (parts[parts.length - 1] !== "SKILL.md") return undefined;
  const name = parts[parts.length - 2];
  return name && !name.startsWith(".") ? name : undefined;
}
