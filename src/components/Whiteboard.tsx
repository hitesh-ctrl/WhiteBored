"use client";

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { copyText } from "../lib/clipboard";
import { UploadError, prepareUpload } from "../lib/imageUpload";
import { clampImageRect, fitRect, onHandle, rectContains, resizeKeepAspect, type Rect } from "../lib/imageLayer";
import { colorFor } from "../lib/color";
import { nextBatch, ownStrokeIds, shouldAddPoint, toCanvasPoint } from "../lib/drawing";
import { findFillContainer } from "../lib/fill";
import { strokeHit } from "../lib/geometry";
import { UndoRedo } from "../lib/history";
import { newId } from "../lib/ids";
import { RECENT_KEY, parseRecent, upsertRecent } from "../lib/recent";
import { expandSelection, normalizeRect, selectionBounds, strokesInRect } from "../lib/selection";
import { drawStroke, renderOrder, safeFileName, type Drawable } from "../lib/render";
import { strokesToSvg, type ExportImage } from "../lib/svgExport";
import { socketBase } from "../lib/socketUrl";
import { throttle } from "../lib/throttle";
import { DEFAULT_VIEW, MAX_ZOOM, clampView, wheelAction, zoomAt, type View } from "../lib/viewport";
import { CANVAS_HEIGHT, CANVAS_WIDTH, MAX_POINTS_PER_STROKE, MAX_TEXT_LENGTH, fontSizeFor } from "../shared/limits";
import { clampDelta, pointsBounds, translatePoints } from "../shared/move";
import { TEMPLATES, type TemplateKey } from "../shared/templates";
import {
  BAD_TEXT_CHARS, authoredProgressSchema, authoredStrokeSchema, imageMetaSchema, imageRemovedSchema, movedSchema, remoteCursorSchema, removeSchema, renamedSchema,
  userLeftSchema, userSchema,
  type ClientToServerEvents, type ImageAddInput, type ImageMeta, type Kind, type MoveAck, type MoveInput, type Point, type Role, type ServerToClientEvents, type Stroke,
  type StrokeInput, type User,
} from "../shared/protocol";

const SOCKET_URL = socketBase(process.env.NEXT_PUBLIC_SOCKET_URL); // undefined: the page's own address
const COLORS = [
  ["Black", "#111827"], ["Red", "#dc2626"], ["Orange", "#ea580c"], ["Yellow", "#ca8a04"],
  ["Green", "#16a34a"], ["Blue", "#2563eb"], ["Purple", "#7c3aed"], ["Pink", "#db2777"], ["White", "#ffffff"],
] as const;
const TOOLS = [
  ["pen", "Pen"], ["eraser", "Eraser"], ["fill", "Fill"], ["line", "Line"], ["arrow", "Arrow"], ["rect", "Rectangle"],
  ["ellipse", "Ellipse"], ["text", "Text"], ["laser", "Laser"], ["hand", "Hand"],
] as const;
type Tool = (typeof TOOLS)[number][0];
const SHAPE_TOOLS = new Set<string>(["line", "arrow", "rect", "ellipse"]);
const VIEWER_TOOLS = new Set<Tool>(["laser", "hand"]);
const MAX_LIVE_STROKES = 200;
const MAX_LIVE_PER_AUTHOR = 5;
const BAD_TEXT_CHARS_GLOBAL = new RegExp(BAD_TEXT_CHARS.source, "gu");
const MAX_BUFFERED_EVENTS = 5000;
const ERASER_RADIUS_PX = 10; // on screen, converted to canvas units with the zoom

type Api = {
  undo(): void; redo(): void; clear(): void;
  zoomBy(factor: number): void; resetView(): void;
  exportPng(): void; exportSvg(): void;
  rename(name: string): void;
  commitText(x: number, y: number, text: string): void;
  deleteSelection(): void;
  addTemplate(key: TemplateKey): void;
  uploadPicture(file: File): void;
  setPictureOpacity(value: number): void;
  removePicture(): void;
};
const noApi: Api = {
  undo() {}, redo() {}, clear() {}, zoomBy() {}, resetView() {}, exportPng() {}, exportSvg() {}, rename() {}, commitText() {}, deleteSelection() {}, addTemplate() {}, uploadPicture() {}, setPictureOpacity() {}, removePicture() {},
};

type Props = { boardId?: string; viewId?: string; boardName: string; name: string; clientId: string; clientKey: string; ownerKey?: string };

export default function Whiteboard(props: Props) {
  const { boardId, viewId, boardName, name, clientId, clientKey, ownerKey } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cursorLayerRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<Api>(noApi);
  const initialTool: Tool = viewId ? "laser" : "pen";
  const toolRef = useRef<Tool>(initialTool);
  const colorRef = useRef<string>(COLORS[0][1]);
  const widthRef = useRef(4);
  const titleRef = useRef(boardName);
  const textDoneRef = useRef(false); // the text box was already committed or cancelled, so blur must not commit again

  // Only text and flags that appear in the UI live in React state.
  const [status, setStatus] = useState("Connecting...");
  const [notice, setNotice] = useState("");
  const [users, setUsers] = useState<User[]>([]);
  const [tool, setTool] = useState<Tool>(initialTool);
  const [color, setColor] = useState<string>(COLORS[0][1]);
  const [width, setWidth] = useState(4);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [role, setRole] = useState<Role>(viewId ? "viewer" : "editor");
  const [canClear, setCanClear] = useState(false);
  const [title, setTitle] = useState(boardName);
  const [shareViewId, setShareViewId] = useState<string | undefined>();
  const [view, setViewUi] = useState<View>(DEFAULT_VIEW);
  const [textDraft, setTextDraft] = useState<{ x: number; y: number; px: number } | null>(null);
  const [panningUi, setPanningUi] = useState(false);
  const [copied, setCopied] = useState<"edit" | "view" | null>(null);
  const [selCount, setSelCount] = useState(0);
  const [selPicture, setSelPicture] = useState<ImageMeta | null>(null);
  const [pictureMenu, setPictureMenu] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { widthRef.current = width; }, [width]);
  useEffect(() => { titleRef.current = title; }, [title]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const layer = cursorLayerRef.current!;
    const ctx = canvas.getContext("2d")!;
    const committed = document.createElement("canvas");
    committed.width = CANVAS_WIDTH;
    committed.height = CANVAS_HEIGHT;
    const cctx = committed.getContext("2d")!;

    const strokes: Stroke[] = [];
    const live = new Map<string, Drawable>(); // key "authorId:strokeId"
    const liveSeen = new Map<string, number>(); // last progress time of remote live strokes
    const pending = new Map<string, StrokeInput>(); // committed locally, not yet acknowledged
    const erasing = new Set<string>(); // strokes whose removal is in flight
    const hist = new UndoRedo<Stroke>();
    const cursors = new Map<string, { el: HTMLDivElement; x: number; y: number }>();
    const lasers = new Map<string, { el: HTMLDivElement; x: number; y: number; timer: ReturnType<typeof setTimeout> }>();
    let myRole: Role = viewId ? "viewer" : "editor";
    let myCanClear = false;
    let curView: View = DEFAULT_VIEW;
    let undoWhenSaved: string | null = null; // id of a stroke whose undo was requested before it was saved
    let disposed = false;
    let joined = false;
    let buffer: (() => void)[] = [];
    let raf = 0;
    let layerDirty = true; // the saved-strokes layer must be redrawn before the next frame
    let spaceDown = false; // Space held: any tool temporarily moves the board
    let drawing: (Drawable & { id: string; kind: Kind; sent: number; dirty: boolean; pointerId: number; timer: ReturnType<typeof setInterval> }) | null = null;
    let panning: { pointerId: number; x: number; y: number; view: View } | null = null;
    let erasingPointer: number | null = null;
    /** Strokes that were moved together: new id to the group, so undo can move them back as one. */
    type MoveGroup = { ids: string[]; origIds: string[]; dx: number; dy: number };
    const selected = new Set<string>();
    const moveGroups = new Map<string, MoveGroup>();
    /** Pictures to trace sit under the drawing; `el` is the loaded image for an upload (built-in outlines have none). */
    type PictureItem = { meta: ImageMeta; el: HTMLImageElement | null };
    const pictures = new Map<string, PictureItem>();
    const outlinePaths = new Map<string, Path2D>();
    let selectedPicture: string | null = null;
    let opacityTimer: ReturnType<typeof setTimeout> | undefined;
    let opacityBase: ImageMeta | null = null;
    let gesture:
      | { kind: "picture"; pointerId: number; mode: "move" | "resize"; id: string; start: Point; orig: Rect; moved: boolean }
      | { kind: "move"; pointerId: number; start: Point; ids: string[]; dx: number; dy: number; moved: boolean }
      | { kind: "marquee"; pointerId: number; start: Point; cur: Point; base: string[] }
      | null = null;

    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(SOCKET_URL, { transports: ["websocket"] });

    /* ----- rendering ----- */
    const viewTransform = (c: CanvasRenderingContext2D) =>
      c.setTransform(curView.zoom, 0, 0, curView.zoom, -curView.panX * curView.zoom, -curView.panY * curView.zoom);
    const paint = () => {
      raf = 0;
      if (layerDirty) {
        layerDirty = false;
        cctx.setTransform(1, 0, 0, 1, 0, 0);
        cctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        viewTransform(cctx); // stays set, so new strokes can be drawn straight onto the layer
        // strokes being dragged are drawn separately at their new place, so they are left out here
        const hide = gesture?.kind === "move" && gesture.moved ? new Set(gesture.ids) : null;
        drawPictures(cctx);
        for (const s of renderOrder(hide ? strokes.filter((x) => !hide.has(x.id)) : strokes)) drawStroke(cctx, s);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      ctx.drawImage(committed, 0, 0);
      viewTransform(ctx);
      for (const s of live.values()) drawStroke(ctx, s);

      // selection: the dragged copies, a dashed box around the selection, and the box being dragged out
      let shown: Drawable[] = strokes.filter((s) => selected.has(s.id));
      if (gesture?.kind === "move" && gesture.moved) {
        const g = gesture;
        shown = shown.map((s) => ({ ...s, points: translatePoints(s.points, g.dx, g.dy) }));
        for (const s of shown) drawStroke(ctx, s);
      }
      const box = selectionBounds(shown);
      ctx.save();
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = 1.5 / curView.zoom;
      ctx.setLineDash([6 / curView.zoom, 4 / curView.zoom]);
      if (box) {
        const pad = 4 / curView.zoom;
        ctx.strokeRect(box.x - pad, box.y - pad, box.w + 2 * pad, box.h + 2 * pad);
      }
      const pic = selectedPicture ? pictures.get(selectedPicture)?.meta : undefined;
      if (pic) {
        const pad = 3 / curView.zoom, s = 10 / curView.zoom;
        ctx.strokeRect(pic.x - pad, pic.y - pad, pic.w + 2 * pad, pic.h + 2 * pad);
        ctx.setLineDash([]);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(pic.x + pic.w - s / 2, pic.y + pic.h - s / 2, s, s); // the corner square that resizes it
        ctx.strokeRect(pic.x + pic.w - s / 2, pic.y + pic.h - s / 2, s, s);
      }
      if (gesture?.kind === "marquee") {
        const r = normalizeRect(gesture.start, gesture.cur);
        ctx.fillStyle = "rgba(37, 99, 235, 0.08)";
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.strokeRect(r.x, r.y, r.w, r.h);
      }
      ctx.restore();
    };
    const schedule = () => { raf ||= requestAnimationFrame(paint); };
    /** Redraw the saved strokes once per frame, however many changes arrive (panning sends many). */
    const rebuild = () => {
      layerDirty = true;
      schedule();
    };
    const place = (el: HTMLElement, x: number, y: number) => {
      const fx = ((x - curView.panX) * curView.zoom) / CANVAS_WIDTH;
      const fy = ((y - curView.panY) * curView.zoom) / CANVAS_HEIGHT;
      el.style.left = `${fx * 100}%`;
      el.style.top = `${fy * 100}%`;
      el.style.display = fx < 0 || fx > 1 || fy < 0 || fy > 1 ? "none" : "flex";
    };
    const setView = (v: View) => {
      curView = clampView(v);
      setViewUi(curView);
      rebuild();
      for (const c of cursors.values()) place(c.el, c.x, c.y);
      for (const l of lasers.values()) place(l.el, l.x, l.y);
    };
    const syncUi = () => {
      setCanUndo(hist.size() > 0);
      setCanRedo(hist.canRedo());
    };
    const syncSel = () => setSelCount(selected.size);

    /* ----- state changes ----- */
    const addStroke = (s: Stroke) => {
      if (strokes.some((x) => x.id === s.id)) return;
      strokes.push(s);
      if (s.kind === "fill") rebuild(); // fills sit under everything, so the layer is redrawn
      else drawStroke(cctx, s);
      live.delete(`${s.authorId}:${s.id}`);
      liveSeen.delete(`${s.authorId}:${s.id}`);
      schedule();
    };
    const removeStroke = (id: string) => {
      const i = strokes.findIndex((s) => s.id === id);
      if (i >= 0) strokes.splice(i, 1);
      pending.delete(id);
      if (undoWhenSaved === id) undoWhenSaved = null;
      hist.remove(id);
      moveGroups.delete(id);
      if (selected.delete(id)) syncSel();
      syncUi();
      rebuild();
    };
    const clearAll = () => {
      strokes.length = 0;
      selected.clear();
      moveGroups.clear();
      gesture = null;
      syncSel();
      hist.reset([]);
      undoWhenSaved = null;
      syncUi();
      for (const k of [...live.keys()]) if (!k.startsWith(`${clientId}:`)) live.delete(k);
      rebuild();
      // A stroke of ours that is still being saved may have landed before or after the clear.
      // Rejoining makes the server's state the truth again and re-sends what is still pending.
      if (pending.size > 0) {
        socket.disconnect();
        socket.connect();
      }
    };
    /** Remote live strokes are capped per author and in total, so one client cannot flood the screen. */
    const setLive = (key: string, authorId: string, d: Drawable) => {
      if (!live.has(key)) {
        const mine = [...live.keys()].filter((k) => k.startsWith(`${authorId}:`));
        const evict = mine.length >= MAX_LIVE_PER_AUTHOR ? mine[0] : live.size >= MAX_LIVE_STROKES ? live.keys().next().value : undefined;
        if (evict !== undefined) {
          live.delete(evict);
          liveSeen.delete(evict);
        }
      }
      live.set(key, d);
    };
    const removeCursor = (id: string) => {
      cursors.get(id)?.el.remove();
      cursors.delete(id);
    };
    const removeLaser = (id: string) => {
      const l = lasers.get(id);
      if (l) { clearTimeout(l.timer); l.el.remove(); }
      lasers.delete(id);
    };
    const gate = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => {
      if (joined) fn(...a);
      else if (buffer.length < MAX_BUFFERED_EVENTS) buffer.push(() => fn(...a)); // arrived before the join ack; replayed in order after it
      else {
        buffer = [];
        socket.disconnect(); // the ack never came; start over instead of growing without limit
        socket.connect();
      }
    };
    const remember = () => {
      const id = boardId ?? viewId;
      if (!id) return;
      try {
        const list = parseRecent(localStorage.getItem(RECENT_KEY));
        localStorage.setItem(RECENT_KEY, JSON.stringify(upsertRecent(list, { id, name: titleRef.current, kind: viewId ? "view" : "edit", at: Date.now() })));
      } catch { /* storage unavailable */ }
    };

    /** The pointer indicator of another person: a small dot with their name, in their own colour. */
    const makeMarker = (id: string, name: string, kind: "cursor" | "laser") => {
      const el = document.createElement("div");
      el.className = "pointer-events-none absolute z-10 -translate-x-1 -translate-y-1 items-center";
      const dot = document.createElement("span");
      const c = kind === "laser" ? "#ef4444" : colorFor(id);
      dot.className = kind === "laser" ? "block h-3.5 w-3.5 rounded-full" : "block h-2.5 w-2.5 rounded-full";
      dot.style.background = c;
      if (kind === "laser") dot.style.boxShadow = "0 0 8px 3px rgba(239,68,68,0.7)";
      const label = document.createElement("span");
      label.className = "ml-2 whitespace-nowrap rounded px-1.5 py-0.5 text-xs text-white";
      label.style.background = c;
      label.textContent = name; // text node, never HTML
      el.append(dot, label);
      layer.append(el);
      return el;
    };

    /* ----- server events ----- */
    socket.on("stroke:progress", gate((raw) => {
      const p = authoredProgressSchema.safeParse(raw);
      if (!p.success) return;
      const key = `${p.data.authorId}:${p.data.id}`;
      liveSeen.set(key, Date.now());
      const cur = live.get(key);
      if (p.data.kind !== "pen") {
        setLive(key, p.data.authorId, { kind: p.data.kind, color: p.data.color, width: p.data.width, points: [...p.data.points] }); // shapes: replace
      } else if (cur) {
        if (cur.points.length < MAX_POINTS_PER_STROKE) cur.points.push(...p.data.points.slice(1));
      } else {
        setLive(key, p.data.authorId, { kind: "pen", color: p.data.color, width: p.data.width, points: [...p.data.points] });
      }
      schedule();
    }));
    socket.on("stroke:commit", gate((raw) => {
      const p = authoredStrokeSchema.safeParse(raw);
      if (p.success) addStroke(p.data);
    }));
    socket.on("stroke:remove", gate((raw) => {
      const p = removeSchema.safeParse(raw);
      if (p.success) removeStroke(p.data.id);
    }));
    socket.on("stroke:moved", gate((raw) => {
      const p = movedSchema.safeParse(raw);
      if (!p.success) return;
      for (const id of p.data.removed) removeStroke(id);
      for (const s of p.data.added) addStroke(s);
      rebuild();
    }));
    socket.on("image:added", gate((raw) => {
      const p = imageMetaSchema.safeParse(raw);
      if (p.success && !pictures.has(p.data.id)) addPicture(p.data);
    }));
    socket.on("image:updated", gate((raw) => {
      const p = imageMetaSchema.safeParse(raw);
      const item = p.success ? pictures.get(p.data.id) : undefined;
      if (!p.success || !item || (gesture?.kind === "picture" && gesture.id === p.data.id)) return; // not while we are dragging it
      item.meta = p.data;
      if (selectedPicture === p.data.id) syncPicture();
      rebuild();
    }));
    socket.on("image:removed", gate((raw) => {
      const p = imageRemovedSchema.safeParse(raw);
      if (p.success) removePictureLocal(p.data.id);
    }));
    socket.on("board:cleared", gate(() => clearAll()));
    socket.on("board:renamed", gate((raw) => {
      const p = renamedSchema.safeParse(raw);
      if (!p.success) return;
      titleRef.current = p.data.name;
      setTitle(p.data.name);
      remember();
    }));
    socket.on("user:joined", gate((raw) => {
      const p = userSchema.safeParse(raw);
      if (p.success) setUsers((u) => [...u.filter((x) => x.id !== p.data.id), p.data]);
    }));
    socket.on("user:left", gate((raw) => {
      const p = userLeftSchema.safeParse(raw);
      if (!p.success) return;
      setUsers((u) => u.filter((x) => x.id !== p.data.id));
      removeCursor(p.data.id);
      removeLaser(p.data.id);
      for (const k of [...live.keys()]) if (k.startsWith(`${p.data.id}:`)) live.delete(k);
      schedule();
    }));
    /** A laser dot that disappears when it stops moving. Used for other people's lasers and for our own. */
    const showLaser = (id: string, label: string, x: number, y: number) => {
      let l = lasers.get(id);
      if (!l) {
        l = { el: makeMarker(id, label, "laser"), x: 0, y: 0, timer: setTimeout(() => {}, 0) };
        lasers.set(id, l);
      }
      l.x = x;
      l.y = y;
      place(l.el, x, y);
      clearTimeout(l.timer);
      l.timer = setTimeout(() => removeLaser(id), 1500);
    };
    socket.on("cursor:move", (raw) => {
      if (!joined) return;
      const p = remoteCursorSchema.safeParse(raw);
      if (!p.success) return;
      let c = cursors.get(p.data.id);
      if (!c) {
        c = { el: makeMarker(p.data.id, p.data.name, "cursor"), x: 0, y: 0 };
        cursors.set(p.data.id, c);
      }
      c.x = p.data.x;
      c.y = p.data.y;
      place(c.el, c.x, c.y);
    });
    socket.on("laser:move", (raw) => {
      if (!joined) return;
      const p = remoteCursorSchema.safeParse(raw);
      if (!p.success) return;
      showLaser(p.data.id, p.data.name, p.data.x, p.data.y);
    });

    // A remote stroke whose author never committed it (rejected, or the author lost connection)
    // would stay on screen forever, so drop live strokes that stopped growing.
    const sweep = setInterval(() => {
      const cutoff = Date.now() - 15_000;
      let changed = false;
      for (const [k, t] of liveSeen) {
        if (t < cutoff) {
          liveSeen.delete(k);
          live.delete(k);
          changed = true;
        }
      }
      if (changed) schedule();
    }, 5000);

    /* ----- commit, undo, redo, erase, clear ----- */
    const sendCommit = (s: StrokeInput, attempt = 0) => {
      if (!joined) return;
      if (attempt > 0 && !pending.has(s.id)) return; // removed while the retry was waiting // stays in `pending`, re-sent after the next join
      socket.timeout(5000).emit("stroke:commit", s, (err, res) => {
        if (disposed) return;
        if (err) {
          if (attempt < 2) sendCommit(s, attempt + 1);
          return;
        }
        if (res.ok) {
          pending.delete(s.id);
          if (undoWhenSaved === s.id) {
            undoWhenSaved = null;
            apiRef.current.undo();
          }
          return;
        }
        if (res.error === "not_joined" || res.error === "rate_limited") return;
        removeStroke(s.id);
        setNotice(res.error === "board_full" ? "The board is full, the last stroke was removed." : "The last stroke could not be saved.");
      });
    };
    /** Draw, remember for undo, and send a finished stroke. `again` marks a redo (keeps the redo list). */
    const commitLocal = (s: StrokeInput, again = false) => {
      strokes.push({ ...s, authorId: clientId });
      if (s.kind === "fill") rebuild();
      else drawStroke(cctx, s);
      if (again) hist.restore(s.id);
      else hist.recordDraw(s.id);
      syncUi();
      pending.set(s.id, s);
      sendCommit(s);
      schedule();
    };
    /** Removes one of our own strokes on the server, then locally. Used by undo and by the eraser. */
    const removeOwn = (stroke: Stroke, optimistic: boolean, keepForRedo = true) => {
      if (optimistic) {
        erasing.add(stroke.id);
        removeStroke(stroke.id);
      }
      sendRemove(stroke, optimistic, 0, keepForRedo);
    };
    const sendRemove = (stroke: Stroke, optimistic: boolean, attempt: number, keepForRedo: boolean) => {
      socket.timeout(5000).emit("stroke:undo", { id: stroke.id }, (err, res) => {
        if (disposed) return;
        if (!err && !res.ok && res.error === "rate_limited" && attempt < 6) {
          // a long sweep with the eraser can outrun the server's limit; wait instead of giving the stroke back
          setTimeout(() => { if (!disposed) sendRemove(stroke, optimistic, attempt + 1, keepForRedo); }, 200 * (attempt + 1));
          return;
        }
        erasing.delete(stroke.id);
        if (!err && (res.ok || res.error === "forbidden")) {
          if (!optimistic) removeStroke(stroke.id);
          if (res.ok && keepForRedo) { hist.pushRedo(stroke); syncUi(); }
          return;
        }
        if (optimistic) { // could not remove it, so put it back
          strokes.push(stroke);
          hist.restore(stroke.id);
          syncUi();
          rebuild();
        }
      });
    };

    /* ----- pictures to trace ----- */
    const syncPicture = () => setSelPicture(selectedPicture ? pictures.get(selectedPicture)?.meta ?? null : null);
    const drawPictures = (g: CanvasRenderingContext2D) => {
      for (const { meta, el } of pictures.values()) {
        g.save();
        g.globalAlpha = meta.opacity / 100;
        if (meta.template) {
          const outline = TEMPLATES.find((t) => t.key === meta.template);
          if (outline) {
            let path = outlinePaths.get(outline.key);
            if (!path) outlinePaths.set(outline.key, (path = new Path2D(outline.path)));
            g.translate(meta.x, meta.y);
            g.scale(meta.w / 100, meta.h / 100);
            g.lineWidth = 250 / Math.max(1, Math.min(meta.w, meta.h)); // about 2.5 units on the board, whatever the size
            g.lineCap = "round";
            g.lineJoin = "round";
            g.strokeStyle = "#475569";
            g.stroke(path);
          }
        } else if (el && el.complete && el.naturalWidth > 0) {
          g.drawImage(el, meta.x, meta.y, meta.w, meta.h);
        }
        g.restore();
      }
    };
    const addPicture = (meta: ImageMeta) => {
      let el: HTMLImageElement | null = null;
      if (!meta.template) {
        el = new Image();
        el.onload = () => rebuild();
        el.src = `/images/${meta.id}`; // from the page's own address; the id is a checked uuid
      }
      pictures.set(meta.id, { meta, el });
      rebuild();
    };
    const removePictureLocal = (id: string) => {
      pictures.delete(id);
      if (selectedPicture === id) { selectedPicture = null; syncPicture(); }
      rebuild();
    };
    const sendPicture = (req: ImageAddInput) => {
      socket.timeout(15000).emit("image:add", req, (err, res) => {
        if (disposed) return;
        if (err) return setNotice("The picture could not be sent. Try again.");
        if (!res.ok) {
          setNotice(res.error === "board_full" ? "This board has reached its limit of pictures." : res.error === "rate_limited" ? "Adding pictures too fast. Wait a few seconds." : "The picture could not be added.");
          return;
        }
        if (!pictures.has(res.image.id)) addPicture(res.image);
        selectedPicture = res.image.id;
        syncPicture();
        setNotice("Picture added. Use the Hand tool to move it, then trace over it with the Pen.");
      });
    };
    /** Tell the server about a moved, resized or faded picture; if it refuses, show the picture as it was. */
    const sendPictureUpdate = (now: ImageMeta, before: ImageMeta) => {
      socket.timeout(5000).emit("image:update", { id: now.id, x: now.x, y: now.y, w: now.w, h: now.h, opacity: now.opacity }, (err, res) => {
        if (disposed) return;
        const item = pictures.get(now.id);
        if (!item) return;
        if (!err && res.ok) { item.meta = res.image; syncPicture(); rebuild(); return; }
        item.meta = before;
        syncPicture();
        rebuild();
        setNotice("The picture could not be changed.");
      });
    };

    /* ----- selecting and moving ----- */
    const isSelectable = (s: Stroke) => s.authorId === clientId && !pending.has(s.id) && !erasing.has(s.id);
    /** The person's own stroke under the pointer: the one drawn last, lines before fills. */
    const topHit = (p: Point): Stroke | undefined => {
      const radius = ERASER_RADIUS_PX / curView.zoom;
      const hits = strokes.filter((s) => isSelectable(s) && strokeHit(s, p, radius));
      const lines = hits.filter((s) => s.kind !== "fill");
      const pool = lines.length ? lines : hits;
      return pool[pool.length - 1];
    };
    const sendMove = (req: MoveInput, attempt: number, done: (res: MoveAck | null) => void) => {
      socket.timeout(5000).emit("stroke:move", req, (err, res) => {
        if (disposed) return;
        if (err) return attempt < 2 ? sendMove(req, attempt + 1, done) : done(null); // same new ids, so a repeat cannot move twice
        if (!res.ok && res.error === "rate_limited" && attempt < 6) {
          setTimeout(() => { if (!disposed) sendMove(req, attempt + 1, done); }, 200 * (attempt + 1));
          return;
        }
        done(res);
      });
    };
    /**
     * Move strokes (or move them back, for undo). The browser shows the result at once under the
     * new ids; the server replaces the old strokes with translated copies, and a refusal puts
     * everything back.
     */
    const performMove = (oldIds: string[], newIds: string[], dx: number, dy: number, mode: "move" | "undo"): boolean => {
      const olds = oldIds.map((id) => strokes.find((s) => s.id === id)).filter((s): s is Stroke => !!s);
      if (olds.length !== oldIds.length || !joined || myRole === "viewer") return false;
      const shift = clampDelta(pointsBounds(olds.flatMap((s) => s.points)), dx, dy);
      if (mode === "move" && shift.dx === 0 && shift.dy === 0) return false;
      const renumbered = new Map(oldIds.map((id, i) => [id, newIds[i]]));
      // a fill follows its shape: its copy points at the shape's new id (the server does the same)
      const news: Stroke[] = olds.map((s, i) => {
        const { containerId, ...rest } = s;
        const next = containerId ? renumbered.get(containerId) : undefined;
        return { ...rest, id: newIds[i], points: translatePoints(s.points, shift.dx, shift.dy), ...(next ? { containerId: next } : {}) };
      });
      const oldGroups = oldIds.map((id) => moveGroups.get(id));

      for (const s of olds) {
        strokes.splice(strokes.findIndex((x) => x.id === s.id), 1);
        hist.remove(s.id);
        moveGroups.delete(s.id);
        selected.delete(s.id);
      }
      for (const s of news) { strokes.push(s); erasing.add(s.id); } // busy until the server answers
      selected.clear();
      if (mode === "move") {
        for (const id of newIds) { moveGroups.set(id, { ids: newIds, origIds: oldIds, dx: shift.dx, dy: shift.dy }); hist.recordDraw(id); selected.add(id); }
      } else {
        for (const id of newIds) hist.restore(id);
      }
      syncSel();
      syncUi();
      rebuild();

      sendMove({ moves: oldIds.map((id, i) => ({ id, newId: newIds[i] })), dx: shift.dx, dy: shift.dy }, 0, (res) => {
        for (const id of newIds) erasing.delete(id);
        if (res?.ok) {
          for (const sv of res.strokes) { // the server's copy is the truth
            const i = strokes.findIndex((x) => x.id === sv.id);
            if (i >= 0) strokes[i] = sv;
          }
          rebuild();
          return;
        }
        if (res === null) { // no answer: reload the board, which shows whichever state the server has
          setNotice("The move could not be confirmed, reloading the board.");
          socket.disconnect();
          socket.connect();
          return;
        }
        for (const s of news) {
          const i = strokes.findIndex((x) => x.id === s.id);
          if (i >= 0) strokes.splice(i, 1);
          hist.remove(s.id);
          moveGroups.delete(s.id);
          selected.delete(s.id);
        }
        for (const s of olds) strokes.push(s);
        oldIds.forEach((id, i) => { hist.restore(id); const g = oldGroups[i]; if (g) moveGroups.set(id, g); });
        selected.clear();
        syncSel();
        syncUi();
        rebuild();
        setNotice("The strokes could not be moved.");
      });
      return true;
    };

    apiRef.current = {
      addTemplate(key) {
        if (!joined || myRole === "viewer") return;
        const r = fitRect(100, 100);
        sendPicture({ id: newId(), template: key, x: r.x, y: r.y, w: r.w, h: r.h, opacity: 60 });
      },
      async uploadPicture(file) {
        if (!joined || myRole === "viewer") return;
        try {
          const up = await prepareUpload(file); // shrunk and re-encoded here; the server checks it again
          const r = fitRect(up.width, up.height);
          if (!disposed) sendPicture({ id: newId(), data: up.bytes, x: r.x, y: r.y, w: r.w, h: r.h, opacity: 40 });
        } catch (err) {
          setNotice(err instanceof UploadError ? err.message : "That picture could not be used.");
        }
      },
      setPictureOpacity(value) {
        const item = selectedPicture ? pictures.get(selectedPicture) : undefined;
        if (!item || !joined || myRole === "viewer") return;
        opacityBase ??= item.meta; // what to go back to if the server refuses
        item.meta = { ...item.meta, opacity: Math.min(100, Math.max(5, Math.round(value))) };
        syncPicture();
        rebuild();
        clearTimeout(opacityTimer);
        opacityTimer = setTimeout(() => {
          const base = opacityBase;
          opacityBase = null;
          const now = pictures.get(item.meta.id);
          if (base && now) sendPictureUpdate(now.meta, base);
        }, 350);
      },
      removePicture() {
        const id = selectedPicture;
        if (!id || !joined || myRole === "viewer") return;
        socket.timeout(5000).emit("image:remove", { id }, (err, res) => {
          if (disposed) return;
          if (err || !res.ok) return setNotice("The picture could not be removed.");
          removePictureLocal(id);
        });
      },
      deleteSelection() {
        if (!joined || myRole === "viewer") return;
        for (const s of strokes.filter((x) => selected.has(x.id) && isSelectable(x))) removeOwn(s, true);
        selected.clear();
        syncSel();
        schedule();
      },
      undo() {
        const id = hist.top();
        if (!joined || myRole === "viewer" || !id) return;
        if (pending.has(id)) {
          undoWhenSaved = id; // the server does not know this stroke yet, undo as soon as it is saved
          return;
        }
        const group = moveGroups.get(id);
        if (group && group.ids.every((i) => strokes.some((s) => s.id === i) && !erasing.has(i) && !pending.has(i))) {
          performMove(group.ids, group.origIds, -group.dx, -group.dy, "undo"); // undo of a move: move back
          return;
        }
        moveGroups.delete(id);
        const stroke = strokes.find((s) => s.id === id);
        if (!stroke || erasing.has(id)) return;
        erasing.add(id);
        removeOwn(stroke, false);
      },
      redo() {
        if (!joined || myRole === "viewer") return;
        const s = hist.popRedo();
        if (!s) return;
        commitLocal({ id: s.id, kind: s.kind, color: s.color, width: s.width, points: s.points, ...(s.text ? { text: s.text } : {}), ...(s.containerId ? { containerId: s.containerId } : {}) }, true);
      },
      clear() {
        if (!joined || !myCanClear || !window.confirm("Clear the whole board for everyone?")) return;
        socket.timeout(5000).emit("board:clear", (err, res) => {
          if (!disposed && !err && res.ok) clearAll();
        });
      },
      zoomBy(factor) {
        const mid: [number, number] = [curView.panX + CANVAS_WIDTH / curView.zoom / 2, curView.panY + CANVAS_HEIGHT / curView.zoom / 2];
        setView(zoomAt(curView, curView.zoom * factor, mid));
      },
      resetView() { setView(DEFAULT_VIEW); },
      exportPng() {
        const out = document.createElement("canvas");
        out.width = CANVAS_WIDTH;
        out.height = CANVAS_HEIGHT;
        const g = out.getContext("2d")!;
        g.fillStyle = "#ffffff";
        g.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        drawPictures(g);
        for (const s of renderOrder(strokes)) drawStroke(g, s);
        out.toBlob((blob) => blob && download(blob, safeFileName(titleRef.current, "png")), "image/png");
      },
      exportSvg() {
        const embedded: ExportImage[] = [];
        for (const { meta, el } of pictures.values()) {
          const base = { x: meta.x, y: meta.y, w: meta.w, h: meta.h, opacity: meta.opacity };
          if (meta.template) embedded.push({ ...base, template: meta.template });
          else if (el && el.complete && el.naturalWidth > 0) {
            const tmp = document.createElement("canvas"); // the picture is embedded in the file, so it still shows without the board
            tmp.width = el.naturalWidth;
            tmp.height = el.naturalHeight;
            tmp.getContext("2d")!.drawImage(el, 0, 0);
            embedded.push({ ...base, href: tmp.toDataURL("image/jpeg", 0.85) });
          }
        }
        download(new Blob([strokesToSvg(strokes, embedded)], { type: "image/svg+xml" }), safeFileName(titleRef.current, "svg"));
      },
      rename(newName) {
        socket.timeout(5000).emit("board:rename", { name: newName }, (err, res) => {
          if (disposed) return;
          if (err || !res.ok) return setNotice("Could not rename the board.");
          const trimmed = newName.trim();
          titleRef.current = trimmed;
          setTitle(trimmed);
          remember();
        });
      },
      commitText(x, y, text) {
        const clean = text.replace(BAD_TEXT_CHARS_GLOBAL, "").trim().slice(0, MAX_TEXT_LENGTH).replace(/[\uD800-\uDBFF]$/, "");
        if (!clean || !joined || myRole === "viewer") return;
        commitLocal({ id: newId(), kind: "text", color: colorRef.current, width: widthRef.current, points: [[x, y]], text: clean });
      },
    };

    /* ----- connection ----- */
    socket.on("connect", () => {
      joined = false;
      buffer = [];
      setStatus("Joining...");
      const payload = viewId
        ? { viewId, clientId, name, clientKey }
        : { boardId, clientId, name, clientKey, ...(ownerKey ? { ownerKey } : {}) };
      socket.timeout(10000).emit("board:join", payload, (err, ack) => {
        if (disposed) return;
        if (err) {
          setStatus("Could not join the board, retrying...");
          setTimeout(() => {
            if (!disposed) {
              socket.disconnect();
              socket.connect();
            }
          }, 2000);
          return;
        }
        if (!ack.ok) {
          if (ack.error === "internal" || ack.error === "rate_limited") {
            setStatus("Could not join the board, retrying...");
            setTimeout(() => {
              if (!disposed) {
                socket.disconnect();
                socket.connect();
              }
            }, 3000);
            return;
          }
          return setStatus(ack.error === "not_found" ? "Board not found" : "Could not join the board");
        }
        strokes.length = 0;
        for (const raw of ack.strokes) {
          const one = authoredStrokeSchema.safeParse(raw);
          if (one.success) strokes.push(one.data); // skip a bad row instead of dropping the board
        }
        for (const k of [...live.keys()]) if (!k.startsWith(`${clientId}:`)) live.delete(k);
        liveSeen.clear();
        undoWhenSaved = null;
        for (const id of [...cursors.keys()]) removeCursor(id);
        for (const id of [...lasers.keys()]) removeLaser(id);
        myRole = ack.role;
        myCanClear = ack.canClear;
        setRole(ack.role);
        setCanClear(ack.canClear);
        setShareViewId(ack.viewId);
        titleRef.current = ack.boardName;
        setTitle(ack.boardName);
        if (ack.role === "viewer" && !VIEWER_TOOLS.has(toolRef.current)) setTool("laser");
        const own = ownStrokeIds(strokes, clientId);
        for (const id of pending.keys()) if (!strokes.some((s) => s.id === id)) own.push(id);
        hist.reset(own);
        selected.clear();
        moveGroups.clear();
        erasing.clear();
        gesture = null;
        syncSel();
        syncUi();
        pictures.clear();
        selectedPicture = null;
        for (const raw of ack.images ?? []) {
          const one = imageMetaSchema.safeParse(raw);
          if (one.success) addPicture(one.data);
        }
        syncPicture();
        setUsers(ack.users);
        for (const s of pending.values()) if (!strokes.some((x) => x.id === s.id)) strokes.push({ ...s, authorId: clientId });
        rebuild();
        remember();
        joined = true;
        setStatus("Connected");
        const replay = buffer;
        buffer = [];
        replay.forEach((f) => f());
        for (const s of pending.values()) sendCommit(s);
      });
    });
    socket.on("disconnect", () => {
      joined = false;
      setStatus("Reconnecting...");
    });
    socket.on("connect_error", () => setStatus("Reconnecting..."));

    /* ----- pointer input ----- */
    const point = (e: { clientX: number; clientY: number }): Point =>
      toCanvasPoint(e.clientX, e.clientY, canvas.getBoundingClientRect(), curView);
    const sendCursor = throttle((p: Point) => socket.volatile.emit("cursor:move", { x: p[0], y: p[1] }), 33);
    const sendLaser = throttle((p: Point) => socket.volatile.emit("laser:move", { x: p[0], y: p[1] }), 33);

    const flush = () => {
      const d = drawing;
      if (!d || !joined) return; // not sent, so it is offered again on the next tick
      if (d.kind === "pen") {
        const b = nextBatch(d.points, d.sent);
        if (!b) return;
        d.sent = b.sent;
        socket.emit("stroke:progress", { id: d.id, kind: "pen", color: d.color, width: d.width, points: b.batch });
      } else if (d.dirty) {
        d.dirty = false;
        socket.emit("stroke:progress", { id: d.id, kind: d.kind, color: d.color, width: d.width, points: [...d.points] });
      }
    };
    const finish = () => {
      const d = drawing;
      if (!d) return;
      clearInterval(d.timer);
      flush();
      drawing = null;
      live.delete(`${clientId}:${d.id}`);
      if (d.kind !== "pen") {
        const [a, b] = d.points;
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 3) return schedule(); // a click, not a shape
      }
      commitLocal({ id: d.id, kind: d.kind, color: d.color, width: d.width, points: d.points });
    };
    const eraseAt = (p: Point) => {
      if (!joined) return;
      const radius = ERASER_RADIUS_PX / curView.zoom;
      const hits = strokes.filter(
        (s) => s.authorId === clientId && !pending.has(s.id) && !erasing.has(s.id) && strokeHit(s, p, radius),
      );
      // Lines inside a filled area come first; the fill itself only goes when nothing else is under the pointer.
      const lines = hits.filter((s) => s.kind !== "fill");
      const doomed = new Set(lines.length ? lines : hits);
      // erasing a shape takes its own fills with it
      for (const s of [...doomed]) {
        if (s.kind === "fill") continue;
        for (const f of strokes) if (f.kind === "fill" && f.containerId === s.id && isSelectable(f)) doomed.add(f);
      }
      for (const s of doomed) removeOwn(s, true);
    };

    const startPan = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      panning = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, view: curView };
      setPanningUi(true);
    };
    /** The Hand tool: select, move and box-select your strokes; empty space moves the view when zoomed in. */
    const handDown = (e: PointerEvent) => {
      const p = point(e);
      if (!joined || myRole === "viewer") {
        if (curView.zoom > 1) startPan(e);
        return;
      }
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const mine = (m: ImageMeta) => myRole === "owner" || m.authorId === clientId; // pictures you added, or any as the owner
      const current = selectedPicture ? pictures.get(selectedPicture)?.meta : undefined;
      if (current && mine(current) && onHandle(current, p, 12 / curView.zoom)) {
        canvas.setPointerCapture(e.pointerId);
        const [x, y] = toCanvasPointRaw(e.clientX, e.clientY, canvas.getBoundingClientRect(), curView);
        gesture = { kind: "picture", pointerId: e.pointerId, mode: "resize", id: current.id, start: [x, y], orig: { x: current.x, y: current.y, w: current.w, h: current.h }, moved: false };
        return;
      }
      let hit = topHit(p);
      // clicking inside a filled shape picks the shape (and so its fills), not the fill alone
      if (hit?.kind === "fill" && hit.containerId) {
        const shape = strokes.find((s) => s.id === hit!.containerId);
        if (shape && isSelectable(shape)) hit = shape;
      }
      if (hit) {
        if (selectedPicture) { selectedPicture = null; syncPicture(); } // choosing a stroke lets go of the picture
        const group = expandSelection(strokes, new Set([hit.id]), isSelectable); // the shape and its fills
        if (e.shiftKey) { const had = selected.has(hit.id); for (const id of group) { if (had) selected.delete(id); else selected.add(id); } }
        else if (!selected.has(hit.id)) { selected.clear(); for (const id of group) selected.add(id); }
        syncSel();
        if (selected.has(hit.id)) {
          canvas.setPointerCapture(e.pointerId);
          const [x, y] = toCanvasPointRaw(e.clientX, e.clientY, canvas.getBoundingClientRect(), curView);
          gesture = { kind: "move", pointerId: e.pointerId, start: [x, y], ids: [...selected], dx: 0, dy: 0, moved: false };
        }
        schedule();
        return;
      }
      // no stroke under the pointer: a picture you may change, drawn last on top, is picked next (Shift skips this to box-select)
      if (!e.shiftKey) {
        const pic = [...pictures.values()].reverse().find((it) => mine(it.meta) && rectContains(it.meta, p));
        if (pic) {
          selected.clear();
          syncSel();
          selectedPicture = pic.meta.id;
          syncPicture();
          canvas.setPointerCapture(e.pointerId);
          const [x, y] = toCanvasPointRaw(e.clientX, e.clientY, canvas.getBoundingClientRect(), curView);
          gesture = { kind: "picture", pointerId: e.pointerId, mode: "move", id: pic.meta.id, start: [x, y], orig: { x: pic.meta.x, y: pic.meta.y, w: pic.meta.w, h: pic.meta.h }, moved: false };
          schedule();
          return;
        }
      }
      if (selectedPicture) { selectedPicture = null; syncPicture(); schedule(); }
      if (curView.zoom > 1 && !e.shiftKey) return startPan(e);
      canvas.setPointerCapture(e.pointerId);
      const base = e.shiftKey ? [...selected] : [];
      if (!e.shiftKey) { selected.clear(); syncSel(); }
      gesture = { kind: "marquee", pointerId: e.pointerId, start: p, cur: p, base };
      schedule();
    };

    const onDown = (e: PointerEvent) => {
      const t = toolRef.current;
      const forcePan = e.button === 1 || spaceDown;
      if (!e.isPrimary && !forcePan) return;
      if (drawing || panning || gesture || erasingPointer !== null) return;
      if (forcePan) return startPan(e);
      if (t === "hand") return handDown(e);
      if (!joined || myRole === "viewer" || t === "laser" || (e.pointerType === "mouse" && e.button !== 0)) return;
      if (t === "text") {
        const p = point(e);
        const rect = canvas.getBoundingClientRect();
        textDoneRef.current = false;
        setTextDraft({ x: p[0], y: p[1], px: (fontSizeFor(widthRef.current) * curView.zoom * rect.width) / CANVAS_WIDTH });
        e.preventDefault();
        return;
      }
      if (t === "fill") {
        e.preventDefault();
        const container = findFillContainer(strokes, point(e));
        if (!container) return setNotice("Click inside a closed shape: a rectangle, an ellipse or a loop drawn with the pen.");
        // a new colour replaces this person's earlier fill of the same shape instead of stacking on it
        for (const old of strokes.filter((s) => s.kind === "fill" && s.containerId === container.id && isSelectable(s))) removeOwn(old, true, false);
        commitLocal({ id: newId(), kind: "fill", color: colorRef.current, width: 1, containerId: container.id, points: container.polygon });
        return;
      }
      canvas.setPointerCapture(e.pointerId);
      const p = point(e);
      if (t === "eraser") {
        erasingPointer = e.pointerId;
        eraseAt(p);
        return;
      }
      const kind = t as Kind;
      const d = {
        id: newId(), kind, color: colorRef.current, width: widthRef.current,
        points: (SHAPE_TOOLS.has(t) ? [p, p] : [p]) as Point[],
        sent: 0, dirty: SHAPE_TOOLS.has(t), pointerId: e.pointerId, timer: setInterval(flush, 50),
      };
      drawing = d;
      live.set(`${clientId}:${d.id}`, d);
      flush();
      schedule();
    };
    const onMove = (e: PointerEvent) => {
      if (panning && e.pointerId === panning.pointerId) {
        const rect = canvas.getBoundingClientRect();
        const v = panning.view;
        setView({
          ...v,
          panX: v.panX - ((e.clientX - panning.x) / rect.width) * (CANVAS_WIDTH / v.zoom),
          panY: v.panY - ((e.clientY - panning.y) / rect.height) * (CANVAS_HEIGHT / v.zoom),
        });
        return;
      }
      if (gesture && e.pointerId === gesture.pointerId) {
        if (gesture.kind === "picture") {
          const [x, y] = toCanvasPointRaw(e.clientX, e.clientY, canvas.getBoundingClientRect(), curView);
          const dx = x - gesture.start[0], dy = y - gesture.start[1];
          if (!gesture.moved && Math.hypot(dx, dy) >= 3 / curView.zoom) gesture.moved = true; // a click is not a drag
          const item = pictures.get(gesture.id);
          if (gesture.moved && item) {
            const o = gesture.orig;
            const next = gesture.mode === "move" ? clampImageRect({ ...o, x: o.x + dx, y: o.y + dy }) : clampImageRect(resizeKeepAspect(o, o.w + dx));
            item.meta = { ...item.meta, ...next };
            syncPicture();
            rebuild();
          }
          schedule();
          return;
        }
        if (gesture.kind === "move") {
          const [x, y] = toCanvasPointRaw(e.clientX, e.clientY, canvas.getBoundingClientRect(), curView);
          const rawDx = x - gesture.start[0], rawDy = y - gesture.start[1];
          const group = gesture.ids.map((id) => strokes.find((s) => s.id === id)).filter((s): s is Stroke => !!s);
          const c = clampDelta(pointsBounds(group.flatMap((s) => s.points)), rawDx, rawDy);
          gesture.dx = c.dx;
          gesture.dy = c.dy;
          if (!gesture.moved && Math.hypot(rawDx, rawDy) >= 3 / curView.zoom) { gesture.moved = true; layerDirty = true; } // a click is not a drag
        } else {
          gesture.cur = point(e);
          const inside = strokesInRect(strokes, normalizeRect(gesture.start, gesture.cur), isSelectable).map((s) => s.id);
          selected.clear();
          for (const id of expandSelection(strokes, new Set([...gesture.base, ...inside]), isSelectable)) selected.add(id);
          syncSel();
        }
        schedule();
        return;
      }
      if (toolRef.current === "laser") {
        const p = point(e);
        showLaser(clientId, "You", p[0], p[1]); // the server never echoes to the sender, so show our own dot here
        if (joined) sendLaser(p);
      } else if (joined) sendCursor(point(e));
      if (erasingPointer === e.pointerId) {
        for (const ev of e.getCoalescedEvents?.() ?? [e]) eraseAt(point(ev));
        return;
      }
      if (!drawing || e.pointerId !== drawing.pointerId) return;
      const events = e.getCoalescedEvents?.() ?? [e];
      for (const ev of events.length ? events : [e]) {
        const p = point(ev);
        if (drawing.kind === "pen") {
          if (drawing.points.length < MAX_POINTS_PER_STROKE && shouldAddPoint(drawing.points[drawing.points.length - 1], p)) {
            drawing.points.push(p);
          }
        } else {
          drawing.points = [drawing.points[0], p];
          drawing.dirty = true;
        }
      }
      schedule();
    };
    const onUp = (e: PointerEvent) => {
      if (panning && e.pointerId === panning.pointerId) { panning = null; setPanningUi(false); return; }
      if (erasingPointer === e.pointerId) { erasingPointer = null; return; }
      if (gesture && e.pointerId === gesture.pointerId) {
        const g = gesture;
        gesture = null;
        layerDirty = true; // the dragged strokes were left out of the layer
        if (g.kind === "move" && g.moved) performMove(g.ids, g.ids.map(() => newId()), g.dx, g.dy, "move");
        if (g.kind === "picture" && g.moved) {
          const item = pictures.get(g.id);
          if (item) sendPictureUpdate(item.meta, { ...item.meta, ...g.orig });
        }
        schedule();
        return;
      }
      if (!drawing || e.pointerId !== drawing.pointerId) return;
      const p = point(e); // keep the final position
      if (drawing.kind === "pen") {
        if (drawing.points.length < MAX_POINTS_PER_STROKE && shouldAddPoint(drawing.points[drawing.points.length - 1], p)) drawing.points.push(p);
      } else {
        drawing.points = [drawing.points[0], p];
        drawing.dirty = true;
      }
      finish();
    };
    const onWheel = (e: WheelEvent) => {
      const action = wheelAction(e, curView.zoom);
      if (action.kind === "none") return; // the whole board is visible: let the page scroll
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      if (action.kind === "zoom") {
        const [ax, ay] = toCanvasPointRaw(e.clientX, e.clientY, rect, curView);
        setView(zoomAt(curView, curView.zoom * action.factor, [ax, ay]));
      } else {
        setView({
          ...curView,
          panX: curView.panX + (action.dx / rect.width) * (CANVAS_WIDTH / curView.zoom),
          panY: curView.panY + (action.dy / rect.height) * (CANVAS_HEIGHT / curView.zoom),
        });
      }
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("lostpointercapture", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    const noMenu = (e: Event) => e.preventDefault(); // a long press must not open a menu and cancel the stroke
    canvas.addEventListener("contextmenu", noMenu);

    const onKeyUp = (e: KeyboardEvent) => { if (e.code === "Space") spaceDown = false; };
    const onBlurWindow = () => { spaceDown = false; };
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.code === "Space") {
        if (tag === "BUTTON") return; // Space presses a focused button
        spaceDown = true;
        e.preventDefault(); // hold Space and drag to move the board
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selected.size > 0) { e.preventDefault(); apiRef.current.deleteSelection(); }
        else if (selectedPicture) { e.preventDefault(); apiRef.current.removePicture(); }
        return;
      }
      if (e.key === "Escape") {
        if (selected.size > 0) { selected.clear(); syncSel(); schedule(); }
        if (selectedPicture) { selectedPicture = null; syncPicture(); schedule(); }
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "a" && toolRef.current === "hand" && joined && myRole !== "viewer") {
        e.preventDefault();
        for (const s of strokes) if (isSelectable(s)) selected.add(s.id);
        syncSel();
        schedule();
        return;
      }
      if (k === "z" && !e.shiftKey) { e.preventDefault(); apiRef.current.undo(); }
      else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); apiRef.current.redo(); }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlurWindow);

    return () => {
      disposed = true;
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlurWindow);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("lostpointercapture", onUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", noMenu);
      clearInterval(sweep);
      if (drawing) clearInterval(drawing.timer);
      for (const id of [...lasers.keys()]) removeLaser(id);
      sendCursor.cancel();
      sendLaser.cancel();
      if (raf) cancelAnimationFrame(raf);
      socket.removeAllListeners();
      socket.disconnect();
      apiRef.current = noApi;
      cursors.clear();
      layer.replaceChildren();
    };
  }, [boardId, viewId, clientId, name, ownerKey]);

  const copy = async (text: string, done: string, which: "edit" | "view") => {
    if (await copyText(text)) {
      setNotice(done);
      setCopied(which);
      setTimeout(() => setCopied(null), 2000);
    } else {
      // Neither copy method is allowed here, so show the link to copy by hand.
      window.prompt("Copy this link (Ctrl/Cmd+C):", text);
    }
  };
  const readOnly = role === "viewer";
  const toolHint =
    tool === "hand"
      ? readOnly
        ? view.zoom <= 1
          ? "Zoom in (the + button, or Ctrl/Cmd + scroll), then drag to move around."
          : "Drag to move around, or just scroll."
        : "Click one of your strokes, or a picture you added, to select it and drag to move it (the square at a picture's corner resizes it). Hold Shift to box-select over a picture. Drag empty space to select several (zoomed in, empty space moves the view and Shift+drag selects). Delete removes the selection. Holding Space moves the view with any tool."
      : tool === "fill"
        ? "Click inside a rectangle, an ellipse or a loop drawn with the pen to fill it. The fill stays with its shape when you move, erase or delete it."
        : tool === "eraser"
          ? "Drag over your own strokes to remove them."
          : tool === "text"
            ? "Click where the text should go, type, then press Enter."
            : tool === "laser"
              ? "Move the mouse over the board to point at things. You and everyone else see a red dot that fades when you stop."
              : "";
  const tools = TOOLS.filter(([id]) => !readOnly || VIEWER_TOOLS.has(id));
  const cursorClass = tool === "hand" ? (panningUi ? "cursor-grabbing" : "cursor-grab") : tool === "fill" ? "cursor-pointer" : tool === "eraser" ? "cursor-cell" : tool === "text" ? "cursor-text" : "cursor-crosshair";
  const btn = "rounded border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-40";

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-3 p-3 sm:p-4">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {renaming ? (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              apiRef.current.rename(renameValue);
              setRenaming(false);
            }}
          >
            <label htmlFor="rename" className="sr-only">Board name</label>
            <input id="rename" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} maxLength={30} autoFocus className="rounded border border-slate-300 bg-white px-2 py-1" />
            <button className={btn}>Save</button>
            <button type="button" className={btn} onClick={() => setRenaming(false)}>Cancel</button>
          </form>
        ) : (
          <h1 className="text-xl font-semibold">{title}</h1>
        )}
        {role === "owner" && !renaming && (
          <button className={btn} onClick={() => { setRenameValue(title); setRenaming(true); }}>Rename</button>
        )}
        <span role="status" className="text-sm text-slate-600">{status}</span>
        {readOnly && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900">View only</span>}
        {role === "owner" && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-900">Owner</span>}
        <div className="ml-auto flex flex-wrap gap-2">
          {boardId && <button onClick={() => copy(`${window.location.origin}/board/${boardId}`, "Link copied. Send it to the people who should draw.", "edit")} aria-label="Copy link" className={btn}>{copied === "edit" ? "Link copied ✓" : "Copy link"}</button>}
          {shareViewId && <button onClick={() => copy(`${window.location.origin}/view/${shareViewId}`, "View-only link copied. People with it can watch but not draw.", "view")} aria-label="Copy view-only link" className={btn}>{copied === "view" ? "Link copied ✓" : "Copy view-only link"}</button>}
        </div>
      </header>

      <div
        className="flex flex-wrap items-center gap-3 rounded border border-slate-200 bg-white p-2"
        // A mouse click on a button must not leave it focused: Space, Delete and Ctrl+Z are shortcuts for the
        // board and would otherwise be taken by the button. Keyboard users still tab to buttons as usual.
        onMouseDown={(e) => { if ((e.target as HTMLElement).closest("button")) e.preventDefault(); }}
      >
        <div role="group" aria-label="Tools" className="flex flex-wrap gap-1">
          {tools.map(([id, label]) => (
            <button
              key={id} type="button" aria-pressed={tool === id} onClick={() => setTool(id)}
              className={`rounded border px-2.5 py-1 text-sm ${tool === id ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 hover:bg-slate-100"}`}
            >
              {label}
            </button>
          ))}
        </div>
        {!readOnly && (
          <>
            <div role="group" aria-label="Colour" className="flex gap-1.5">
              {COLORS.map(([label, hex]) => (
                <button
                  key={hex} type="button" aria-label={label} aria-pressed={color === hex}
                  onClick={() => setColor(hex)} style={{ backgroundColor: hex }}
                  className={`h-7 w-7 rounded-full border-2 ${color === hex ? "border-slate-900 ring-2 ring-slate-400" : hex === "#ffffff" ? "border-slate-300" : "border-white"}`}
                />
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm">
              Width
              <input type="range" min={1} max={40} value={width} onChange={(e) => setWidth(Number(e.target.value))} />
              <span className="w-6 tabular-nums">{width}</span>
            </label>
            <button onClick={() => apiRef.current.undo()} disabled={!canUndo} className={btn}>Undo</button>
            <button onClick={() => apiRef.current.redo()} disabled={!canRedo} className={btn}>Redo</button>
          </>
        )}
        <div role="group" aria-label="Zoom" className="flex items-center gap-1">
          <button aria-label="Zoom out" onClick={() => apiRef.current.zoomBy(1 / 1.25)} disabled={view.zoom <= 1} className={btn}>-</button>
          <button aria-label="Reset zoom" onClick={() => apiRef.current.resetView()} className={`${btn} w-16 tabular-nums`}>{Math.round(view.zoom * 100)}%</button>
          <button aria-label="Zoom in" onClick={() => apiRef.current.zoomBy(1.25)} disabled={view.zoom >= MAX_ZOOM} className={btn}>+</button>
        </div>
        {!readOnly && (
          <div className="relative">
            <button type="button" aria-expanded={pictureMenu} onClick={() => setPictureMenu((v) => !v)} className={btn}>Add picture</button>
            {pictureMenu && (
              <div role="group" aria-label="Add a picture to trace" className="absolute z-30 mt-1 w-72 rounded border border-slate-300 bg-white p-3 shadow-lg">
                <button type="button" onClick={() => fileRef.current?.click()} className={`${btn} w-full`}>Upload from this device</button>
                <p className="mt-2 text-xs text-slate-600">JPEG, PNG or WebP. It is shrunk first. Or trace a built-in outline:</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {TEMPLATES.map((t) => (
                    <button key={t.key} type="button" onClick={() => { apiRef.current.addTemplate(t.key); setPictureMenu(false); }} className={btn}>{t.label}</button>
                  ))}
                </div>
              </div>
            )}
            <input
              ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" aria-label="Choose a picture to upload" tabIndex={-1}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; setPictureMenu(false); if (f) apiRef.current.uploadPicture(f); }}
            />
          </div>
        )}
        <div role="group" aria-label="Export" className="flex gap-1">
          <button onClick={() => apiRef.current.exportPng()} className={btn}>Export PNG</button>
          <button onClick={() => apiRef.current.exportSvg()} className={btn}>Export SVG</button>
        </div>
        {canClear && (
          <button onClick={() => apiRef.current.clear()} className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50">
            Clear board
          </button>
        )}
      </div>

      <div className="relative w-full overflow-hidden rounded border border-slate-300 bg-white" style={{ aspectRatio: `${CANVAS_WIDTH} / ${CANVAS_HEIGHT}` }}>
        <canvas
          ref={canvasRef} width={CANVAS_WIDTH} height={CANVAS_HEIGHT}
          aria-label="Shared drawing canvas. Draw with a mouse, finger or pen."
          className={`absolute inset-0 h-full w-full ${cursorClass}`}
          style={{ touchAction: "none" }}
        />
        <div ref={cursorLayerRef} className="pointer-events-none absolute inset-0" aria-hidden="true" />
        {textDraft && (
          <input
            autoFocus maxLength={MAX_TEXT_LENGTH} aria-label="Text to place on the board"
            className="absolute z-20 border border-dashed border-slate-500 bg-white/80 px-1 outline-none"
            style={{
              left: `${(((textDraft.x - view.panX) * view.zoom) / CANVAS_WIDTH) * 100}%`,
              top: `${(((textDraft.y - view.panY) * view.zoom) / CANVAS_HEIGHT) * 100}%`,
              fontSize: textDraft.px, color, minWidth: "8ch",
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                textDoneRef.current = true;
                apiRef.current.commitText(textDraft.x, textDraft.y, e.currentTarget.value);
                setTextDraft(null);
              } else if (e.key === "Escape") {
                textDoneRef.current = true;
                setTextDraft(null);
              }
            }}
            onBlur={(e) => {
              // clicking a colour or switching windows keeps what was typed
              if (!textDoneRef.current) apiRef.current.commitText(textDraft.x, textDraft.y, e.currentTarget.value);
              setTextDraft(null);
            }}
          />
        )}
      </div>

      {/* under the canvas, so showing or hiding it never moves the drawing area */}
      {/* one row of fixed height below the canvas: the tool hint and the controls of whatever is selected, so nothing above the drawing area ever moves */}
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-3">
        <p role="note" className="max-w-3xl text-sm text-slate-600">{toolHint}</p>
        <div className="flex flex-wrap items-center gap-2">
          {selCount > 0 && !readOnly && (
            <button onClick={() => apiRef.current.deleteSelection()} className={btn}>Delete selection ({selCount})</button>
          )}
          {selPicture && !readOnly && (
            <div role="group" aria-label="Selected picture" className="flex items-center gap-2 rounded border border-blue-300 bg-blue-50 px-2 py-1 text-sm">
              <label className="flex items-center gap-2">
                Picture opacity
                <input type="range" min={5} max={100} value={selPicture.opacity} onChange={(e) => apiRef.current.setPictureOpacity(Number(e.target.value))} />
                <span className="w-9 tabular-nums">{selPicture.opacity}%</span>
              </label>
              <button type="button" onClick={() => apiRef.current.removePicture()} className={btn}>Remove picture</button>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-slate-600">On this board:</span>
        <ul aria-label="People on this board" className="flex flex-wrap gap-2">
          {users.map((u) => (
            <li key={u.id} className="flex items-center gap-1.5 rounded-full bg-slate-200 px-2 py-0.5">
              <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full" style={{ background: colorFor(u.id) }} />
              {u.name}{u.id === clientId ? " (you)" : ""}
            </li>
          ))}
        </ul>
      </div>
      {/* messages appear in the corner of the window, so they are never below the visible area */}
      <div role="status" aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-50 max-w-sm">
        {notice && <span className="block rounded bg-slate-900 px-3 py-2 text-sm text-white shadow-lg">{notice}</span>}
      </div>
    </main>
  );
}

function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Canvas position under the pointer without rounding, used as the zoom anchor. */
function toCanvasPointRaw(clientX: number, clientY: number, rect: DOMRect, v: View): [number, number] {
  return [
    v.panX + ((clientX - rect.left) / rect.width) * (CANVAS_WIDTH / v.zoom),
    v.panY + ((clientY - rect.top) / rect.height) * (CANVAS_HEIGHT / v.zoom),
  ];
}
