import { useCallback, useEffect, useRef, useState } from "react";
import { copyTextToClipboard } from "../chat/CopyMessage";
import { askConfirm, confirmDanger } from "../confirm";
import * as ipc from "../ipc";
import * as agent from "../sync/agent";
import { toast } from "../toast";
import type { VinculumCustomizations as Inventory, SkillSummary, VinculumCustomization, VinculumDaemonCustomizations, VinculumMcpServer } from "../types";

type Row = { name: string; detail: string; path?: string | null };

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
  // Fetched ahead: WebKit refuses a clipboard write once the click has waited on a daemon round trip.
  const prompt = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const current = ++request.current;
    setPending(true);
    setError(false);
    try {
      const host = await agent.agentHost();
      void agent.customizationPrompt().then(
        (text) => {
          prompt.current = text;
        },
        () => undefined,
      );
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
      <p className="hint">Customize this installation's Vinculum harness, or ask an outside coding AI to help.</p>
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
              await copyTextToClipboard(prompt.current ?? (await agent.customizationPrompt()));
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
      <p className="omp-inventory-scope dim">These files live in this installation's Vinculum agent directory, the only place Vinculum reads them from.</p>
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
            <SkillsGroup inventory={inventory} onChange={refresh} local={local} />
            <Group title="Extensions" empty="No extensions. They are listed and not loaded." rows={extensionRows(inventory.items)} local={local} />
          </div>
        )}
      </div>
    </section>
  );
}

/** The counter over the skills: how many are on against the limit, and roughly what the list costs every prompt. */
export function skillCounter(skills: SkillSummary): string {
  const tokens = Math.round(skills.catalogChars / 4);
  const cost = tokens > 0 ? ` · about ${tokens.toLocaleString("en-US")} tokens in every prompt` : "";
  const over = skills.on > skills.limit ? ` · only the first ${skills.limit} are offered` : "";
  return `${skills.on} of ${skills.limit} on${cost}${over}`;
}

function SkillsGroup({ inventory, onChange, local }: { inventory: Inventory; onChange: () => Promise<void>; local: boolean }) {
  const skills = inventory.items.filter((item) => item.kind === "Skill");
  const summary = inventory.skills;
  const full = !!summary && summary.on >= summary.limit;
  const act = (run: () => Promise<void>, failure: string) =>
    void run().then(onChange, (cause: unknown) => toast.error(cause instanceof Error && cause.message ? cause.message : failure));
  return (
    <section aria-label="Skills">
      <h5>Skills</h5>
      {summary && <p className="dim skill-counter">{skillCounter(summary)}</p>}
      {skills.length === 0 ? null : (
        <ul aria-label="Skills" className="omp-customization-list">
          {skills.map((item) => {
            const dir = item.included ? undefined : skillDir(item.path);
            const on = item.enabled !== false;
            const blocked = !on && full;
            const detail = item.included ? item.source : `Skill · ${item.source}`;
            return (
              <li key={`skill:${item.name}:${item.path ?? ""}`}>
                <label className="skill-switch" title={blocked ? `At most ${summary?.limit} skills can be on at once. Turn one off first.` : undefined}>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={`${item.name} on`}
                    checked={on}
                    aria-checked={on}
                    disabled={blocked}
                    onChange={() => act(() => agent.setSkillEnabled(item.name, !on), "Couldn't change that skill.")}
                  />
                </label>
                <div className="omp-customization-details">
                  <strong>{item.name}</strong>
                  {item.included && <span className="badge skill-included">Included</span>}
                  <div className="omp-customization-source dim">
                    {detail}
                    {item.offered === false && !item.included ? " · Not offered to the model" : ""}
                  </div>
                </div>
                {item.path && local && <Reveal name={item.name} path={item.path} />}
                {item.included ? (
                  <button
                    type="button"
                    className="btn ghost small"
                    aria-label={`Remove ${item.name}`}
                    onClick={() =>
                      void confirmDanger(`Remove ${item.name}?`, "It stays hidden, even after Alinery updates, until you restore the included skills.").then((accepted) => {
                        if (accepted) act(() => agent.deleteSkill(item.name, undefined, true), "Couldn't remove that skill.");
                      })
                    }
                  >
                    Remove
                  </button>
                ) : (
                  dir && (
                    <button
                      type="button"
                      className="btn ghost small"
                      aria-label={`Delete ${item.name}`}
                      onClick={() =>
                        void confirmDanger(`Delete ${item.name}?`, "This removes that skill directory. A linked skill removes only the link.").then((accepted) => {
                          if (accepted) act(() => agent.deleteSkill(dir), "Couldn't delete that skill.");
                        })
                      }
                    >
                      Delete
                    </button>
                  )
                )}
              </li>
            );
          })}
        </ul>
      )}
      {summary && summary.removed.length > 0 && (
        <button type="button" className="btn ghost small" onClick={() => act(() => agent.restoreIncludedSkills(), "Couldn't restore the included skills.")}>
          Restore {summary.removed.length} removed included skill{summary.removed.length === 1 ? "" : "s"}
        </button>
      )}
    </section>
  );
}

function Reveal({ name, path }: { name: string; path: string }) {
  return (
    <button
      type="button"
      className="btn ghost small"
      aria-label={`Show ${name} in file manager`}
      title={path}
      onClick={() => void ipc.revealItemInDir(path).catch(() => toast.error("Couldn't show the customization in the file manager."))}
    >
      Show in file manager
    </button>
  );
}

function Group({ title, rows, empty, local = true }: { title: string; rows: Row[]; empty?: string; local?: boolean }) {
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
              {row.path && local && <Reveal name={row.name} path={row.path} />}
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
