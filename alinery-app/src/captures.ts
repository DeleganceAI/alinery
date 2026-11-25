import { useCallback, useRef, useSyncExternalStore } from "react";

/** One thing dumped into the inbox: whatever was typed plus any pasted images. */
export type Capture = { id: string; at: number; text: string; images: File[] };

// ponytail: the inbox is the webview's IndexedDB, one per machine and per build lane (dev and
// release have different origins). Move it to files under the app config directory when captures
// need to be in a backup or readable outside the app.
const STORE = "captures";
const db: Promise<IDBDatabase> | null =
  typeof indexedDB === "undefined"
    ? null // tests (jsdom): memory only
    : new Promise((resolve, reject) => {
        const open = indexedDB.open("alinery-captures", 1);
        open.onupgradeneeded = () => open.result.createObjectStore(STORE, { keyPath: "id" });
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });

/** Resolves only once the transaction has committed, so "captured" means it is on disk. */
async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  if (!db) return undefined;
  const transaction = (await db).transaction(STORE, mode);
  return new Promise((resolve, reject) => {
    const request = run(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = transaction.onabort = () => reject(transaction.error ?? request.error);
  });
}

let captures: Capture[] = [];
const listeners = new Set<() => void>();
function set(next: Capture[]) {
  captures = next;
  for (const listener of listeners) listener();
}

void tx<Capture[]>("readonly", (store) => store.getAll())
  .then((saved) => {
    // Anything captured while the read was pending is already in `captures`.
    if (saved?.length) set([...captures, ...saved].sort((a, b) => b.at - a.at));
  })
  .catch(() => {});

export async function addCapture(text: string, images: File[]): Promise<Capture> {
  const capture: Capture = { id: crypto.randomUUID(), at: Date.now(), text, images };
  await tx("readwrite", (store) => store.put(capture));
  set([capture, ...captures]);
  return capture;
}

export async function removeCapture(id: string) {
  await tx("readwrite", (store) => store.delete(id));
  set(captures.filter((capture) => capture.id !== id));
}

/** Newest first. */
export function useCaptures(): Capture[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => captures,
  );
}

// Dragging a capture is pointer events, not HTML drag and drop: Tauri's native file-drop handler
// (which the attachment drops rely on) claims every drag over the webview, so the page never
// sees a `drop` event.
const targets = new Map<Element, (capture: Capture) => void>();

/** A ref for the element that accepts a dropped capture. Dropping copies; the capture stays. */
export function useCaptureDrop(onDrop: (capture: Capture) => void) {
  const latest = useRef(onDrop);
  latest.current = onDrop;
  const mounted = useRef<Element | null>(null);
  return useCallback((element: Element | null) => {
    if (mounted.current) targets.delete(mounted.current);
    mounted.current = element;
    if (element) targets.set(element, (capture) => latest.current(capture));
  }, []);
}

/** The innermost drop target under a point, if any. */
export function captureDropTargetAt(x: number, y: number): Element | null {
  for (let element = document.elementFromPoint?.(x, y) ?? null; element; element = element.parentElement) {
    if (targets.has(element)) return element;
  }
  return null;
}

export function dropCapture(target: Element, capture: Capture) {
  targets.get(target)?.(capture);
}

/** A capture's text appended to a draft on its own line. */
export function appendCaptureText(draft: string, text: string): string {
  if (!text) return draft;
  return draft.trim() ? `${draft.replace(/\n*$/, "")}\n${text}` : text;
}
