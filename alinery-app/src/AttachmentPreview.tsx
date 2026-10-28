import { type ReactNode, useEffect, useState } from "react";
import * as ipc from "./ipc";

/** Blob URL for an attachment image (empty while loading or when `name` is empty); `setError` lets callers report decode/reveal failures in the same slot. */
export function useAttachmentImageSrc(taskSlug: string, name: string, nodeId?: string) {
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let url = "";
    setSrc("");
    setError("");
    if (!name) return;
    ipc.readAttachmentImage(taskSlug, name, nodeId).then(
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
  }, [taskSlug, name, nodeId]);

  return { src, error, setError };
}

export function AttachmentPreview({ taskSlug, name, nodeId, children }: { taskSlug: string; name: string; nodeId?: string; children?: ReactNode }) {
  const { src, error, setError } = useAttachmentImageSrc(taskSlug, name, nodeId);

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
        <button
          type="button"
          className="btn ghost small"
          aria-label={`Show ${name} in folder`}
          onClick={() => {
            const path = nodeId ? ipc.artifactNodePath(taskSlug, nodeId) : ipc.attachmentPath(taskSlug, name);
            path.then(ipc.revealItemInDir).catch((reason) => setError(String(reason)));
          }}
        >
          Show in folder
        </button>
        {children}
      </div>
    </details>
  );
}
