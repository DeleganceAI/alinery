import { type ReactNode, useEffect, useState } from "react";
import { filesAreRemote, revealActionLabel, revealPath } from "./revealPath";
import { alineryFilePath, attachmentFilePath, readNodeBytes } from "./sync/artifacts";
import { readAttachmentBytes } from "./sync/tasks";

/**
 * Blob URL for an attachment image, read from the daemon (BlobService, so a remote repo works too): a tree node by
 * `nodeId`, an attachment of the task by `name`. Empty while loading or when `name` is empty; `setError` lets a caller
 * report a decode or reveal failure in the same slot.
 */
export function useAttachmentImageSrc(repoPath: string, taskSlug: string, name: string, nodeId?: string) {
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let url = "";
    setSrc("");
    setError("");
    if (!name) return;
    (nodeId ? readNodeBytes(repoPath, taskSlug, nodeId) : readAttachmentBytes(repoPath, taskSlug, name)).then(
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

  return { src, error, setError };
}

/** `revealBelow` is a tree node's path below `.alinery/`; without it the attachment's own place is used. */
export function AttachmentPreview({
  taskSlug,
  name,
  nodeId,
  repoPath,
  revealBelow,
  children,
}: {
  taskSlug: string;
  name: string;
  nodeId?: string;
  repoPath: string;
  revealBelow?: string;
  children?: ReactNode;
}) {
  const { src, error, setError } = useAttachmentImageSrc(repoPath, taskSlug, name, nodeId);

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
        {(!nodeId || revealBelow) && (
          <button
            type="button"
            className="btn ghost small"
            aria-label={filesAreRemote() ? `Copy path of ${name} on host` : `Show ${name} in folder`}
            onClick={() => {
              const path = revealBelow ? alineryFilePath(repoPath, revealBelow) : attachmentFilePath(repoPath, taskSlug, name);
              revealPath(path).catch((reason) => setError(String(reason)));
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
