import { z } from "zod";
import {
  CANVAS_HEIGHT, CANVAS_WIDTH, MAX_NAME_LENGTH, MAX_POINTS_PER_BATCH, MAX_POINTS_PER_STROKE,
  MAX_WIDTH, MIN_WIDTH,
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

const strokeBase = { id: idSchema, color: colorSchema, width: widthSchema };

/** A finished stroke as sent by the browser. */
export const commitSchema = z.object({
  ...strokeBase,
  points: z.array(pointSchema).min(1).max(MAX_POINTS_PER_STROKE),
});
/** A batch of new points of a stroke that is still being drawn. */
export const progressSchema = z.object({
  ...strokeBase,
  points: z.array(pointSchema).min(1).max(MAX_POINTS_PER_BATCH),
});

export const joinSchema = z.object({ boardId: idSchema, clientId: idSchema, name: nameSchema });
export const undoSchema = z.object({ id: idSchema });
export const cursorSchema = z.object({ x: coord(CANVAS_WIDTH), y: coord(CANVAS_HEIGHT) });

/* ---------- server to client payloads ---------- */

export const authoredStrokeSchema = commitSchema.extend({ authorId: idSchema });
export const authoredProgressSchema = progressSchema.extend({ authorId: idSchema });
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
export type JoinInput = z.infer<typeof joinSchema>;
export type RemoteCursor = z.infer<typeof remoteCursorSchema>;

export type ErrorCode =
  | "invalid" | "not_found" | "not_joined" | "already_joined"
  | "board_full" | "forbidden" | "rate_limited" | "internal";

export type Ack = { ok: true } | { ok: false; error: ErrorCode };
export type JoinAck =
  | { ok: true; strokes: Stroke[]; users: User[] }
  | { ok: false; error: ErrorCode };

/** Events the browser sends. */
export interface ClientToServerEvents {
  "board:join": (p: JoinInput, ack: (r: JoinAck) => void) => void;
  "stroke:progress": (p: ProgressInput) => void;
  "stroke:commit": (p: StrokeInput, ack: (r: Ack) => void) => void;
  "stroke:undo": (p: { id: string }, ack: (r: Ack) => void) => void;
  "board:clear": (ack: (r: Ack) => void) => void;
  "cursor:move": (p: { x: number; y: number }) => void;
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
}

/** What the server remembers about a connection after a successful join. */
export interface SocketData {
  boardId?: string;
  clientId?: string;
  name?: string;
  joining?: boolean;
}

export const roomOf = (boardId: string) => `board:${boardId}`;
