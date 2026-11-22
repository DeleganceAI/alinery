import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "./toast";

/**
 * Pulls the latest now, between the automatic refreshes. It is an icon: it sits in a header beside Copy. A message the
 * pull returns is shown as a toast; a failure always is.
 */
export function PullCommentsButton({ onPull, title = "Pull the latest comments" }: { onPull: () => Promise<string | undefined>; title?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn ghost small"
      title={title}
      aria-label={title}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        onPull()
          .then((message) => {
            if (message) toast.info(message);
          })
          .catch((error) => toast.error(String(error)))
          .finally(() => setBusy(false));
      }}
    >
      <RefreshCw size={14} strokeWidth={1.5} className={busy ? "pull-comments-spin" : undefined} aria-hidden="true" />
    </button>
  );
}
