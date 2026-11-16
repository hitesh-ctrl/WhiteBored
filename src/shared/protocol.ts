import { z } from "zod";
import {
  CANVAS_HEIGHT, CANVAS_WIDTH, MAX_NAME_LENGTH, MAX_POINTS_PER_BATCH, MAX_POINTS_PER_STROKE,
  MAX_TEXT_LENGTH, MAX_WIDTH, MIN_WIDTH,
} from "./limits";

/* ---------- field schemas ---------- */

export const idSchema = z.uuid();
export const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_NAME_LENGTH)
  .refine((s) => !/\p{Cc}/u.test(s), "control characters are not allowed");
export const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const widthSchema = z.number().int().min(MIN_WIDTH).max(MAX_WIDTH);
const coord = (max: number) => z.number().min(0).max(max);
export const pointSchema = z.tuple([coord(CANVAS_WIDTH), coord(CANVAS_HEIGHT)]);

export const KINDS = ["pen", "line", "arrow", "rect", "ellipse", "text"] as const;
export const kindSchema = z.enum(KINDS);
export type Kind = (typeof KINDS)[number];
export const textSchema = z
  .string()
  .min(1)
  .max(MAX_TEXT_LENGTH)
  .refine((s) => !/\p{Cc}/u.test(s), "control characters are not allowed");

const strokeBase = { id: idSchema, color: colorSchema, width: widthSchema, kind: kindSchema.default("pen") };

type Shaped = { kind: Kind; points: unknown[]; text?: string };
/** pen: free points; line, arrow, rect, ellipse: exactly 2 points; text: 1 point plus its content. */
const committedShapeOk = (v: Shaped) => {
  switch (v.kind) {
    case "pen": return v.text === undefined;
    case "text": return v.points.length === 1 && v.text !== undefined;
    default: return v.points.length === 2 && v.text === undefined;
  }
};
/** Live progress: shapes send their current 1 or 2 points, text is never sent as progress. */
const progressShapeOk = (v: Shaped) => {
  if (v.text !== undefined || v.kind === "text") return false;
  return v.kind === "pen" ? true : v.points.length <= 2;
};

const commitBase = z.object({
  ...strokeBase,
  points: z.array(pointSchema).min(1).max(MAX_POINTS_PER_STROKE),
  text: textSchema.optional(),
});
const progressBase = z.object({
  ...strokeBase,
  points: z.array(pointSchema).min(1).max(MAX_POINTS_PER_BATCH),
  text: textSchema.optional(),
});

/** A finished stroke as sent by the browser. */
export const commitSchema = commitBase.refine(committedShapeOk, "points or text do not fit the kind");
/** A batch of points of a stroke that is still being drawn. */
export const progressSchema = progressBase.refine(progressShapeOk, "not valid progress for this kind");

export const joinSchema = z
  .object({
    boardId: idSchema.optional(),
    viewId: idSchema.optional(),
    clientId: idSchema,
    name: nameSchema,
    ownerKey: z.string().min(16).max(128).optional(),
  })
  .refine((v) => (v.boardId === undefined) !== (v.viewId === undefined), "give exactly one of boardId and viewId");
export const renameSchema = z.object({ name: nameSchema });
export const undoSchema = z.object({ id: idSchema });
export const cursorSchema = z.object({ x: coord(CANVAS_WIDTH), y: coord(CANVAS_HEIGHT) });

/* ---------- server to client payloads ---------- */

export const authoredStrokeSchema = commitBase.extend({ authorId: idSchema }).refine(committedShapeOk);
export const authoredProgressSchema = progressBase.extend({ authorId: idSchema }).refine(progressShapeOk);
export const renamedSchema = z.object({ name: z.string() });
export const userSchema = z.object({ id: idSchema, name: z.string() });
export const removeSchema = z.object({ id: idSchema });
export const userLeftSchema = z.object({ id: idSchema });
export const remoteCursorSchema = cursorSchema.extend({ id: idSchema, name: z.string() });

/* ---------- types ---------- */

export type Point = z.infer<typeof pointSchema>;
export type StrokeInput = z.infer<typeof commitSchema>;
export type ProgressInput = z.infer<typeof progressSchema>;
export type Stroke = z.infer<typeof authoredStrokeSchema>;
export type ProgressMessage = z.infer<typeof authoredProgressSchema>;
export type User = z.infer<typeof userSchema>;
export type JoinInput = z.input<typeof joinSchema>;
export type RemoteCursor = z.infer<typeof remoteCursorSchema>;

export type ErrorCode =
  | "invalid" | "not_found" | "not_joined" | "already_joined"
  | "board_full" | "forbidden" | "rate_limited" | "internal";

export type Ack = { ok: true } | { ok: false; error: ErrorCode };
export type Role = "owner" | "editor" | "viewer";
export type JoinAck =
  | {
      ok: true;
      strokes: Stroke[];
      users: User[];
      role: Role;
      canClear: boolean;
      boardName: string;
      /** The view-only id, given to editors and owners so they can share it. Never sent to viewers. */
      viewId?: string;
    }
  | { ok: false; error: ErrorCode };

/** Events the browser sends. */
export interface ClientToServerEvents {
  "board:join": (p: JoinInput, ack: (r: JoinAck) => void) => void;
  "stroke:progress": (p: ProgressInput) => void;
  "stroke:commit": (p: StrokeInput, ack: (r: Ack) => void) => void;
  "stroke:undo": (p: { id: string }, ack: (r: Ack) => void) => void;
  "board:clear": (ack: (r: Ack) => void) => void;
  "cursor:move": (p: { x: number; y: number }) => void;
  "laser:move": (p: { x: number; y: number }) => void;
  "board:rename": (p: { name: string }, ack: (r: Ack) => void) => void;
}

/** Events the server sends. */
export interface ServerToClientEvents {
  "stroke:progress": (p: ProgressMessage) => void;
  "stroke:commit": (p: Stroke) => void;
  "stroke:remove": (p: { id: string }) => void;
  "board:cleared": () => void;
  "user:joined": (p: User) => void;
  "user:left": (p: { id: string }) => void;
  "cursor:move": (p: RemoteCursor) => void;
  "laser:move": (p: RemoteCursor) => void;
  "board:renamed": (p: { name: string }) => void;
}

/** What the server remembers about a connection after a successful join. */
export interface SocketData {
  boardId?: string;
  clientId?: string;
  name?: string;
  role?: Role;
  canClear?: boolean;
  joining?: boolean;
}

export const roomOf = (boardId: string) => `board:${boardId}`;
