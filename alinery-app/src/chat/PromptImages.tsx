import { Check, Copy, Image as ImageIcon, TriangleAlert, X } from "lucide-react";
import { createContext, useContext, useEffect, useState } from "react";
import { Dialog } from "../shared";
import { toast } from "../toast";
import type { UserRowAttachment } from "./attachments";

/**
 * Reads one attached image back from the daemon, by the name it was copied under: a chat thread's own
 * attachment directory, or a task session's. Only the view knows which one this pane is, so it supplies
 * this — a prompt's row never carries the bytes itself, only the name of the file the model was given.
 */
export type PromptImageReader = (name: string) => Promise<{ mime_type: string; data: string }>;

export const PromptImageReaderContext = createContext<PromptImageReader | null>(null);

/** PNG bytes for the system clipboard: a pasted screenshot already is one; anything else is drawn first. */
async function pngBlob(src: string): Promise<Blob> {
  const blob = await (await fetch(src)).blob();
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("the image could not be drawn");
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((out) => (out ? resolve(out) : reject(new Error("the image could not be encoded"))), "image/png");
  });
}

/** The image bytes on the clipboard again, as PNG, so they can be pasted anywhere. */
export async function copyImageToClipboard(src: string): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("the clipboard does not take images");
  await navigator.clipboard.write([new ClipboardItem({ "image/png": await pngBlob(src) })]);
}

/** A prompt image's own `src` when it carries one (a live message, or the send's own preview), else the copy on disk. */
function usePromptImageSrc(image: UserRowAttachment): { src: string; error: string } {
  const read = useContext(PromptImageReaderContext);
  const [loaded, setLoaded] = useState("");
  const [error, setError] = useState("");
  const direct = image.src ?? "";
  const name = image.name;
  useEffect(() => {
    let cancelled = false;
    setLoaded("");
    setError("");
    if (direct || !read || !name) return;
    read(name).then(
      (image) => {
        if (!cancelled) setLoaded(`data:${image.mime_type};base64,${image.data}`);
      },
      (reason) => {
        if (!cancelled) setError(String(reason));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [direct, read, name]);
  return { src: direct || loaded, error };
}

function CopyImageButton({ src }: { src: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const label = state === "copied" ? "Copied image" : state === "failed" ? "Could not copy the image" : "Copy image";
  return (
    <button
      type="button"
      className="btn ghost small"
      title={label}
      aria-label={label}
      onClick={async () => {
        try {
          await copyImageToClipboard(src);
          setState("copied");
        } catch (reason) {
          setState("failed");
          toast(String(reason), "error");
        }
        window.setTimeout(() => setState("idle"), 1200);
      }}
    >
      {state === "copied" ? (
        <Check size={14} strokeWidth={2} aria-hidden="true" />
      ) : state === "failed" ? (
        <TriangleAlert size={14} strokeWidth={2} aria-hidden="true" />
      ) : (
        <Copy size={14} strokeWidth={1.5} aria-hidden="true" />
      )}
      <span>{state === "copied" ? "Copied" : "Copy"}</span>
    </button>
  );
}

function PromptImageLightbox({ image, src, onClose }: { image: UserRowAttachment; src: string; onClose: () => void }) {
  const name = image.name || "Attached image";
  return (
    <Dialog className="prompt-image-lightbox" ariaLabel={name} onClose={onClose}>
      <div className="mh">
        <span className="mt">{name}</span>
        <span className="prompt-image-lightbox-actions">
          <CopyImageButton src={src} />
          <button type="button" className="x" aria-label="Close the image" title="Close" data-autofocus onClick={onClose}>
            <X size={16} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </span>
      </div>
      <div className="mb prompt-image-lightbox-body">
        <img src={src} alt={name} />
      </div>
    </Dialog>
  );
}

function PromptImageTile({ image, onOpen }: { image: UserRowAttachment; onOpen: (src: string) => void }) {
  const { src, error } = usePromptImageSrc(image);
  const name = image.name || "Attached image";
  if (!src) {
    return (
      <span
        className="chat-prompt-image is-missing"
        title={error ? `Could not read ${name}: ${error}` : `Loading ${name}…`}
        role="img"
        aria-label={error ? `${name} could not be read` : name}
      >
        <ImageIcon size={18} strokeWidth={1.5} aria-hidden="true" />
      </span>
    );
  }
  return (
    <button type="button" className="chat-prompt-image" title={`Open ${name}`} aria-label={`Open ${name}`} onClick={() => onOpen(src)}>
      <img src={src} alt={name} />
    </button>
  );
}

/**
 * A prompt's attached images, in one row directly below its text: the row scrolls sideways when they do
 * not fit, and each opens larger with its bytes a click from the clipboard. Shared by the chat tab and
 * a session's chat, which differ only in the reader they provide.
 */
export function PromptImages({ images }: { images: UserRowAttachment[] }) {
  const [opened, setOpened] = useState<{ image: UserRowAttachment; src: string } | null>(null);
  if (images.length === 0) return null;
  return (
    <>
      <div className="chat-prompt-images" role="group" aria-label={images.length === 1 ? "Attached image" : `${images.length} attached images`}>
        {images.map((image, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a row's images never reorder, and two copies of one name are only told apart by their place
          <PromptImageTile key={`${index}:${image.name}`} image={image} onOpen={(src) => setOpened({ image, src })} />
        ))}
      </div>
      {opened ? <PromptImageLightbox image={opened.image} src={opened.src} onClose={() => setOpened(null)} /> : null}
    </>
  );
}
