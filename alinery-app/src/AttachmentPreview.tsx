import { type ReactNode, useEffect, useState } from "react";
import * as ipc from "./ipc";
import { filesAreRemote, revealActionLabel, revealPath } from "./revealPath";
import { readAttachmentBytes } from "./sync/tasks";

/**
 * `repoPath` set and no `nodeId`: the image is read from the daemon (BlobService). A tree node is still resolved by the
 * shell until the artifact tree moves to the daemon (S4.5).
 */
export function AttachmentPreview({ taskSlug, name, nodeId, repoPath, children }: { taskSlug: string; name: string; nodeId?: string; repoPath?: string; children?: ReactNode }) {
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let url = "";
    setSrc("");
    setError("");
    (repoPath && !nodeId ? readAttachmentBytes(repoPath, taskSlug, name) : ipc.readAttachmentImage(taskSlug, name, nodeId)).then(
      (bytes) => {
        if (cancelled) return;
        url = URL.createObjectURL(new Blob([bytes]));
        setSrc(url);
      },
      (reason) => {
        if (!cancelled) setError(String(reason));
      },
    );
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [taskSlug, name, nodeId, repoPath]);

  return (
    <details className="attachment-preview" open>
      <summary title={name}>
        <span className="artifactitem-name">{name}</span>
      </summary>
      <div className="attachment-preview-body">
        {error ? (
          <p className="dim" role="status">
            Couldn’t preview this image: {error}
          </p>
        ) : src ? (
          <img src={src} alt={name} onError={() => setError("The image could not be decoded.")} />
        ) : (
          <p className="dim" role="status">
            Loading image…
          </p>
        )}
      </div>
      <div className="attachment-preview-actions">
        {/* An attachment's path is on this machine only for a local repo; the daemon never hands out a path. */}
        {(nodeId || !filesAreRemote()) && (
          <button
            type="button"
            className="btn ghost small"
            aria-label={filesAreRemote() ? `Copy path of ${name} on host` : `Show ${name} in folder`}
            onClick={() => {
              const path = nodeId ? ipc.artifactNodePath(taskSlug, nodeId) : ipc.attachmentPath(taskSlug, name);
              path.then(revealPath).catch((reason) => setError(String(reason)));
            }}
          >
            {revealActionLabel()}
          </button>
        )}
        {children}
      </div>
    </details>
  );
}
