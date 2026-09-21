import { Archive, Bot, LayoutGrid, Maximize2, Pencil, Plus, SquareDashedMousePointer, SquarePlus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { archiveBoardTask } from "../archiveTask";
import { arrangeConcepts } from "../canvas/arrange";
import { type Camera, clampScale, fitCamera, lodLabel, lodTier, panCamera, type Rect, screenToWorld, toolLabel, worldToScreen, zoomAt } from "../canvas/camera";
import { createGestureDebounce } from "../canvas/debounce";
import { createSceneHash } from "../canvas/hash";
import { anchorPanel, hasMoved, shouldCreateConcept } from "../canvas/hit";
import { applyBoardToolForMode, resultForAccept, resultForReject } from "../canvas/host-tools";
import {
  deleteConcept,
  emptyCanvasDoc,
  joinPainted,
  mintConceptId,
  type PaintedCard,
  pickerPool,
  placeTask,
  renameConcept,
  setPrimary,
  unplaceTask,
  upsertRelation,
} from "../canvas/ids";
import { CARD_H, CARD_W, HULL_MIN_H, HULL_MIN_W, packAllHulls, packHull as packOneHull, snapHullSize } from "../canvas/pack";
import {
  createHullCache,
  DELETE_INSET_PX,
  DELETE_PX,
  deleteHandleRect,
  HULL_LABEL_PAD,
  HULL_LABEL_PX,
  hullLabelRect,
  type PaintScene,
  paintScene,
  resizeHandleRect,
} from "../canvas/paint";
import { setPendingPlace, takePendingPlace } from "../canvas/pending-place";
import { lassoOf, visiblePipes } from "../canvas/pipes";
import { createDirtyRaf } from "../canvas/raf";
import { type CanvasTokens, readCanvasTokens } from "../canvas/tokens";
import { confirmDanger } from "../confirm";
import * as ipc from "../ipc";
import { ArchiveTaskModal, EmptyState, InlineStatus, taskKey, useBoardTaskActivity } from "../shared";
import type {
  BoardNav,
  BoardTask,
  CanvasConcept,
  CanvasDoc,
  CanvasEditMode,
  CanvasRelationKind,
  CanvasStatus,
  CanvasTool,
  HostToolCall,
  TaskActivityStatus,
  TaskId,
} from "../types";
import { ConceptNameDialog } from "./ConceptNameDialog";
import { OrbitronAgentPane } from "./OrbitronAgentPane";
import { AGENT_MIN_WIDTH } from "./orbitron-agent";

/**
 * Keyboard ownership handed back to App while Orbitron is showing.
 *
 * `escape` runs instead of back-navigation — Esc cancels a gesture here and never leaves
 * the view. `key` gets first refusal on bare keys and returns true when it consumed one.
 */
export type CanvasHotkeys = {
  escape: () => void;
  key: (e: KeyboardEvent) => boolean;
};

/** Pan is the resting tool; the others are entered from the toolbar or a bare key. The union
 *  is shared with the footer, which names the active one. */
type Tool = CanvasTool;

type Gesture =
  | { kind: "none" }
  | { kind: "panning"; lastScreen: { x: number; y: number } }
  | { kind: "drawing"; from: { x: number; y: number }; to: { x: number; y: number } }
  // `onLabel` is where the press landed, not where it ends up: a press on the name that never
  // moves is a rename, and one that moves is still an ordinary hull drag.
  | { kind: "movingHull"; id: string; grab: { x: number; y: number }; startScreen: { x: number; y: number }; onLabel: boolean; moved: boolean }
  | { kind: "resizingHull"; id: string }
  | { kind: "draggingCard"; slug: TaskId; grab: { x: number; y: number }; startScreen: { x: number; y: number }; moved: boolean };

const WRITE_DEBOUNCE_MS = 300;
/** Slightly longer than the write debounce: a reflow is more disruptive than a save. */
const ARRANGE_DEBOUNCE_MS = 320;
const ARROW_PAN_PX = 60;
const CATALOG_POLL_MS = 3000;

const rectOf = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  w: Math.abs(b.x - a.x),
  h: Math.abs(b.y - a.y),
});

/**
 * Orbitron View — the spatial authoring canvas.
 *
 * Reached by ⌘⇧O and by the command palette only: it is deliberately not a TopBar tab, so
 * Grid stays the default surface and this one stays opt-in. Leaving is an explicit act —
 * the Back control or the same chord. Esc belongs to the canvas.
 *
 * The board is one `<canvas>`, painted once per animation frame from a dirty flag. Camera and
 * gesture state live in refs, not React state: a pan at 60 fps must not re-render the tree,
 * and the paint path must see the newest value synchronously. Only chrome-visible facts (the
 * mode string, the active tool, the loaded document, the overlays) are React state.
 */
export function CanvasView({
  repoPath,
  mcpEnabled,
  onExit,
  onCreate,
  onOpen,
  registerNav,
  canvasHotkeysRef,
  placeSlug,
  onPlaced,
  onStatus,
}: {
  repoPath: string;
  mcpEnabled: boolean;
  onExit: () => void;
  onCreate: () => void;
  onOpen: (task: BoardTask) => void;
  registerNav: (n: BoardNav | null) => void;
  canvasHotkeysRef: { current: CanvasHotkeys | null };
  /** A task just created from this view, still to be placed. */
  placeSlug?: TaskId;
  onPlaced: () => void;
  /** Mode and zoom tier, reported up so the footer can show them. Fires only when they change. */
  onStatus: (s: CanvasStatus) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [doc, setDoc] = useState<CanvasDoc>(emptyCanvasDoc);
  const [catalog, setCatalog] = useState<BoardTask[]>([]);
  const [err, setErr] = useState<{ msg: string; detail: string } | null>(null);
  const [tool, setTool] = useState<Tool>("pan");
  const [tier, setTier] = useState<0 | 1 | 2>(1);
  const [selectedConcept, setSelectedConcept] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerPicked, setPickerPicked] = useState<string[]>([]);
  const [pendingArchive, setPendingArchive] = useState<BoardTask | null>(null);
  // A drawn rect waits here for its name. Nothing is created until the dialog returns, so a
  // hull the user never named cannot exist (the POC's `conceptModal`).
  const [pendingConcept, setPendingConcept] = useState<Rect | null>(null);
  // The hull whose label is being renamed in place. The box is a DOM <input> over painted
  // pixels, so it has to be positioned from the camera rather than laid out.
  const [renameId, setRenameId] = useState<string | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  // The pane's width is the board's business too: every piece of chrome anchored to the right
  // edge steps aside by it, so the toolbar is never behind the pane.
  const [agentWidth, setAgentWidth] = useState(AGENT_MIN_WIDTH);
  const [pendingCall, setPendingCall] = useState<{ call: HostToolCall; id: string } | null>(null);
  const pendingHostRef = useRef<{ call: HostToolCall; id: string } | null>(null);
  // Connect mode: right-click a card to start, right-click a second one to pick the kind.
  const [connectSource, setConnectSource] = useState<TaskId | null>(null);
  const [relPick, setRelPick] = useState<{ a: TaskId; b: TaskId } | null>(null);
  // Not persisted: this filters the add-existing picker, not the board. A placed archived
  // card stays painted whatever this says.
  const [showArchived, setShowArchived] = useState(false);

  const painted = useMemo(() => joinPainted(doc, catalog), [doc, catalog]);
  const activityByKey = useBoardTaskActivity(useMemo(() => painted.map((card) => card.task), [painted]));

  // Paint and the pointer handlers read these mirrors, so neither depends on a stale render
  // closure and neither needs a re-render to see the newest value.
  const docRef = useRef(doc);
  docRef.current = doc;
  const paintedRef = useRef(painted);
  paintedRef.current = painted;
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const selectedConceptRef = useRef(selectedConcept);
  selectedConceptRef.current = selectedConcept;
  const connectSourceRef = useRef(connectSource);
  connectSourceRef.current = connectSource;
  const pendingConceptRef = useRef(pendingConcept);
  pendingConceptRef.current = pendingConcept;
  const renameIdRef = useRef(renameId);
  renameIdRef.current = renameId;
  const activityRef = useRef<Record<string, TaskActivityStatus | null>>({});
  activityRef.current = useMemo(() => Object.fromEntries(painted.map((card) => [card.slug, activityByKey[taskKey(card.task)]?.status ?? null])), [painted, activityByKey]);

  const camRef = useRef<Camera>({ x: doc.view.camX, y: doc.view.camY, scale: doc.view.scale });
  const gestureRef = useRef<Gesture>({ kind: "none" });
  const tokensRef = useRef<CanvasTokens | null>(null);
  const hullCacheRef = useRef(createHullCache());
  const hashRef = useRef(createSceneHash());
  const markRef = useRef<() => void>(() => {});
  const selectedRef = useRef<TaskId | null>(null);
  // The rename box: DOM, so the paint pass keeps it over the label instead of React.
  const renameBoxRef = useRef<HTMLInputElement | null>(null);
  // The relation picker: also DOM over painted pixels, so it is anchored to its target card
  // every frame for the same reason the rename box is.
  const relPickBoxRef = useRef<HTMLDivElement | null>(null);
  const relPickRef = useRef<{ a: TaskId; b: TaskId } | null>(relPick);
  relPickRef.current = relPick;
  // Where the pipe being drawn currently ends: the cursor while the target is still open, the
  // target card's own face once it is picked.
  const connectCursorRef = useRef<{ x: number; y: number } | null>(null);

  // ---- persistence -------------------------------------------------------------
  // A gesture in flight is the one time the document on screen is not a document worth
  // saving: half-dragged geometry, a rubber band that may still be cancelled. `isBusy` is
  // why the debounce is a shared primitive rather than an inline setTimeout.
  const writeRef = useRef<{ schedule(): void; dispose(): void } | null>(null);
  useEffect(() => {
    const debounce = createGestureDebounce({
      delayMs: WRITE_DEBOUNCE_MS,
      isBusy: () => gestureRef.current.kind !== "none",
      run: () => {
        const cam = camRef.current;
        const next: CanvasDoc = { ...docRef.current, view: { ...docRef.current.view, camX: cam.x, camY: cam.y, scale: cam.scale } };
        ipc.writeCanvas(next).catch((e) => setErr({ msg: "Couldn't save the board.", detail: String(e) }));
      },
    });
    writeRef.current = debounce;
    return () => {
      debounce.dispose();
      writeRef.current = null;
    };
  }, []);

  const scheduleWrite = useCallback(() => writeRef.current?.schedule(), []);

  /**
   * Mid-gesture document update: refs only, no React state, no write.
   *
   * `painted` is derived from the document, so it has to be recomputed here too — paint reads
   * the mirror, and a card whose position moved in the document but not in the mirror would
   * simply not follow the pointer.
   */
  const touchDoc = useCallback((next: CanvasDoc) => {
    docRef.current = next;
    paintedRef.current = joinPainted(next, catalogRef.current);
    markRef.current();
  }, []);

  const arrangeRef = useRef<{ schedule(): void; dispose(): void } | null>(null);

  /**
   * Commit a document edit: React state for the chrome, the refs for the next paint, one write.
   *
   * Every commit also offers the auto-arrange scheduler a turn. The scheduler itself decides
   * whether the toggle is on and refuses to run mid-gesture, so this is the one place that has
   * to know "the board changed" rather than every call site having to remember.
   */
  const commit = useCallback(
    (next: CanvasDoc) => {
      touchDoc(next);
      setDoc(next);
      scheduleWrite();
      arrangeRef.current?.schedule();
    },
    [touchDoc, scheduleWrite],
  );

  const onHostTool = useCallback(
    async (call: HostToolCall, id: string) => {
      const verdict = applyBoardToolForMode(docRef.current.view.canvasEditMode, docRef.current, catalogRef.current, call);
      if (verdict.kind === "apply") {
        commit(verdict.doc);
        const created = call.toolName === "concept_create" ? resultForAccept(verdict.doc, catalogRef.current, call) : { result: {} };
        void ipc.orbitronHostToolResult({ repoPath, id, result: call.toolName === "concept_create" ? created.result : {}, isError: false });
      } else if (verdict.kind === "hold") {
        pendingHostRef.current = { call, id };
        setPendingCall({ call, id });
      } else if (verdict.kind === "reject") {
        void ipc.orbitronHostToolResult({ repoPath, id, result: verdict.error, isError: true });
      } else {
        void ipc.orbitronHostToolResult({ repoPath, id, result: verdict.payload, isError: false });
      }
      return verdict;
    },
    [commit, repoPath],
  );

  const acceptPending = useCallback(() => {
    const held = pendingHostRef.current;
    if (!held) return;
    const accepted = resultForAccept(docRef.current, catalogRef.current, held.call);
    commit(accepted.doc);
    pendingHostRef.current = null;
    setPendingCall(null);
    void ipc.orbitronHostToolResult({ repoPath, id: held.id, result: accepted.result, isError: false });
  }, [commit, repoPath]);

  const rejectPending = useCallback(() => {
    const held = pendingHostRef.current;
    pendingHostRef.current = null;
    setPendingCall(null);
    if (held) void ipc.orbitronHostToolResult({ repoPath, id: held.id, result: resultForReject().result, isError: true });
  }, [repoPath]);

  const changeMode = useCallback(
    (mode: CanvasEditMode) => {
      commit({ ...docRef.current, view: { ...docRef.current.view, canvasEditMode: mode } });
      const held = pendingHostRef.current;
      if (!held) return;
      const verdict = applyBoardToolForMode(mode, docRef.current, catalogRef.current, held.call);
      if (verdict.kind === "apply") acceptPending();
      else if (verdict.kind === "reject") rejectPending();
    },
    [acceptPending, commit, rejectPending],
  );

  useEffect(() => {
    return () => {
      if (pendingHostRef.current) {
        void ipc.orbitronHostToolResult({
          repoPath,
          id: pendingHostRef.current.id,
          result: "The board isn't open. Return to Orbitron View to apply board changes.",
          isError: true,
        });
      }
    };
  }, [repoPath]);

  // ---- load --------------------------------------------------------------------
  useEffect(() => {
    let alive = true;
    ipc
      .readCanvas()
      .then((loaded) => {
        if (!alive) return;
        setDoc(loaded);
        docRef.current = loaded;
        camRef.current = { x: loaded.view.camX, y: loaded.view.camY, scale: clampScale(loaded.view.scale) };
        setTier(lodTier(camRef.current.scale));
        markRef.current();
      })
      // A corrupt sidecar is reported, never silently replaced with an empty board: the next
      // save would overwrite the user's real layout with the blank one they were shown.
      .catch((e) => alive && setErr({ msg: "Couldn't load the board.", detail: String(e) }));
    return () => {
      alive = false;
    };
  }, []);

  // Orbitron is per-repository, so the catalog is always the active repo's. Polling keeps
  // names and activity fresh; it must never move a card, which is why `joinPainted` takes
  // geometry from the document alone.
  useEffect(() => {
    let alive = true;
    const load = () =>
      ipc
        .listBoardTasks(false)
        .then((rows) => alive && setCatalog(rows))
        .catch(() => {});
    void load();
    const timer = window.setInterval(load, CATALOG_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  // ---- hit testing --------------------------------------------------------------
  // Rebuilt from the committed document, not per pointer event: a spatial index is only
  // cheaper than a linear scan if it is not rebuilt on every move.
  useEffect(() => {
    hashRef.current.rebuild({
      cards: painted.map((card) => ({ id: card.slug, x: card.x, y: card.y, w: CARD_W, h: CARD_H })),
      concepts: doc.concepts.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h })),
    });
  }, [doc, painted]);

  // ---- paint -------------------------------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const cache = hullCacheRef.current;

    const paint = () => {
      const ctx = canvas.getContext("2d");
      const tokens = tokensRef.current;
      if (!ctx || !tokens) return;
      const dpr = window.devicePixelRatio || 1;
      const css = { w: host.clientWidth, h: host.clientHeight };
      const pw = Math.max(1, Math.round(css.w * dpr));
      const ph = Math.max(1, Math.round(css.h * dpr));
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      const cam = camRef.current;
      const lod = lodTier(cam.scale);
      const gesture = gestureRef.current;
      const scene: PaintScene = {
        tokens,
        cam,
        lod,
        viewport: { x: cam.x, y: cam.y, w: css.w / cam.scale, h: css.h / cam.scale },
        concepts: docRef.current.concepts,
        cards: paintedRef.current,
        pipes: visiblePipes({
          lod,
          concepts: docRef.current.concepts,
          cards: paintedRef.current,
          relations: docRef.current.relations,
          selected: selectedRef.current,
          connectSource: connectSourceRef.current,
        }),
        activity: activityRef.current,
        selected: selectedRef.current,
        connectSource: connectSourceRef.current,
        selectedConcept: selectedConceptRef.current,
        editing: toolRef.current === "edit",
        // While the naming dialog is up the rect is still the subject, so it stays outlined —
        // at the size it will actually become, not the sliver that may have been drawn.
        draft: gesture.kind === "drawing" ? rectOf(gesture.from, gesture.to) : pendingConceptRef.current,
        lasso: lassoOf(connectSourceRef.current, relPickRef.current, paintedRef.current, connectCursorRef.current),
      };
      paintScene(ctx, css, dpr, scene, cache);

      // The rename box is DOM over painted pixels, so it follows the camera by being placed
      // every frame; anything less drifts off its label on the first pan or zoom.
      const box = renameBoxRef.current;
      const editingId = renameIdRef.current;
      const hull = editingId ? docRef.current.concepts.find((c) => c.id === editingId) : undefined;
      if (box && hull) placeRenameBox(box, hull, cam);

      // Same for the relation picker: it names two specific cards, so it has to sit beside the
      // one the user just right-clicked rather than in a corner of the screen.
      const panel = relPickBoxRef.current;
      const pair = relPickRef.current;
      const target = pair ? paintedRef.current.find((c) => c.slug === pair.b) : undefined;
      if (panel && target) placePicker(panel, target, cam, css);
    };

    const raf = createDirtyRaf(paint);
    markRef.current = raf.mark;

    // Read the palette once per token-affecting change, never per card: `getComputedStyle`
    // forces a style recalc, and the card loop runs up to 200 times a frame.
    const refreshTokens = () => {
      tokensRef.current = readCanvasTokens(host);
      raf.mark();
    };
    refreshTokens();

    const themeWatcher = new MutationObserver(refreshTokens);
    themeWatcher.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    const resize = new ResizeObserver(raf.mark);
    resize.observe(host);

    return () => {
      themeWatcher.disconnect();
      resize.disconnect();
      raf.dispose();
      cache.dispose();
      markRef.current = () => {};
    };
  }, []);

  // Any commit may have changed something the canvas draws — the document, membership, the
  // active tool — so every render marks the frame dirty. `mark` coalesces to one paint per
  // frame, so this is a flag set rather than a repaint per render.
  useEffect(() => {
    markRef.current();
  });

  // ---- camera ------------------------------------------------------------------
  const applyCamera = useCallback(
    (next: Camera) => {
      camRef.current = next;
      const nextTier = lodTier(next.scale);
      setTier((current) => (current === nextTier ? current : nextTier));
      markRef.current();
      scheduleWrite();
    },
    [scheduleWrite],
  );

  const fitBoard = useCallback(() => {
    const host = hostRef.current;
    if (!host) return;
    const boxes = [
      ...docRef.current.concepts.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h })),
      ...paintedRef.current.map((card: PaintedCard) => ({ x: card.x, y: card.y, w: CARD_W, h: CARD_H })),
    ];
    if (boxes.length === 0) {
      applyCamera({ x: 0, y: 0, scale: 1 });
      return;
    }
    const minX = Math.min(...boxes.map((b) => b.x));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxX = Math.max(...boxes.map((b) => b.x + b.w));
    const maxY = Math.max(...boxes.map((b) => b.y + b.h));
    applyCamera(fitCamera({ x: minX, y: minY, w: maxX - minX, h: maxY - minY }, { w: host.clientWidth, h: host.clientHeight }));
  }, [applyCamera]);

  /** Camera centre in world units — where a card lands with no drop target. */
  const cameraCenter = useCallback(() => {
    const host = hostRef.current;
    const cam = camRef.current;
    if (!host) return { x: cam.x, y: cam.y };
    return screenToWorld(cam, host.clientWidth / 2 - CARD_W / 2, host.clientHeight / 2 - CARD_H / 2);
  }, []);

  // ---- concepts ----------------------------------------------------------------
  const packHull = useCallback((source: CanvasDoc, id: string): CanvasDoc => packOneHull(source, id, catalogRef.current), []);

  const removeConcept = useCallback(
    async (id: string) => {
      const ok = await confirmDanger("Remove concept", "Tasks stay in the repo. They leave this hull and lose this tag.", "Remove");
      if (!ok) return;
      setSelectedConcept(null);
      commit(deleteConcept(docRef.current, id));
    },
    [commit],
  );

  const removeSelectedConcept = useCallback(() => {
    const id = selectedConceptRef.current;
    if (id) void removeConcept(id);
  }, [removeConcept]);

  const removeTaskFromBoard = useCallback(
    async (slug: TaskId) => {
      const ok = await confirmDanger("Remove from board?", "The task stays in the repo. It can be added again.", "Remove");
      if (!ok) return;
      if (selectedRef.current === slug) selectedRef.current = null;
      commit(unplaceTask(docRef.current, slug));
    },
    [commit],
  );

  /** Create is the only way a concept comes into existence, so the name is never empty here. */
  const createNamedConcept = useCallback(
    (name: string) => {
      const rect = pendingConceptRef.current;
      setPendingConcept(null);
      pendingConceptRef.current = null;
      if (!rect) return;
      const hull: CanvasConcept = { id: mintConceptId(), name, x: rect.x, y: rect.y, w: rect.w, h: rect.h, manual: true };
      setSelectedConcept(hull.id);
      selectedConceptRef.current = hull.id;
      commit(packHull({ ...docRef.current, concepts: [...docRef.current.concepts, hull] }, hull.id));
    },
    [commit, packHull],
  );

  /** Cancel discards the rect: a drawn box the user declined to name is not a concept. */
  const cancelPendingConcept = useCallback(() => {
    setPendingConcept(null);
    pendingConceptRef.current = null;
    markRef.current();
  }, []);

  const startRename = (id: string) => {
    setRenameId(id);
    renameIdRef.current = id;
  };

  const endRename = useCallback(() => {
    setRenameId(null);
    renameIdRef.current = null;
  }, []);

  const commitRename = useCallback(
    (raw: string) => {
      const id = renameIdRef.current;
      endRename();
      const name = raw.trim();
      const hull = id ? docRef.current.concepts.find((c) => c.id === id) : undefined;
      // An empty box keeps the old name — clearing a name would recreate the unnamed hull the
      // naming step exists to prevent — and an unchanged name is not worth a write.
      if (!hull || !name || name === hull.name) return;
      commit(renameConcept(docRef.current, hull.id, name));
    },
    [commit, endRename],
  );

  // Place and focus the box in the same layout pass it appears in: positioning it from the
  // paint loop alone would show it at the top-left corner for one frame.
  useLayoutEffect(() => {
    const box = renameBoxRef.current;
    const hull = renameId ? docRef.current.concepts.find((c) => c.id === renameId) : undefined;
    if (!box || !hull) return;
    placeRenameBox(box, hull, camRef.current);
    box.focus();
    box.select();
  }, [renameId]);

  // Same for the relation picker: the paint loop keeps it on its card, but it has to land there
  // in the layout pass it appears in or it flashes at the corner first.
  useLayoutEffect(() => {
    const panel = relPickBoxRef.current;
    const host = hostRef.current;
    const target = relPick ? paintedRef.current.find((c) => c.slug === relPick.b) : undefined;
    if (panel && host && target) placePicker(panel, target, camRef.current, { w: host.clientWidth, h: host.clientHeight });
  }, [relPick]);

  // ---- auto-arrange ------------------------------------------------------------
  // A toggle, not a one-shot: while it is on, the board reflows after the gestures that
  // change what has to fit. The reflow is debounced through the same primitive as the write,
  // so it can never run under the cursor mid-gesture — a board that rearranges itself while
  // the user is still dragging is worse than one that never rearranges at all.
  // `arrangeRef` is declared beside `commit`, which is what schedules it.
  useEffect(() => {
    const debounce = createGestureDebounce({
      delayMs: ARRANGE_DEBOUNCE_MS,
      isBusy: () => gestureRef.current.kind !== "none",
      run: () => {
        if (!docRef.current.view.autoArrange) return;
        const next = packAllHulls({ ...docRef.current, concepts: arrangeConcepts(docRef.current.concepts) }, catalogRef.current);
        touchDoc(next);
        setDoc(next);
        scheduleWrite();
      },
    });
    arrangeRef.current = debounce;
    return () => {
      debounce.dispose();
      arrangeRef.current = null;
    };
  }, [touchDoc, scheduleWrite]);

  const toggleArrange = () => commit({ ...docRef.current, view: { ...docRef.current.view, autoArrange: !docRef.current.view.autoArrange } });

  const clearBoard = async () => {
    const ok = await confirmDanger("Clear Orbitron board?", "Concepts, placements, and relations are removed. Tasks in the repo are untouched.", "Clear board");
    if (!ok) return;
    const empty = emptyCanvasDoc();
    setSelectedConcept(null);
    selectedRef.current = null;
    camRef.current = { x: empty.view.camX, y: empty.view.camY, scale: empty.view.scale };
    setTier(lodTier(empty.view.scale));
    commit(empty);
  };

  // ---- tasks -------------------------------------------------------------------
  const placedSlugs = useMemo(() => new Set(painted.map((card) => card.slug)), [painted]);
  const pool = useMemo(() => pickerPool(catalog, placedSlugs, showArchived), [catalog, placedSlugs, showArchived]);

  const openPicker = useCallback(() => {
    setPickerPicked([]);
    setPickerOpen(true);
  }, []);

  const confirmPicker = () => {
    const target = selectedConceptRef.current;
    const center = cameraCenter();
    let next = docRef.current;
    pickerPicked.forEach((slug, i) => {
      // Stagger the free-float case so a multi-select does not stack every card on one point.
      const spot = target ? center : { x: center.x + i * 24, y: center.y + i * 24 };
      next = placeTask(next, slug, { x: spot.x, y: spot.y, conceptId: target ?? undefined });
    });
    if (target) next = packHull(next, target);
    setPickerOpen(false);
    setPickerPicked([]);
    commit(next);
  };

  /**
   * New task from the canvas. The drop target is stashed in a module slot rather than state
   * because CreateTaskPage replaces this view entirely — the component that knows where the
   * card should land is unmounted by the time the task exists.
   */
  const startCreate = useCallback(() => {
    const target = selectedConceptRef.current;
    const center = cameraCenter();
    setPendingPlace({ conceptId: target ?? undefined, x: center.x, y: center.y });
    onCreate();
  }, [cameraCenter, onCreate]);

  // A task created from this view arrives as `placeSlug` once the catalog has caught up.
  useEffect(() => {
    if (!placeSlug) return;
    if (!catalog.some((task) => task.slug === placeSlug)) return;
    const pending = takePendingPlace();
    const spot = pending ?? cameraCenter();
    let next = placeTask(docRef.current, placeSlug, { x: spot.x, y: spot.y, conceptId: pending?.conceptId });
    if (pending?.conceptId) next = packHull(next, pending.conceptId);
    commit(next);
    onPlaced();
  }, [placeSlug, catalog, cameraCenter, packHull, commit, onPlaced]);

  const cardBySlug = useCallback((slug: TaskId | null) => (slug ? (paintedRef.current.find((card) => card.slug === slug) ?? null) : null), []);

  const openSelectedCard = useCallback(() => {
    const card = cardBySlug(selectedRef.current);
    if (card) onOpen(card.task);
  }, [cardBySlug, onOpen]);

  const confirmArchive = (removeWt: boolean) => {
    const target = pendingArchive;
    if (!target) return;
    setPendingArchive(null);
    // The placement stays: the card greys out in place rather than vanishing, because the
    // position on the board is the user's work and archiving a task is not unplacing it.
    void archiveBoardTask(target, removeWt).then((failure) => {
      if (failure) setErr({ msg: failure.msg, detail: failure.detail });
    });
  };

  // ---- relations ---------------------------------------------------------------
  const cancelConnect = useCallback(() => {
    setRelPick(null);
    relPickRef.current = null;
    connectCursorRef.current = null;
    setConnectSource((current) => {
      if (current === null) return current;
      connectSourceRef.current = null;
      markRef.current();
      return null;
    });
  }, []);

  const chooseRelation = (kind: CanvasRelationKind) => {
    const pair = relPick;
    if (!pair) return;
    cancelConnect();
    // Re-picking a pair replaces the kind rather than accumulating: the sidecar stores one
    // kind per undirected pair, so the last choice is the answer.
    commit(upsertRelation(docRef.current, pair.a, pair.b, kind));
  };

  // ---- pointer -----------------------------------------------------------------
  const worldAt = (e: React.PointerEvent | React.WheelEvent | React.MouseEvent) => {
    const host = hostRef.current;
    if (!host) return { x: 0, y: 0 };
    const box = host.getBoundingClientRect();
    return screenToWorld(camRef.current, e.clientX - box.left, e.clientY - box.top);
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const host = hostRef.current;
    if (!host) return;
    const box = host.getBoundingClientRect();
    // Trackpads report fractional deltas continuously; an exponential factor keeps the zoom
    // rate perceptually even instead of accelerating near the clamp.
    applyCamera(zoomAt(camRef.current, e.clientX - box.left, e.clientY - box.top, 2 ** (-e.deltaY / 400)));
  };

  const startDrawing = (world: { x: number; y: number }) => {
    gestureRef.current = { kind: "drawing", from: world, to: world };
    markRef.current();
  };

  const hullById = (id: string): CanvasConcept | undefined => docRef.current.concepts.find((c) => c.id === id);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 1) return; // middle-click toggles the tool on auxclick, not here
    e.currentTarget.setPointerCapture(e.pointerId);
    const world = worldAt(e);
    const card = hashRef.current.cardAt(world.x, world.y);

    // Right-click a card starts (or completes) a relation; right-drag on empty space draws a
    // concept. Both are the POC's primary authoring gestures.
    if (e.button === 2) {
      if (!card) {
        startDrawing(world);
        return;
      }
      const source = connectSourceRef.current;
      if (!source) {
        setConnectSource(card.id);
        connectSourceRef.current = card.id;
        // Seed the line at the click so it is visible before the pointer moves again.
        connectCursorRef.current = world;
        markRef.current();
        return;
      }
      // Right-clicking the source again is a no-op, not a self relation.
      if (source !== card.id) {
        setRelPick({ a: source, b: card.id });
        relPickRef.current = { a: source, b: card.id };
        markRef.current();
      }
      return;
    }
    if (e.button !== 0) return;

    // Any left click leaves connect mode: the gesture is right-click driven, so a left click
    // is the user doing something else.
    if (connectSourceRef.current) cancelConnect();

    if (toolRef.current === "draw") {
      startDrawing(world);
      return;
    }

    if (toolRef.current === "edit") {
      const scale = camRef.current.scale;
      if (card) {
        const handle = deleteHandleRect({ x: card.x, y: card.y, w: CARD_W, h: CARD_H }, scale);
        if (world.x >= handle.x && world.x <= handle.x + handle.w && world.y >= handle.y && world.y <= handle.y + handle.h) {
          void removeTaskFromBoard(card.id);
          return;
        }
      } else {
        const hullHit = hashRef.current.conceptAt(world.x, world.y);
        if (hullHit) {
          const handle = deleteHandleRect(hullHit, scale);
          if (world.x >= handle.x && world.x <= handle.x + handle.w && world.y >= handle.y && world.y <= handle.y + handle.h) {
            void removeConcept(hullHit.id);
            return;
          }
        }
      }
      const active = selectedConceptRef.current ? hullById(selectedConceptRef.current) : undefined;
      if (active) {
        const grip = resizeHandleRect(active, scale);
        if (world.x >= grip.x && world.x <= grip.x + grip.w && world.y >= grip.y && world.y <= grip.y + grip.h) {
          gestureRef.current = { kind: "resizingHull", id: active.id };
          return;
        }
      }
      if (!card) {
        // `conceptAt` is null wherever a card covers the point, so a hull drag never starts on
        // top of a card the user meant to grab.
        const hull = hashRef.current.conceptAt(world.x, world.y);
        if (hull) {
          setSelectedConcept(hull.id);
          selectedConceptRef.current = hull.id;
          const band = hullLabelRect(hull);
          const handle = deleteHandleRect(hull, scale);
          const onHandle = world.x >= handle.x && world.x <= handle.x + handle.w && world.y >= handle.y && world.y <= handle.y + handle.h;
          gestureRef.current = {
            kind: "movingHull",
            id: hull.id,
            grab: { x: world.x - hull.x, y: world.y - hull.y },
            startScreen: { x: e.clientX, y: e.clientY },
            onLabel: !onHandle && world.x >= band.x && world.x <= band.x + band.w && world.y >= band.y && world.y <= band.y + band.h,
            moved: false,
          };
          return;
        }
        setSelectedConcept(null);
      }
    }

    if (card) {
      gestureRef.current = {
        kind: "draggingCard",
        slug: card.id,
        grab: { x: world.x - card.x, y: world.y - card.y },
        startScreen: { x: e.clientX, y: e.clientY },
        moved: false,
      };
      return;
    }

    gestureRef.current = { kind: "panning", lastScreen: { x: e.clientX, y: e.clientY } };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    // The line being drawn follows the pointer, so this tracks even with no gesture in flight —
    // connect mode is right-click driven and holds no button down between its two clicks.
    if (connectSourceRef.current && !relPickRef.current) {
      connectCursorRef.current = worldAt(e);
      markRef.current();
    }
    const gesture = gestureRef.current;
    switch (gesture.kind) {
      case "panning": {
        const dx = e.clientX - gesture.lastScreen.x;
        const dy = e.clientY - gesture.lastScreen.y;
        gesture.lastScreen = { x: e.clientX, y: e.clientY };
        camRef.current = panCamera(camRef.current, dx, dy);
        markRef.current();
        return;
      }
      case "drawing": {
        gesture.to = worldAt(e);
        markRef.current();
        return;
      }
      case "movingHull": {
        // Below the threshold this is still a click, and a click on the label is a rename: a
        // one-pixel nudge here would both move the hull and open the box.
        if (!gesture.moved && !hasMoved(gesture.startScreen, { x: e.clientX, y: e.clientY })) return;
        gesture.moved = true;
        const world = worldAt(e);
        const hull = hullById(gesture.id);
        if (!hull) return;
        // Members ride with the hull: card positions are absolute, so a hull that moved
        // without them would leave its contents behind.
        touchDoc(translateHull(docRef.current, gesture.id, world.x - gesture.grab.x - hull.x, world.y - gesture.grab.y - hull.y));
        return;
      }
      case "resizingHull": {
        const world = worldAt(e);
        touchDoc({
          ...docRef.current,
          concepts: docRef.current.concepts.map((c) =>
            c.id === gesture.id ? { ...c, w: Math.max(HULL_MIN_W, world.x - c.x), h: Math.max(HULL_MIN_H, world.y - c.y), manual: true } : c,
          ),
        });
        return;
      }
      case "draggingCard": {
        // Below the threshold this is still a click; committing geometry here would make every
        // selection nudge the card by a pixel.
        if (!gesture.moved && !hasMoved(gesture.startScreen, { x: e.clientX, y: e.clientY })) return;
        gesture.moved = true;
        const world = worldAt(e);
        const placement = docRef.current.placements[gesture.slug];
        if (!placement) return;
        touchDoc({
          ...docRef.current,
          placements: { ...docRef.current.placements, [gesture.slug]: { ...placement, x: world.x - gesture.grab.x, y: world.y - gesture.grab.y } },
        });
        return;
      }
      default:
        return;
    }
  };

  const endGesture = () => {
    const gesture = gestureRef.current;
    gestureRef.current = { kind: "none" };

    switch (gesture.kind) {
      case "drawing": {
        const box = rectOf(gesture.from, gesture.to);
        // A drag smaller than the minimum on either axis is an accident, not an intent.
        if (!shouldCreateConcept(box.w, box.h)) {
          markRef.current();
          return;
        }
        // Nothing is created yet: the rect waits for a name, snapped up to a size a task can
        // actually be placed into, so what the dialog outlines is what Create will make.
        const rect = { x: box.x, y: box.y, ...snapHullSize(box) };
        setPendingConcept(rect);
        pendingConceptRef.current = rect;
        markRef.current();
        return;
      }
      case "movingHull":
        // A press on the label that never moved is a rename, not a move — there is no geometry
        // change to commit, so committing here would be a write for nothing.
        if (!gesture.moved) {
          if (gesture.onLabel) startRename(gesture.id);
          return;
        }
        commit(docRef.current);
        return;
      case "resizingHull":
        // A resize changes what fits, so the hull re-packs; a manual hull can only grow.
        commit(packHull(docRef.current, gesture.id));
        return;
      case "draggingCard": {
        if (!gesture.moved) {
          // A click selects and reveals that task's own edges (Policy E). Clicking empty
          // space clears it again, which is the `panning` branch below.
          selectedRef.current = gesture.slug;
          markRef.current();
          return;
        }
        const card = paintedRef.current.find((c) => c.slug === gesture.slug);
        const center = card ? { x: card.x + CARD_W / 2, y: card.y + CARD_H / 2 } : null;
        const hull = center ? hashRef.current.conceptAt(center.x, center.y) : null;
        let next = docRef.current;
        // Dropping into a hull re-tags the card's primary placement; dropping on empty space
        // is an explicit free-float, never an implicit side effect of moving.
        next = setPrimary(next, gesture.slug, hull ? hull.id : null);
        if (hull) next = packHull(next, hull.id);
        commit(next);
        return;
      }
      case "panning":
        if (selectedRef.current) {
          selectedRef.current = null;
          markRef.current();
        }
        scheduleWrite();
        return;
      default:
        return;
    }
  };

  // Double-click opens the task the Kanban way (draft → CreateTaskPage, else TaskDetail).
  // Single-click only selects; opening on one click would make every selection a navigation.
  const onDoubleClick = (e: React.MouseEvent) => {
    const world = worldAt(e);
    const hit = hashRef.current.cardAt(world.x, world.y);
    const card = hit ? paintedRef.current.find((c) => c.slug === hit.id) : null;
    if (card) onOpen(card.task);
  };

  // Middle-click cancels a connect in progress, otherwise toggles edit ↔ pan (POC).
  // `auxclick` is the only event that reports a middle release reliably across platforms.
  const onAuxClick = (e: React.MouseEvent) => {
    if (e.button !== 1) return;
    e.preventDefault();
    if (connectSourceRef.current) {
      cancelConnect();
      return;
    }
    setTool((current) => (current === "edit" ? "pan" : "edit"));
  };

  // ---- keyboard ----------------------------------------------------------------
  useLayoutEffect(() => {
    canvasHotkeysRef.current = {
      escape: () => {
        // Cancel order: the rename box, then the naming dialog, then the relation picker, then
        // the connect, then the picker overlay, then a gesture, then selection, then the tool.
        // Esc never leaves the view.
        if (renameId) {
          endRename();
          return;
        }
        if (pendingConcept) {
          cancelPendingConcept();
          return;
        }
        if (relPick || connectSourceRef.current) {
          cancelConnect();
          return;
        }
        if (pickerOpen) {
          setPickerOpen(false);
          return;
        }
        if (gestureRef.current.kind !== "none") {
          gestureRef.current = { kind: "none" };
          markRef.current();
          return;
        }
        if (selectedRef.current) {
          selectedRef.current = null;
          markRef.current();
          return;
        }
        if (selectedConceptRef.current) {
          setSelectedConcept(null);
          return;
        }
        // Nothing left to cancel returns the resting tool. Esc must never leave this view.
        setTool("pan");
      },
      key: (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return false;
        if (pickerOpen || pendingArchive || relPick || pendingConcept || renameId) return false;
        const host = hostRef.current;
        switch (e.key) {
          case "d":
            setTool((current) => (current === "draw" ? "pan" : "draw"));
            return true;
          case "e":
            setTool((current) => (current === "edit" ? "pan" : "edit"));
            return true;
          case "a":
            openPicker();
            return true;
          case "n":
            startCreate();
            return true;
          case "0":
            fitBoard();
            return true;
          case "+":
          case "=":
            if (host) applyCamera(zoomAt(camRef.current, host.clientWidth / 2, host.clientHeight / 2, 1.2));
            return true;
          case "-":
            if (host) applyCamera(zoomAt(camRef.current, host.clientWidth / 2, host.clientHeight / 2, 1 / 1.2));
            return true;
          case "Delete":
          case "Backspace":
            // Destructive, so it is edit-mode only and always asks first. A selected card
            // is the more specific target; otherwise the selected concept.
            if (toolRef.current !== "edit") return false;
            if (selectedRef.current) {
              void removeTaskFromBoard(selectedRef.current);
              return true;
            }
            if (selectedConceptRef.current) {
              void removeSelectedConcept();
              return true;
            }
            return false;
          case "ArrowUp":
            applyCamera(panCamera(camRef.current, 0, ARROW_PAN_PX));
            return true;
          case "ArrowDown":
            applyCamera(panCamera(camRef.current, 0, -ARROW_PAN_PX));
            return true;
          case "ArrowLeft":
            applyCamera(panCamera(camRef.current, ARROW_PAN_PX, 0));
            return true;
          case "ArrowRight":
            applyCamera(panCamera(camRef.current, -ARROW_PAN_PX, 0));
            return true;
          default:
            return false;
        }
      },
    };
    return () => {
      canvasHotkeysRef.current = null;
    };
  }, [
    canvasHotkeysRef,
    applyCamera,
    fitBoard,
    removeSelectedConcept,
    removeTaskFromBoard,
    openPicker,
    startCreate,
    cancelConnect,
    cancelPendingConcept,
    endRename,
    pickerOpen,
    pendingArchive,
    relPick,
    pendingConcept,
    renameId,
  ]);

  // Orbitron is not a board: j/k/h/l stay dead here (App passes `board: null`). ⌘↵ opens the
  // selected card and ⌘E archives it. ⌘D is deliberately inert — there is no duplicate
  // gesture on this surface, same as Sessions and Notifications.
  useLayoutEffect(() => {
    registerNav({
      moveRow: () => {},
      moveCol: () => {},
      openSelected: openSelectedCard,
      duplicateSelected: () => {},
      archiveSelected: () => setPendingArchive(cardBySlug(selectedRef.current)?.task ?? null),
    });
    return () => registerNav(null);
  });

  // The footer owns the mode and zoom indicators, so it has to be told. A layout effect, not
  // a render-time call, and keyed on the two values only: `tier` changes when the wheel
  // crosses a threshold, never per frame, so this costs one parent render per real change.
  useLayoutEffect(() => {
    onStatus({ tool, tier });
  }, [tool, tier, onStatus]);

  const mode = toolLabel(tool);
  const renameHull = renameId ? doc.concepts.find((c) => c.id === renameId) : undefined;

  return (
    <div className="orbitron" ref={hostRef} style={{ ["--agent-w" as string]: agentOpen ? `${agentWidth}px` : "0px" }}>
      {/* The board is a pointer surface; every action it offers also has a toolbar button or
          a bare key routed through `canvasKey`, so nothing here is pointer-only. */}
      <canvas
        className="orbitron-stage"
        ref={canvasRef}
        aria-label={`Orbitron View, ${mode}, ${lodLabel(tier)}`}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onDoubleClick={onDoubleClick}
        onAuxClick={onAuxClick}
        onContextMenu={(e) => e.preventDefault()}
      />
      {renameHull && (
        <input
          ref={renameBoxRef}
          className="orbitron-rename"
          aria-label={`Rename concept ${renameHull.name || "Untitled concept"}`}
          defaultValue={renameHull.name}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename(e.currentTarget.value);
            // Esc discards: unmounting fires no blur, so the box closes without committing.
            else if (e.key === "Escape") endRename();
          }}
          onBlur={(e) => commitRename(e.target.value)}
        />
      )}
      <div className="orbitron-chrome">
        <button type="button" className="orbitron-exit" aria-label="Exit Orbitron View" onClick={onExit}>
          Back
        </button>
        {/* The view's name, and only its name: the mode and zoom tier are status, so they sit
            in the status bar with every other one. */}
        <h1 className="orbitron-title">Orbitron</h1>
      </div>
      <div className="orbitron-toolbar">
        <ToolButton label="Draw concept" hint="d" active={tool === "draw"} onClick={() => setTool(tool === "draw" ? "pan" : "draw")}>
          <Pencil size={16} strokeWidth={1.5} aria-hidden="true" />
        </ToolButton>
        <ToolButton label="Edit concepts" hint="e" active={tool === "edit"} onClick={() => setTool(tool === "edit" ? "pan" : "edit")}>
          <SquareDashedMousePointer size={16} strokeWidth={1.5} aria-hidden="true" />
        </ToolButton>
        <ToolButton label="Add existing task" hint="a" onClick={openPicker}>
          <SquarePlus size={16} strokeWidth={1.5} aria-hidden="true" />
        </ToolButton>
        <ToolButton label="New task" hint="n" onClick={startCreate}>
          <Plus size={16} strokeWidth={1.5} aria-hidden="true" />
        </ToolButton>
        <ToolButton label="Auto-arrange" active={doc.view.autoArrange} onClick={toggleArrange}>
          <LayoutGrid size={16} strokeWidth={1.5} aria-hidden="true" />
        </ToolButton>
        {/* A persistent view filter, so it belongs beside the other persistent toggle rather
            than as a checkbox in the chrome. No hotkey: it is not part of authoring flow. */}
        <ToolButton label="Show archived" active={showArchived} onClick={() => setShowArchived((on) => !on)}>
          <Archive size={16} strokeWidth={1.5} aria-hidden="true" />
        </ToolButton>
        <ToolButton label="Agent" active={agentOpen} onClick={() => setAgentOpen((open) => !open)}>
          <Bot size={16} strokeWidth={1.5} aria-hidden="true" />
        </ToolButton>
        <ToolButton label="Clear board" onClick={() => void clearBoard()}>
          <Trash2 size={16} strokeWidth={1.5} aria-hidden="true" />
        </ToolButton>
        <ToolButton label="Fit board" hint="0" onClick={fitBoard}>
          <Maximize2 size={16} strokeWidth={1.5} aria-hidden="true" />
        </ToolButton>
      </div>
      {err && (
        <div className="orbitron-status">
          <InlineStatus tone="error" detail={err.detail}>
            {err.msg}
          </InlineStatus>
        </div>
      )}
      {pickerOpen && (
        <TaskPicker
          pool={pool}
          picked={pickerPicked}
          target={selectedConcept ? doc.concepts.find((c) => c.id === selectedConcept)?.name || "the selected concept" : null}
          onToggle={(slug) => setPickerPicked((current) => (current.includes(slug) ? current.filter((s) => s !== slug) : [...current, slug]))}
          onCancel={() => setPickerOpen(false)}
          onConfirm={confirmPicker}
        />
      )}
      {connectSource && !relPick && (
        <div className="orbitron-connect" role="status">
          Connecting from <b>{cardBySlug(connectSource)?.task.name ?? connectSource}</b> — right-click another card, or Esc to cancel
        </div>
      )}
      {relPick && (
        <RelationPicker
          hostRef={relPickBoxRef}
          a={cardBySlug(relPick.a)?.task.name ?? relPick.a}
          b={cardBySlug(relPick.b)?.task.name ?? relPick.b}
          onPick={chooseRelation}
          onCancel={cancelConnect}
        />
      )}
      {agentOpen && (
        <OrbitronAgentPane
          onClose={() => setAgentOpen(false)}
          repoPath={repoPath}
          mode={doc.view.canvasEditMode}
          onModeChange={changeMode}
          onHostTool={onHostTool}
          mcpEnabled={mcpEnabled}
          pendingCall={pendingCall?.call ?? null}
          onAccept={acceptPending}
          onReject={rejectPending}
          width={agentWidth}
          onWidthChange={setAgentWidth}
        />
      )}
      {pendingConcept && <ConceptNameDialog onCancel={cancelPendingConcept} onConfirm={createNamedConcept} />}
      <ArchiveTaskModal task={pendingArchive} onCancel={() => setPendingArchive(null)} onConfirm={confirmArchive} />
    </div>
  );
}

/**
 * Places the rename box over the label it is replacing. The label is painted in world units,
 * so the box has to be sized and scaled by the camera or it stops matching the text under it.
 */
function placeRenameBox(box: HTMLInputElement, hull: CanvasConcept, cam: Camera): void {
  const band = hullLabelRect(hull);
  const at = worldToScreen(cam, band.x + HULL_LABEL_PAD, band.y);
  box.style.left = `${at.x}px`;
  box.style.top = `${at.y + (band.h / 4) * cam.scale}px`;
  box.style.width = `${Math.max(80, (band.w - HULL_LABEL_PAD * 2) * cam.scale - (DELETE_PX + DELETE_INSET_PX))}px`;
  box.style.height = `${Math.max(18, (band.h / 2) * cam.scale)}px`;
  box.style.fontSize = `${Math.max(9, HULL_LABEL_PX * cam.scale)}px`;
}

/**
 * Keeps the relation picker beside the card it is about. Unlike the rename box this is not scaled
 * by the camera — it is a panel, not painted text — but it does have to move with it, so it is
 * placed from the same pass for the same reason.
 */
function placePicker(panel: HTMLDivElement, target: PaintedCard, cam: Camera, host: { w: number; h: number }): void {
  const at = anchorPanel(worldToScreen(cam, target.x, target.y), CARD_W * cam.scale, panel.offsetWidth, panel.offsetHeight, host);
  panel.style.left = `${at.x}px`;
  panel.style.top = `${at.y}px`;
}

/** Moves a hull and every card whose primary placement it is. */
function translateHull(doc: CanvasDoc, id: string, dx: number, dy: number): CanvasDoc {
  if (dx === 0 && dy === 0) return doc;
  const placements = { ...doc.placements };
  for (const [slug, placement] of Object.entries(doc.placements)) {
    if (placement.concepts[0] !== id) continue;
    placements[slug] = { ...placement, x: placement.x + dx, y: placement.y + dy };
  }
  return {
    ...doc,
    concepts: doc.concepts.map((c) => (c.id === id ? { ...c, x: c.x + dx, y: c.y + dy } : c)),
    placements,
  };
}

/**
 * The three relation kinds, in-app rather than a native context menu so the labels can carry
 * the product wording. "same surface" is stored as `surface`.
 */
const RELATION_CHOICES: readonly { kind: CanvasRelationKind; label: string }[] = [
  { kind: "blocks", label: "blocks" },
  { kind: "surface", label: "same surface" },
  { kind: "informs", label: "informs" },
];

function RelationPicker({
  a,
  b,
  onPick,
  onCancel,
  hostRef,
}: {
  a: string;
  b: string;
  onPick: (kind: CanvasRelationKind) => void;
  onCancel: () => void;
  hostRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    // Anchored, so `left`/`top` come from the paint pass rather than the stylesheet.
    <div className="orbitron-panel orbitron-relpick orbitron-anchored" ref={hostRef}>
      <div className="orbitron-panel-hd">
        <span className="orbitron-panel-title">
          {a} ↔ {b}
        </span>
      </div>
      <div className="orbitron-panel-body">
        {RELATION_CHOICES.map((choice) => (
          <button type="button" key={choice.kind} className="orbitron-pick" onClick={() => onPick(choice.kind)}>
            <span className="orbitron-pick-name">{choice.label}</span>
          </button>
        ))}
      </div>
      <div className="orbitron-panel-foot">
        <button type="button" className="btn ghost small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * In-app multi-select over the unplaced tasks. Not a native menu: the pool can be long, the
 * rows carry draft/archived state, and the selection is multiple.
 */
function TaskPicker({
  pool,
  picked,
  target,
  onToggle,
  onCancel,
  onConfirm,
}: {
  pool: BoardTask[];
  picked: string[];
  target: string | null;
  onToggle: (slug: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="orbitron-panel">
      <div className="orbitron-panel-hd">
        <span className="orbitron-panel-title">{target ? `Add tasks to ${target}` : "Add tasks to the board"}</span>
        <span className="orbitron-panel-count">{picked.length} selected</span>
      </div>
      <div className="orbitron-panel-body">
        {pool.length === 0 && <EmptyState title="Every task is already on the board." hint="Turn on Show archived to include archived tasks." />}
        {pool.map((task) => (
          <button
            type="button"
            key={task.slug}
            className={`orbitron-pick${picked.includes(task.slug) ? " on" : ""}`}
            aria-pressed={picked.includes(task.slug)}
            onClick={() => onToggle(task.slug)}
          >
            <span className="orbitron-pick-name">{task.name}</span>
            {task.draft && <span className="pill">Draft</span>}
            {task.archived && <span className="pill task-archived">Archived</span>}
          </button>
        ))}
      </div>
      <div className="orbitron-panel-foot">
        <button type="button" className="btn small" disabled={picked.length === 0} onClick={onConfirm}>
          Add {picked.length || ""}
        </button>
        <button type="button" className="btn ghost small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * A real focusable button with a CSS tooltip, not an icon with a `title`: the toolbar is the
 * only way to reach some of these actions without knowing the bare key.
 */
function ToolButton({
  label,
  hint,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  hint?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button type="button" className={`orbitron-tool${active ? " on" : ""}`} aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick}>
      {children}
      <span className="orbitron-tooltip" role="tooltip">
        {label}
        {hint ? <b>{hint}</b> : null}
      </span>
    </button>
  );
}
