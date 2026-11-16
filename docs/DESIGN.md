# Design

## 1. Components and boundaries

```
Browser (Next.js client component, canvas, socket.io-client)
   |  HTTP (pages, server action)          |  WebSocket (socket.io)
   v                                       v
Next.js process (port 3000)           Socket server (Node 22, port 4000)
   |  Prisma (create/read board)            |  Prisma (strokes, board lookup)
   +-------------------> Postgres 16 <------+
```

- **Web (Next.js 16, App Router)**: home page with create-board form (server action, validates name, creates board, redirects to `/board/<id>`), board page (404 on unknown or malformed id, `params` is a Promise), and a client `Board` component. Sets security headers.
- **Socket server (`src/server`)**: separate Node process. `createWhiteboardServer({prisma, corsOrigin})` returns `{httpServer, io}` and does not listen. `index.ts` loads dotenv first, listens on `SOCKET_PORT`, serves `/health`, shuts down on SIGINT/SIGTERM.
- **Shared (`src/shared`)**: zod schemas and the event type maps used by both sides, plus drawing constants and limits.
- **Database**: Postgres 16 via Prisma 7 with `@prisma/adapter-pg`. Both processes use it.

Single npm package, folders `src/app`, `src/components`, `src/lib`, `src/server`, `src/shared`. Rejected: npm workspaces monorepo, because it adds build and pinning overhead for no benefit at this size.

## 2. Data model

```
Board  { id uuid pk, name text, createdAt timestamptz, strokes[] }
Stroke { seq autoincrement int (unique, draw order),
         id uuid pk (made by the browser),
         boardId uuid fk -> Board.id ON DELETE CASCADE,
         authorId uuid (client's per-tab id),
         color text "#rrggbb", width int 1..40,
         points Json [[x,y],...],
         pointCount int,
         createdAt timestamptz }
index (boardId, seq)
```

Strokes are append-only rows, deleted only by undo or clear. Presence and cursors are never stored.

Changes from the baseline:
- **Added `pointCount`.** Why: with only the baseline caps (5000 strokes x 5000 points) one board can reach about 350 MB of history, which is sent in the join ack. A per-board point budget needs a cheap sum. Rejected: `jsonb_array_length` sums on every commit (slow), no budget (memory DoS).
- **Primary key is `id` and `seq` is a separate unique autoincrement column.** Baseline had both; stated explicitly so `createMany` conflicts on `id` only.

## 3. Limits

| Limit | Value | Enforced where |
|---|---|---|
| Canvas | 1600 x 900 logical units, x in [0,1600], y in [0,900], finite | zod |
| Points per stroke (commit) | 1..5000 | zod |
| Points per progress batch | 1..200 | zod |
| Strokes per board | 5000 | server, inside transaction |
| Points per board (added) | 500,000 total | server, inside transaction |
| Width | integer 1..40 | zod |
| Colour | `^#[0-9a-fA-F]{6}$` | zod |
| Name (user and board) | trimmed, 1..30 chars, no control characters | zod |
| Ids | uuid | zod |
| Socket message size | `maxHttpBufferSize` 256 KB (a full 5000 point stroke is about 70 KB) | Socket.IO |
| Rate per socket (token bucket) | progress 40/s burst 80; commit 5/s burst 20; undo and clear 5/s burst 10; cursor 60/s burst 30 | server |
| Join | one successful join per connection | server |

Over-rate progress and cursor events are dropped silently. Over-rate commit, undo and clear get `{ok:false,error:"rate_limited"}`.

## 4. Socket protocol

All client payloads are parsed with zod on the server. Server to client payloads are typed (and the browser also parses them with zod before using them, so a bad relay cannot crash rendering). Types: `ClientToServerEvents`, `ServerToClientEvents` in `src/shared/protocol.ts`. Note the generic order: server is `Server<ClientToServer, ServerToClient>`, client is `Socket<ServerToClient, ClientToServer>`.

Shared shapes: `Point = [number, number]`, `StrokeInput = {id, color, width, points}`, `Stroke = StrokeInput & {authorId}`, `User = {id, name}`.

Ack result: `{ok:true, ...} | {ok:false, error: ErrorCode}`, `ErrorCode = "invalid" | "not_found" | "not_joined" | "already_joined" | "board_full" | "forbidden" | "rate_limited" | "internal"`.

### Client to server

| Event | Payload | Ack | Notes |
|---|---|---|---|
| `board:join` | `{boardId uuid, clientId uuid, name}` | `{ok:true, strokes: Stroke[], users: User[]} \| {ok:false,error}` | Errors: invalid, not_found, already_joined |
| `stroke:progress` | `StrokeInput` (points 1..200) | none | Dropped silently if not joined, invalid or limited |
| `stroke:commit` | `StrokeInput` (points 1..5000) | `{ok:true} \| {ok:false,error}` | |
| `stroke:undo` | `{id uuid}` | `{ok:true} \| {ok:false,error}` | error `forbidden` if nothing was deleted |
| `board:clear` | none (validated as undefined) | `{ok:true} \| {ok:false,error}` | |
| `cursor:move` | `{x, y}` in canvas range | none, volatile | |

### Server to client

| Event | Payload | Sent to |
|---|---|---|
| `stroke:progress` | `StrokeInput & {authorId}` | room except sender |
| `stroke:commit` | `StrokeInput & {authorId}` | room except sender |
| `stroke:remove` | `{id}` | room except sender |
| `board:cleared` | none | room except sender |
| `user:joined` | `User` | room except sender, only when this is the user's first socket |
| `user:left` | `{id}` | room, when the user's last socket leaves |
| `cursor:move` | `{id, name, x, y}` | room except sender, volatile |

Identity (`clientId`, `boardId`, `name`) is stamped from `socket.data` set at join. Messages never carry authorId or boardId (except `board:join`, the one-time declaration).

### Behaviour rules
- Rooms: `board:<id>`. One connection joins one board. A second join returns `already_joined`.
- Before join, all events except `board:join` are rejected (`not_joined` ack, or dropped).
- **Join**: validate, check board, load strokes ordered by `seq`, join the room, build the users list, add to presence, relay `user:joined`, then ack. The room is joined before the history read, but live events that arrive during the read are only emitted after the socket is in the room, so they are sent as normal events; the client buffers events that arrive before the join ack and applies them after, de-duplicating by stroke id. Rejected alternative: read history first then join the room (leaves a gap).
- **Commit**: validate; transaction with a per-board advisory lock (`pg_advisory_xact_lock`) that counts strokes and points, rejects `board_full`, and inserts with `createMany` + `skipDuplicates`. Then relay and ack. Changes from the baseline:
  - **If `createMany` inserted 0 rows** (duplicate id), the server looks up the row. If it belongs to the same board and author, it is a retry: ack ok, no second relay. If it belongs to someone else or another board, ack `{ok:false,error:"forbidden"}`. Baseline would ack ok and relay a stroke that was never stored. Rejected: plain skipDuplicates with ok ack.
  - **Advisory lock around count + insert.** Without it, concurrent commits can pass the cap check together. Rejected: unlocked check (small overshoot, bounded by rate limits, but trivially avoidable).
- **Undo**: one `deleteMany` where id AND boardId AND authorId. 0 rows deleted gives `forbidden`; otherwise relay `stroke:remove` and ack. The "newest first" order is a client rule; the server allows undoing any own stroke.
- **Clear**: `deleteMany` by board, relay `board:cleared`, ack. Anyone in the board may clear (the link is the access).
- **Disconnect**: remove from presence; if the client id has no other socket, relay `user:left`. In-progress remote strokes of that author are dropped by the receiver on `user:left` unless committed.
- **Remote in-progress strokes** are keyed by `authorId:strokeId` in the browser, so one user cannot overwrite another's in-progress line by reusing an id.
- **Reconnect**: the browser re-joins on every socket `connect`. The ack replaces all local state (strokes, users, in-progress). Strokes committed locally but not acked are kept in a pending map and re-sent after the join ack (safe because commit is idempotent).
- Presence is keyed by clientId; two sockets with the same clientId (a reconnect overlap) appear as one user.

## 5. Browser design (summary)
- Canvas 1600x900 internal size, scaled by CSS. Pointer events with pointer capture and `touch-action: none`. Coordinates mapped from `getBoundingClientRect`, rounded to 1 decimal, clamped. Points closer than 1 unit to the previous one are skipped.
- Fast data (strokes, in-progress, cursors positions, pending acks) lives in refs and is drawn imperatively. React state holds only UI text: connection status, user list, selected colour and width.
- Cursors are absolutely positioned DOM elements at percentage positions, names rendered as text nodes.
- Own undo stack is rebuilt from history (strokes whose `authorId` equals the tab's client id), so a refresh in the same tab keeps undo.
- Name in `localStorage`, client id in `sessionStorage`, both read inside try/catch.
- Progress batching about 50 ms, cursor throttle about 33 ms; both helpers are pure and unit tested.

## 6. Failure modes

| Case | Behaviour |
|---|---|
| Disconnect | Socket.IO reconnects; join re-run; state replaced; pending commits re-sent |
| Duplicate commit | Idempotent; same owner gets ok, other owner gets forbidden |
| Bad input | Parse fails, `invalid` ack or silent drop for no-ack events; server never throws on input |
| Unknown or malformed board id | Join: `not_found` or `invalid`; web page: 404 |
| Board full | `board_full` ack; browser rolls the stroke back and shows a message |
| Database error | `internal` ack, error logged without payload; process stays up |
| Flood | Token bucket drops or rejects; message size capped |
| Server restart | Clients reconnect and re-join; history comes from the database |
| Cross-origin web page | CORS and Origin: exactly one configured origin |

## 7. Security decisions
- One CORS origin from env (`CORS_ORIGIN`), startup fails in production if it is `*` or missing.
- Next.js security headers: CSP, `X-Content-Type-Options`, frame options, referrer policy.
- No secrets in the repo; `.env` ignored, `.env.example` committed.

## 8. Out of scope
Authentication and per-board permissions, board deletion, multi-server scaling (presence is per process; a Redis adapter would be needed), history pagination or snapshots, redo, eraser and shapes, board expiry, accessibility beyond basics (labels, focus, no keyboard drawing), and offline drawing.

## 9. Revisions after review
- Rate limits (section 3) are implemented as per-socket token buckets in `src/server/rateLimit.ts`; `join` is limited to 2/s with a burst of 5.
- Within one server process, commit, undo and clear for a board run through a per-board queue, so relays follow database order. The advisory lock still orders writers across processes. Ordering across processes is not guaranteed (out of scope).
- A client that disconnects while its join is being processed is not registered in presence.
- Browser: undo requested for a not-yet-saved stroke is bound to that stroke id; a clear that races an unsaved stroke makes the browser re-join; remote live strokes that stop growing for 15 s are dropped; a failed join is retried after 2 s.
- Presence name is updated when the same client id joins again.
- Security headers are set in `next.config.ts`.
