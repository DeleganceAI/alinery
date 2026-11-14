import { X } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { askConfirm } from "./confirm";
import * as ipc from "./ipc";
import { HOST_KEY_UNKNOWN } from "./remoteRepo";
import { parseRefusal, refusalAdvice, sshDestination } from "./setup";
import { Dialog, InlineStatus } from "./shared";
import type { HostRefusal, RemoteHostView, SshTarget } from "./types";

/** What a failed test or add shows: the fix for a refused host, or the plain reason. */
export function RefusalNotice({ message }: { message: string }) {
  const refusal: HostRefusal | null = parseRefusal(message);
  if (!refusal) return <InlineStatus tone="error">{message.replace(`${HOST_KEY_UNKNOWN}: `, "")}</InlineStatus>;
  const advice = refusalAdvice(refusal);
  return (
    <InlineStatus tone="error">
      <strong>{advice.title}.</strong> {advice.fix}
      {advice.command ? <code className="setup-fix-command">{advice.command}</code> : null}
    </InlineStatus>
  );
}

type TestState = { kind: "idle" } | { kind: "testing" } | { kind: "ok"; platform: string } | { kind: "failed"; message: string };

const targetText = (alias: string, target: SshTarget) => {
  const login = target.user ? `${target.user}@${target.hostname}` : target.hostname;
  return `${alias} connects to ${login}, port ${target.port}${target.jump ? `, through ${target.jump}` : ""}.`;
};

/**
 * Save an ssh host: a friendly name, the host (`user@host` or an alias from `~/.ssh/config`), and optionally a port and a key.
 * An empty field adds no flag. "Test connection" probes the unsaved host and shows why it would be refused; it never blocks
 * saving. Saving connects to nothing and installs nothing.
 */
export function AddSshHostDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (host: RemoteHostView) => void }) {
  const [label, setLabel] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [key, setKey] = useState("");
  const [aliases, setAliases] = useState<string[]>([]);
  const [target, setTarget] = useState<SshTarget | null>(null);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [error, setError] = useState("");
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void ipc.remoteSshAliases().then(
      (found) => alive.current && setAliases(found),
      () => undefined,
    );
    return () => {
      alive.current = false;
    };
  }, []);

  const chosen = host.trim();
  useEffect(() => {
    if (!aliases.includes(chosen)) {
      setTarget(null);
      return;
    }
    let current = true;
    void ipc.remoteDescribeDestination(chosen).then(
      (found) => current && setTarget(found),
      () => current && setTarget(null),
    );
    return () => {
      current = false;
    };
  }, [aliases, chosen]);

  const destination = () => sshDestination({ host, port, key });
  const changed = () => {
    setTest({ kind: "idle" });
    setError("");
  };

  const runTest = async () => {
    setTest({ kind: "testing" });
    setError("");
    let trust = false;
    for (;;) {
      try {
        const report = await ipc.remoteTestHost(destination(), trust);
        if (alive.current) setTest({ kind: "ok", platform: report.glibc ? `${report.platform}, glibc ${report.glibc}` : report.platform });
        return;
      } catch (e) {
        const message = String(e);
        if (!trust && message.includes(HOST_KEY_UNKNOWN)) {
          const choice = await askConfirm({
            title: "Trust this host?",
            body: `${chosen} has not been seen before. Its key will be added to your known hosts, and later connections must match it. Only continue if you expect to be connecting to this machine.`,
            choices: [
              { key: "trust", label: "Trust and test" },
              { key: "cancel", label: "Cancel", tone: "ghost" },
            ],
          });
          if (choice === "trust") {
            trust = true;
            continue;
          }
        }
        if (alive.current) setTest({ kind: "failed", message });
        return;
      }
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      const saved = await ipc.remoteAddHost(destination(), label.trim() || undefined);
      onAdded(saved);
    } catch (e) {
      if (alive.current) setError(String(e));
    }
  };

  return (
    <Dialog onClose={onClose} ariaLabel="Add SSH connection" className="remote-dialog">
      <div className="mh">
        <span className="mt">Add SSH connection</span>
        <button type="button" className="x" aria-label="Close" title="Close" onClick={onClose}>
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
      <form onSubmit={(event) => void submit(event)}>
        <div className="mb remote-body">
          <label className="chat-dialog-field">
            <span>Name</span>
            <input type="text" className="remote-input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="A friendly name (optional)" spellCheck={false} />
          </label>
          <label className="chat-dialog-field">
            <span>SSH host</span>
            <input
              type="text"
              className="remote-input"
              list="setup-ssh-aliases"
              value={host}
              onChange={(e) => {
                setHost(e.target.value);
                changed();
              }}
              placeholder="user@hostname, or a host from ~/.ssh/config"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              data-autofocus
            />
            <datalist id="setup-ssh-aliases">
              {aliases.map((alias) => (
                <option key={alias} value={alias} />
              ))}
            </datalist>
          </label>
          {target ? (
            <p className="dsc" aria-live="polite">
              {targetText(chosen, target)}
            </p>
          ) : null}
          <label className="chat-dialog-field">
            <span>SSH port</span>
            <input
              type="text"
              inputMode="numeric"
              className="remote-input"
              value={port}
              onChange={(e) => {
                setPort(e.target.value);
                changed();
              }}
              placeholder="22, or whatever your ssh config says"
              spellCheck={false}
            />
          </label>
          <label className="chat-dialog-field">
            <span>SSH key</span>
            <input
              type="text"
              className="remote-input"
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                changed();
              }}
              placeholder="Optional. Empty uses your ssh config or agent"
              spellCheck={false}
            />
          </label>
          <p className="dsc">
            Alinery connects without prompts, so your key must be in ssh-agent or given here. The host needs Linux (x64 or arm64) with git, zip, unzip, tar, gzip and sha256sum, or
            macOS 13 or later with Remote Login on and git. Jump hosts and other options belong in your ssh config.
          </p>
          {test.kind === "ok" ? (
            <InlineStatus tone="success">Reachable: {test.platform}. Nothing was installed.</InlineStatus>
          ) : test.kind === "failed" ? (
            <RefusalNotice message={test.message} />
          ) : null}
          {error ? <RefusalNotice message={error} /> : null}
        </div>
        <div className="mfoot chat-new-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn ghost" disabled={!chosen || test.kind === "testing"} onClick={() => void runTest()}>
            {test.kind === "testing" ? "Testing…" : "Test connection"}
          </button>
          <button type="submit" className="btn" disabled={!chosen}>
            Add SSH connection
          </button>
        </div>
      </form>
    </Dialog>
  );
}
