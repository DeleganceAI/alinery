import { useCallback, useEffect, useRef, useState } from "react";
import { copyTextToClipboard } from "../chat/CopyMessage";
import * as ipc from "../ipc";
import { toast } from "../toast";
import type { OmpCustomizations as Inventory } from "../types";

export function OmpCustomizations() {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState(false);
  const [copying, setCopying] = useState(false);
  const [opening, setOpening] = useState(false);
  const request = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++request.current;
    setPending(true);
    setError(false);
    try {
      const result = await ipc.readOmpCustomizations();
      if (current === request.current) setInventory(result);
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

  return (
    <section aria-labelledby="omp-customizations-title">
      <h4 id="omp-customizations-title">Customizations</h4>
      <p className="hint">Customize this OMP installation or ask an outside coding AI to help.</p>
      <div className="omp-customization-actions">
        <button
          type="button"
          className="btn ghost small"
          disabled={opening}
          onClick={async () => {
            setOpening(true);
            try {
              await ipc.openOmpConfigDir();
            } catch {
              toast.error("Couldn't open the OMP configuration folder.");
            } finally {
              setOpening(false);
            }
          }}
        >
          {opening ? "Opening…" : "Open configuration folder"}
        </button>
        <button
          type="button"
          className="btn ghost small"
          disabled={copying}
          onClick={async () => {
            setCopying(true);
            try {
              await copyTextToClipboard(await ipc.ompCustomizationPrompt());
              toast.success("Instructions copied", "short");
            } catch {
              toast.error("Couldn't copy the OMP customization instructions. Try again.");
            } finally {
              setCopying(false);
            }
          }}
        >
          {copying ? "Copying…" : "Copy instructions for an AI"}
        </button>
      </div>
      <div className="omp-inventory-heading">
        <h5>Installed customizations</h5>
        <button type="button" className="btn ghost small" disabled={pending} onClick={() => void refresh()}>
          {pending ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <p className="omp-inventory-scope dim">
        Items installed in this configuration and CLI-reported plugin packages, plus Alinery’s injected integration. This is not a list of what running sessions have loaded.
        Project-specific and externally discovered customizations are not included.
      </p>
      <div aria-live="polite" aria-busy={pending}>
        {pending && <p className="dim">Reading installed customizations…</p>}
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
        {inventory && inventory.items.length > 0 && (
          <ul aria-label="Installed customizations" className="omp-customization-list">
            {inventory.items.map((item) => (
              <li key={`${item.kind}:${item.source}:${item.path}:${item.name}`}>
                <div className="omp-customization-details">
                  <strong>{item.name}</strong>
                  <div className="omp-customization-source dim">
                    Type: {item.kind} · Source: {item.source}
                  </div>
                </div>
                {item.path && (
                  <button
                    type="button"
                    className="btn ghost small"
                    aria-label={`Show ${item.name} in file manager`}
                    title={item.path}
                    onClick={() => {
                      if (item.path) void ipc.revealItemInDir(item.path).catch(() => toast.error("Couldn't show the customization in the file manager."));
                    }}
                  >
                    Show in file manager
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {inventory && inventory.items.length === 0 && inventory.errors.length === 0 && !error && !pending && <p className="dim">No customizations found in this configuration.</p>}
      </div>
    </section>
  );
}
