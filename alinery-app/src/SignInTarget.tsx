import { useEffect, useState } from "react";
import * as ipc from "./ipc";
import { parseRemoteRepo } from "./remoteRepo";

/**
 * Says which machine a sign-in lands on. With a remote repository open, accounts are signed in on
 * its host, not on this Mac, and that is easy to miss.
 *
 * `repo` is the repository the accounts belong to (a chat names its own). Without it the open
 * repository answers, which is what a settings-wide surface means.
 */
export function SignInTarget({ repo }: { repo?: string }) {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const remote = parseRemoteRepo(repo ?? (await ipc.readAppConfig()).active_repo);
        if (!remote) return;
        const host = (await ipc.remoteHosts()).find((row) => row.host_id === remote.hostId);
        if (!cancelled) setLabel(host?.label || remote.hostId);
      } catch {
        // The accounts list works without the label.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repo]);
  if (!label) return null;
  return (
    <p className="dsc sign-in-target">
      This repository lives on <strong>{label}</strong>, so sign-ins here are stored there, not on this Mac. A repository on this Mac signs in on its own.
    </p>
  );
}
