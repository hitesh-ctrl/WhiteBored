# Understanding

## What it does
A real-time collaborative whiteboard. Anyone creates a board from the home page and gets a link. Anyone with the link picks a name and draws on a shared canvas. Everyone sees lines grow while they are drawn, sees named cursors, and can undo their own strokes. Everything drawn is stored, so a refresh or a late joiner sees the full board.

## Stroke lifecycle
1. Pointer down in the browser creates a stroke id (uuid) and starts collecting points in canvas units (1600x900).
2. While drawing, the browser draws locally and sends batches of new points (`stroke:progress`, about every 50 ms, at most 200 points, each batch starting with the last point of the previous one). The server relays them to the other sockets in the board room. Nothing is stored.
3. Pointer up sends `stroke:commit` with the full stroke. The server validates it, enforces the stroke cap, inserts it (`createMany` with `skipDuplicates`, so a retry is harmless), relays it, then acknowledges. If the ack says not ok, the browser removes the stroke.
4. Undo sends `stroke:undo {id}`. One delete scoped by id, board and author. If a row was deleted the server relays `stroke:remove`.
5. Clear deletes all strokes of the board and relays `board:cleared`.

## Persisted vs transient
- Persisted: boards, committed strokes (append-only rows, ordered by `seq`).
- Transient: progress batches, cursors, presence (who is connected), names.

## Main risks
- Gap between history load and live events on join (mitigated by sending history in the join ack after joining the room).
- Trusting client data: identity must come from the connection, every message validated.
- Duplicate or replayed commits after reconnect.
- Unbounded data: points per stroke, strokes per board, batch size, message size, message rate.
- Cross-board effects: undo or relay leaking across boards.
- Stored XSS through names (render as text only).
- Prisma 7 configuration traps and env loading order.
- Socket server is a separate process, so CORS origin and URL configuration must match.

## Open questions (assumptions taken, logged in the design)
- "The link is the access": board ids are unguessable uuids, there is no auth. Accepted for this scope.
- Author identity is a per-tab client id, so a refresh in the same tab keeps undo rights, a new tab does not. Accepted.
- Presence is per process. Multi-server scaling is out of scope.
