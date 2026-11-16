"use client";

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { colorFor } from "../lib/color";
import { nextBatch, ownStrokeIds, shouldAddPoint, toCanvasPoint } from "../lib/drawing";
import { strokeHit } from "../lib/geometry";
import { UndoRedo } from "../lib/history";
import { newId } from "../lib/ids";
import { RECENT_KEY, parseRecent, upsertRecent } from "../lib/recent";
import { drawStroke, safeFileName, type Drawable } from "../lib/render";
import { strokesToSvg } from "../lib/svgExport";
import { throttle } from "../lib/throttle";
import { DEFAULT_VIEW, MAX_ZOOM, clampView, zoomAt, type View } from "../lib/viewport";
import { CANVAS_HEIGHT, CANVAS_WIDTH, MAX_POINTS_PER_STROKE, MAX_TEXT_LENGTH, fontSizeFor } from "../shared/limits";
import {
  authoredProgressSchema, authoredStrokeSchema, remoteCursorSchema, removeSchema, renamedSchema,
  userLeftSchema, userSchema,
  type ClientToServerEvents, type Kind, type Point, type Role, type ServerToClientEvents, type Stroke,
  type StrokeInput, type User,
} from "../shared/protocol";

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL ?? "http://localhost:4000";
const COLORS = [
  ["Black", "#111827"], ["Red", "#dc2626"], ["Orange", "#ea580c"], ["Yellow", "#ca8a04"],
  ["Green", "#16a34a"], ["Blue", "#2563eb"], ["Purple", "#7c3aed"], ["Pink", "#db2777"],
] as const;
const TOOLS = [
  ["pen", "Pen"], ["eraser", "Eraser"], ["line", "Line"], ["arrow", "Arrow"], ["rect", "Rectangle"],
  ["ellipse", "Ellipse"], ["text", "Text"], ["laser", "Laser"], ["hand", "Hand"],
] as const;
type Tool = (typeof TOOLS)[number][0];
const SHAPE_TOOLS = new Set<string>(["line", "arrow", "rect", "ellipse"]);
const VIEWER_TOOLS = new Set<Tool>(["laser", "hand"]);
const MAX_LIVE_STROKES = 200;
const MAX_BUFFERED_EVENTS = 5000;
const ERASER_RADIUS_PX = 10; // on screen, converted to canvas units with the zoom

type Api = {
  undo(): void; redo(): void; clear(): void;
  zoomBy(factor: number): void; resetView(): void;
  exportPng(): void; exportSvg(): void;
  rename(name: string): void;
  commitText(x: number, y: number, text: string): void;
};
const noApi: Api = {
  undo() {}, redo() {}, clear() {}, zoomBy() {}, resetView() {}, exportPng() {}, exportSvg() {}, rename() {}, commitText() {},
};

type Props = { boardId?: string; viewId?: string; boardName: string; name: string; clientId: string; ownerKey?: string };

export default function Whiteboard(props: Props) {
  const { boardId, viewId, boardName, name, clientId, ownerKey } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cursorLayerRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<Api>(noApi);
  const initialTool: Tool = viewId ? "laser" : "pen";
  const toolRef = useRef<Tool>(initialTool);
  const colorRef = useRef<string>(COLORS[0][1]);
  const widthRef = useRef(4);
  const titleRef = useRef(boardName);

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
    let drawing: (Drawable & { id: string; kind: Kind; sent: number; dirty: boolean; pointerId: number; timer: ReturnType<typeof setInterval> }) | null = null;
    let panning: { pointerId: number; x: number; y: number; view: View } | null = null;
    let erasingPointer: number | null = null;

    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(SOCKET_URL, { transports: ["websocket"] });

    /* ----- rendering ----- */
    const viewTransform = (c: CanvasRenderingContext2D) =>
      c.setTransform(curView.zoom, 0, 0, curView.zoom, -curView.panX * curView.zoom, -curView.panY * curView.zoom);
    const paint = () => {
      raf = 0;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      ctx.drawImage(committed, 0, 0);
      viewTransform(ctx);
      for (const s of live.values()) drawStroke(ctx, s);
    };
    const schedule = () => { raf ||= requestAnimationFrame(paint); };
    const rebuild = () => {
      cctx.setTransform(1, 0, 0, 1, 0, 0);
      cctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      viewTransform(cctx); // stays set, so new strokes can be drawn straight onto the layer
      for (const s of strokes) drawStroke(cctx, s);
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

    /* ----- state changes ----- */
    const addStroke = (s: Stroke) => {
      if (strokes.some((x) => x.id === s.id)) return;
      strokes.push(s);
      drawStroke(cctx, s);
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
      syncUi();
      rebuild();
    };
    const clearAll = () => {
      strokes.length = 0;
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
        live.set(key, { kind: p.data.kind, color: p.data.color, width: p.data.width, points: [...p.data.points] }); // shapes: replace
      } else if (cur) {
        if (cur.points.length < MAX_POINTS_PER_STROKE) cur.points.push(...p.data.points.slice(1));
      } else {
        if (live.size >= MAX_LIVE_STROKES) {
          const oldest = live.keys().next().value!;
          live.delete(oldest);
          liveSeen.delete(oldest);
        }
        live.set(key, { kind: "pen", color: p.data.color, width: p.data.width, points: [...p.data.points] });
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
      let l = lasers.get(p.data.id);
      if (!l) {
        l = { el: makeMarker(p.data.id, p.data.name, "laser"), x: 0, y: 0, timer: setTimeout(() => {}, 0) };
        lasers.set(p.data.id, l);
      }
      l.x = p.data.x;
      l.y = p.data.y;
      place(l.el, l.x, l.y);
      clearTimeout(l.timer);
      const el = l.el;
      l.timer = setTimeout(() => { el.style.display = "none"; }, 1500); // the laser fades when it stops moving
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
      if (!joined) return; // stays in `pending`, re-sent after the next join
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
      drawStroke(cctx, s);
      if (again) hist.restore(s.id);
      else hist.recordDraw(s.id);
      syncUi();
      pending.set(s.id, s);
      sendCommit(s);
      schedule();
    };
    /** Removes one of our own strokes on the server, then locally. Used by undo and by the eraser. */
    const removeOwn = (stroke: Stroke, optimistic: boolean) => {
      if (optimistic) {
        erasing.add(stroke.id);
        removeStroke(stroke.id);
      }
      socket.timeout(5000).emit("stroke:undo", { id: stroke.id }, (err, res) => {
        erasing.delete(stroke.id);
        if (disposed) return;
        if (!err && (res.ok || res.error === "forbidden")) {
          if (!optimistic) removeStroke(stroke.id);
          if (res.ok) { hist.pushRedo(stroke); syncUi(); }
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

    apiRef.current = {
      undo() {
        const id = hist.top();
        if (!joined || myRole === "viewer" || !id) return;
        if (pending.has(id)) {
          undoWhenSaved = id; // the server does not know this stroke yet, undo as soon as it is saved
          return;
        }
        const stroke = strokes.find((s) => s.id === id);
        if (!stroke || erasing.has(id)) return;
        erasing.add(id);
        removeOwn(stroke, false);
      },
      redo() {
        if (!joined || myRole === "viewer") return;
        const s = hist.popRedo();
        if (!s) return;
        commitLocal({ id: s.id, kind: s.kind, color: s.color, width: s.width, points: s.points, ...(s.text ? { text: s.text } : {}) }, true);
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
        for (const s of strokes) drawStroke(g, s);
        out.toBlob((blob) => blob && download(blob, safeFileName(titleRef.current, "png")), "image/png");
      },
      exportSvg() {
        download(new Blob([strokesToSvg(strokes)], { type: "image/svg+xml" }), safeFileName(titleRef.current, "svg"));
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
        const clean = text.replace(/\p{Cc}/gu, "").trim().slice(0, MAX_TEXT_LENGTH);
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
        ? { viewId, clientId, name }
        : { boardId, clientId, name, ...(ownerKey ? { ownerKey } : {}) };
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
        if (!ack.ok) return setStatus(ack.error === "not_found" ? "Board not found" : "Could not join the board");
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
        syncUi();
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
      const radius = ERASER_RADIUS_PX / curView.zoom;
      for (const s of [...strokes]) {
        if (s.authorId !== clientId || pending.has(s.id) || erasing.has(s.id)) continue;
        if (strokeHit(s, p, radius)) removeOwn(s, true);
      }
    };

    const onDown = (e: PointerEvent) => {
      const t = toolRef.current;
      const wantsPan = t === "hand" || e.button === 1;
      if (!e.isPrimary && !wantsPan) return;
      if (drawing || panning || erasingPointer !== null) return;
      if (wantsPan) {
        canvas.setPointerCapture(e.pointerId);
        panning = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, view: curView };
        return;
      }
      if (!joined || myRole === "viewer" || t === "laser" || (e.pointerType === "mouse" && e.button !== 0)) return;
      if (t === "text") {
        const p = point(e);
        const rect = canvas.getBoundingClientRect();
        setTextDraft({ x: p[0], y: p[1], px: (fontSizeFor(widthRef.current) * curView.zoom * rect.width) / CANVAS_WIDTH });
        e.preventDefault();
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
      if (joined) (toolRef.current === "laser" ? sendLaser : sendCursor)(point(e));
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
      if (panning && e.pointerId === panning.pointerId) { panning = null; return; }
      if (erasingPointer === e.pointerId) { erasingPointer = null; return; }
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
      e.preventDefault(); // zoom the board instead of scrolling the page
      const rect = canvas.getBoundingClientRect();
      const [ax, ay] = toCanvasPointRaw(e.clientX, e.clientY, rect, curView);
      setView(zoomAt(curView, curView.zoom * Math.exp(-e.deltaY * 0.0015), [ax, ay]));
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("lostpointercapture", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); apiRef.current.undo(); }
      else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); apiRef.current.redo(); }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      disposed = true;
      window.removeEventListener("keydown", onKey);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("lostpointercapture", onUp);
      canvas.removeEventListener("wheel", onWheel);
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

  const copy = async (text: string, done: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(done);
    } catch {
      setNotice("Could not copy. Copy the address from the browser bar.");
    }
  };
  const readOnly = role === "viewer";
  const tools = TOOLS.filter(([id]) => !readOnly || VIEWER_TOOLS.has(id));
  const cursorClass = tool === "hand" ? "cursor-grab" : tool === "eraser" ? "cursor-cell" : tool === "text" ? "cursor-text" : "cursor-crosshair";
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
          {boardId && <button onClick={() => copy(`${window.location.origin}/board/${boardId}`, "Edit link copied.")} className={btn}>Copy link</button>}
          {shareViewId && <button onClick={() => copy(`${window.location.origin}/view/${shareViewId}`, "View-only link copied.")} className={btn}>Copy view-only link</button>}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3 rounded border border-slate-200 bg-white p-2">
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
                  className={`h-7 w-7 rounded-full border-2 ${color === hex ? "border-slate-900 ring-2 ring-slate-400" : "border-white"}`}
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
              if (e.key === "Enter") { apiRef.current.commitText(textDraft.x, textDraft.y, e.currentTarget.value); setTextDraft(null); }
              else if (e.key === "Escape") setTextDraft(null);
            }}
            onBlur={() => setTextDraft(null)}
          />
        )}
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
        <span role="status" aria-live="polite" className="ml-auto text-slate-700">{notice}</span>
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
