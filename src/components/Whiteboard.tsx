"use client";

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { z } from "zod";
import { nextBatch, ownStrokeIds, shouldAddPoint, toCanvasPoint } from "../lib/drawing";
import { newId } from "../lib/ids";
import { throttle } from "../lib/throttle";
import { CANVAS_HEIGHT, CANVAS_WIDTH, MAX_POINTS_PER_STROKE } from "../shared/limits";
import {
  authoredProgressSchema, authoredStrokeSchema, remoteCursorSchema, removeSchema, userLeftSchema,
  userSchema,
  type ClientToServerEvents, type Point, type ServerToClientEvents, type Stroke, type StrokeInput,
  type User,
} from "../shared/protocol";

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL ?? "http://localhost:4000";
const COLORS = [
  ["Black", "#111827"], ["Red", "#dc2626"], ["Orange", "#ea580c"], ["Yellow", "#ca8a04"],
  ["Green", "#16a34a"], ["Blue", "#2563eb"], ["Purple", "#7c3aed"], ["Pink", "#db2777"],
] as const;
const MAX_LIVE_STROKES = 200;

type Drawable = { color: string; width: number; points: Point[] };
type Api = { undo(): void; clear(): void };

function drawStroke(ctx: CanvasRenderingContext2D, s: Drawable) {
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = s.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const [first, ...rest] = s.points;
  if (!first) return;
  if (rest.length === 0) {
    ctx.beginPath();
    ctx.arc(first[0], first[1], s.width / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(first[0], first[1]);
  for (const p of rest) ctx.lineTo(p[0], p[1]);
  ctx.stroke();
}

export default function Whiteboard(props: { boardId: string; boardName: string; name: string; clientId: string }) {
  const { boardId, boardName, name, clientId } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cursorLayerRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<Api>({ undo() {}, clear() {} });
  const colorRef = useRef<string>(COLORS[0][1]);
  const widthRef = useRef(4);

  // Only text that appears in the UI lives in React state.
  const [status, setStatus] = useState("Connecting...");
  const [notice, setNotice] = useState("");
  const [users, setUsers] = useState<User[]>([]);
  const [color, setColor] = useState<string>(COLORS[0][1]);
  const [width, setWidth] = useState(4);
  const [undoCount, setUndoCount] = useState(0);

  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { widthRef.current = width; }, [width]);
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
    const pending = new Map<string, StrokeInput>(); // committed locally, not yet acknowledged
    const cursors = new Map<string, HTMLDivElement>();
    let undoStack: string[] = [];
    let joined = false;
    let undoWhenSaved = false; // undo was pressed while the newest stroke was still unacknowledged
    let buffer: (() => void)[] = [];
    let raf = 0;
    let drawing: (Drawable & { id: string; sent: number; pointerId: number; timer: ReturnType<typeof setInterval> }) | null = null;

    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(SOCKET_URL, { transports: ["websocket"] });

    /* ----- rendering ----- */
    const paint = () => {
      raf = 0;
      ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      ctx.drawImage(committed, 0, 0);
      for (const s of live.values()) drawStroke(ctx, s);
    };
    const schedule = () => { raf ||= requestAnimationFrame(paint); };
    const rebuild = () => {
      cctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      for (const s of strokes) drawStroke(cctx, s);
      schedule();
    };

    /* ----- state changes ----- */
    const addStroke = (s: Stroke) => {
      if (strokes.some((x) => x.id === s.id)) return;
      strokes.push(s);
      drawStroke(cctx, s);
      live.delete(`${s.authorId}:${s.id}`);
      schedule();
    };
    const removeStroke = (id: string) => {
      const i = strokes.findIndex((s) => s.id === id);
      if (i >= 0) strokes.splice(i, 1);
      pending.delete(id);
      undoStack = undoStack.filter((x) => x !== id);
      setUndoCount(undoStack.length);
      rebuild();
    };
    const clearAll = () => {
      strokes.length = 0;
      pending.clear();
      undoStack = [];
      setUndoCount(0);
      for (const k of [...live.keys()]) if (!k.startsWith(`${clientId}:`)) live.delete(k);
      rebuild();
    };
    const removeCursor = (id: string) => {
      cursors.get(id)?.remove();
      cursors.delete(id);
    };
    const gate = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => {
      if (joined) fn(...a);
      else buffer.push(() => fn(...a)); // arrived before the join ack; replay in order after it
    };

    /* ----- server events ----- */
    socket.on("stroke:progress", gate((raw) => {
      const p = authoredProgressSchema.safeParse(raw);
      if (!p.success) return;
      const key = `${p.data.authorId}:${p.data.id}`;
      const cur = live.get(key);
      if (cur) {
        if (cur.points.length < MAX_POINTS_PER_STROKE) cur.points.push(...p.data.points.slice(1));
      } else {
        if (live.size >= MAX_LIVE_STROKES) live.delete(live.keys().next().value!);
        live.set(key, { color: p.data.color, width: p.data.width, points: [...p.data.points] });
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
    socket.on("user:joined", gate((raw) => {
      const p = userSchema.safeParse(raw);
      if (p.success) setUsers((u) => [...u.filter((x) => x.id !== p.data.id), p.data]);
    }));
    socket.on("user:left", gate((raw) => {
      const p = userLeftSchema.safeParse(raw);
      if (!p.success) return;
      setUsers((u) => u.filter((x) => x.id !== p.data.id));
      removeCursor(p.data.id);
      for (const k of [...live.keys()]) if (k.startsWith(`${p.data.id}:`)) live.delete(k);
      schedule();
    }));
    socket.on("cursor:move", (raw) => {
      if (!joined) return;
      const p = remoteCursorSchema.safeParse(raw);
      if (!p.success) return;
      let el = cursors.get(p.data.id);
      if (!el) {
        el = document.createElement("div");
        el.className = "pointer-events-none absolute z-10 -translate-x-1 -translate-y-1";
        const dot = document.createElement("span");
        dot.className = "block h-2.5 w-2.5 rounded-full bg-slate-900";
        const label = document.createElement("span");
        label.className = "ml-2 whitespace-nowrap rounded bg-slate-900 px-1.5 py-0.5 text-xs text-white";
        label.textContent = p.data.name; // text node, never HTML
        el.append(dot, label);
        el.style.display = "flex";
        layer.append(el);
        cursors.set(p.data.id, el);
      }
      el.style.left = `${(p.data.x / CANVAS_WIDTH) * 100}%`;
      el.style.top = `${(p.data.y / CANVAS_HEIGHT) * 100}%`;
    });

    /* ----- commit, undo, clear ----- */
    const sendCommit = (s: StrokeInput, attempt = 0) => {
      if (!joined) return; // stays in `pending`, re-sent after the next join
      socket.timeout(5000).emit("stroke:commit", s, (err, res) => {
        if (err) {
          if (attempt < 2) sendCommit(s, attempt + 1);
          return;
        }
        if (res.ok) {
          pending.delete(s.id);
          if (undoWhenSaved) {
            undoWhenSaved = false;
            apiRef.current.undo();
          }
          return;
        }
        if (res.error === "not_joined" || res.error === "rate_limited") return;
        removeStroke(s.id);
        setNotice(res.error === "board_full" ? "The board is full, the last stroke was removed." : "The last stroke could not be saved.");
      });
    };

    apiRef.current = {
      undo() {
        const id = undoStack[undoStack.length - 1];
        if (!joined || !id) return;
        if (pending.has(id)) {
          undoWhenSaved = true; // the server does not know this stroke yet, undo as soon as it is saved
          return;
        }
        undoStack.pop();
        setUndoCount(undoStack.length);
        socket.timeout(5000).emit("stroke:undo", { id }, (err, res) => {
          if (!err && (res.ok || res.error === "forbidden")) return removeStroke(id);
          undoStack.push(id);
          setUndoCount(undoStack.length);
        });
      },
      clear() {
        if (!joined || !window.confirm("Clear the whole board for everyone?")) return;
        socket.timeout(5000).emit("board:clear", (err, res) => {
          if (!err && res.ok) clearAll();
        });
      },
    };

    /* ----- connection ----- */
    socket.on("connect", () => {
      joined = false;
      buffer = [];
      setStatus("Joining...");
      socket.timeout(10000).emit("board:join", { boardId, clientId, name }, (err, ack) => {
        if (err) return setStatus("Could not join the board");
        if (!ack.ok) return setStatus(ack.error === "not_found" ? "Board not found" : "Could not join the board");
        const parsed = z.array(authoredStrokeSchema).safeParse(ack.strokes);
        strokes.length = 0;
        if (parsed.success) strokes.push(...parsed.data);
        live.clear();
        for (const id of [...cursors.keys()]) removeCursor(id);
        undoStack = ownStrokeIds(strokes, clientId);
        for (const id of pending.keys()) if (!strokes.some((s) => s.id === id)) undoStack.push(id);
        setUndoCount(undoStack.length);
        setUsers(ack.users);
        for (const s of pending.values()) if (!strokes.some((x) => x.id === s.id)) strokes.push({ ...s, authorId: clientId });
        rebuild();
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

    /* ----- drawing ----- */
    const point = (e: PointerEvent): Point => toCanvasPoint(e.clientX, e.clientY, canvas.getBoundingClientRect());
    const sendCursor = throttle((p: Point) => socket.volatile.emit("cursor:move", { x: p[0], y: p[1] }), 33);

    const flush = () => {
      if (!drawing) return;
      const b = nextBatch(drawing.points, drawing.sent);
      if (!b) return;
      drawing.sent = b.sent;
      if (joined) socket.emit("stroke:progress", { id: drawing.id, color: drawing.color, width: drawing.width, points: b.batch });
    };
    const finish = () => {
      if (!drawing) return;
      const d = drawing;
      drawing = null;
      clearInterval(d.timer);
      drawing = d;
      flush();
      drawing = null;
      live.delete(`${clientId}:${d.id}`);
      const s: StrokeInput = { id: d.id, color: d.color, width: d.width, points: d.points };
      strokes.push({ ...s, authorId: clientId });
      drawStroke(cctx, s);
      undoStack.push(s.id);
      setUndoCount(undoStack.length);
      pending.set(s.id, s);
      sendCommit(s);
      schedule();
    };

    const onDown = (e: PointerEvent) => {
      if (drawing || !joined || (e.pointerType === "mouse" && e.button !== 0)) return;
      canvas.setPointerCapture(e.pointerId);
      const d = {
        id: newId(), color: colorRef.current, width: widthRef.current, points: [point(e)] as Point[],
        sent: 0, pointerId: e.pointerId, timer: setInterval(flush, 50),
      };
      drawing = d;
      live.set(`${clientId}:${d.id}`, d);
      flush();
      schedule();
    };
    const onMove = (e: PointerEvent) => {
      if (joined) sendCursor(point(e));
      if (!drawing || e.pointerId !== drawing.pointerId) return;
      const events = e.getCoalescedEvents?.() ?? [e];
      for (const ev of events.length ? events : [e]) {
        const p = point(ev);
        if (drawing.points.length < MAX_POINTS_PER_STROKE && shouldAddPoint(drawing.points[drawing.points.length - 1], p)) {
          drawing.points.push(p);
        }
      }
      schedule();
    };
    const onUp = (e: PointerEvent) => {
      if (drawing && e.pointerId === drawing.pointerId) finish();
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);

    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" && (t as HTMLInputElement).type === "text" || t.tagName === "TEXTAREA")) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        apiRef.current.undo();
      }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      window.removeEventListener("keydown", onKey);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      if (drawing) clearInterval(drawing.timer);
      sendCursor.cancel();
      if (raf) cancelAnimationFrame(raf);
      socket.removeAllListeners();
      socket.disconnect();
      apiRef.current = { undo() {}, clear() {} };
      cursors.clear();
      layer.replaceChildren();
    };
  }, [boardId, clientId, name]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setNotice("Link copied.");
    } catch {
      setNotice("Could not copy. Copy the address from the browser bar.");
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-3 p-3 sm:p-4">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="text-xl font-semibold">{boardName}</h1>
        <span role="status" className="text-sm text-slate-600">{status}</span>
        <button onClick={copyLink} className="ml-auto rounded border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-100">
          Copy link
        </button>
      </header>

      <div className="flex flex-wrap items-center gap-3 rounded border border-slate-200 bg-white p-2">
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
        <button onClick={() => apiRef.current.undo()} disabled={undoCount === 0} className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-40">
          Undo
        </button>
        <button onClick={() => apiRef.current.clear()} className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50">
          Clear board
        </button>
      </div>

      <div className="relative w-full overflow-hidden rounded border border-slate-300 bg-white" style={{ aspectRatio: `${CANVAS_WIDTH} / ${CANVAS_HEIGHT}` }}>
        <canvas
          ref={canvasRef} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} role="img"
          aria-label="Shared drawing canvas. Draw with a mouse, finger or pen."
          className="absolute inset-0 h-full w-full cursor-crosshair"
          style={{ touchAction: "none" }}
        />
        <div ref={cursorLayerRef} className="pointer-events-none absolute inset-0" aria-hidden="true" />
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-slate-600">On this board:</span>
        <ul className="flex flex-wrap gap-2">
          {users.map((u) => (
            <li key={u.id} className="rounded-full bg-slate-200 px-2 py-0.5">{u.name}{u.id === clientId ? " (you)" : ""}</li>
          ))}
        </ul>
        <span role="status" aria-live="polite" className="ml-auto text-slate-700">{notice}</span>
      </div>
    </main>
  );
}
