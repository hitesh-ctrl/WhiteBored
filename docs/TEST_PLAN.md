# Test plan

## Levels and why

| Level | Tool | What it covers | Why at this level |
|---|---|---|---|
| Unit | vitest | `toCanvasPoint`, `shouldAddPoint`, `nextBatch`, `ownStrokeIds`, `throttle`, token bucket | Pure functions with edge cases (rounding, clamping, batch overlap, timers). Fast, no I/O. |
| Server integration | vitest + real `socket.io-client` + real Postgres | Every socket event, ack and relay rule | The rules live in the interaction of socket, room and database; mocks would hide the bugs that matter (scoping, duplicates, races). Server starts on a random port through `createWhiteboardServer`. Test database is separate from the dev database. |
| End to end | Playwright, two headless Chromium windows | Drawing appears in the second window, persistence on refresh, undo, clear, cursors, reconnect after restarting the socket server | Canvas, pointer events and React wiring can only be checked in a browser. |
| Mutation checks | manual breaks of the code | The tests actually fail when a rule is removed | Proves the tests guard the rules. |
| Security probes | scripts against the running server | Malformed and oversized payloads, floods, CORS, injection strings, XSS in names | Checks behaviour under hostile input beyond the unit-sized cases. |

## Server integration cases
- **Join**: history ordered by `seq`; users in the ack; unknown board; invalid payloads (bad board id, bad client id, empty name, long name, no payload); one board per connection; join/leave announcements; SQL-looking name stays text.
- **Before join**: commit, undo, clear get `not_joined`; progress and cursors from an unjoined socket are not relayed.
- **Relay**: progress, commit, cursor reach others and never the sender; undo and clear are not echoed; room isolation across boards; smuggled `authorId`, `boardId`, `name` fields are ignored.
- **Commit**: idempotent retry (one row); retry not relayed twice; a stroke id owned by someone else is refused; points stored and counted; 14 invalid shapes rejected and nothing stored (colour, width, id, empty, out-of-range, NaN-like, 3-value point, too many points); maximum stroke accepted; invalid progress and cursor not relayed.
- **Limits**: stroke cap (5000), board point budget, retry still ok on a full board, concurrent commits cannot overshoot the cap.
- **Undo**: own stroke removed and relayed; other user's stroke refused; same author but another board refused; malformed undo.
- **Clear**: only this board; relayed.
- **Late joiner and reconnect**: late joiner sees only surviving strokes; re-join after reconnect returns missed strokes and users; two sockets with the same client id keep the user listed until the last one leaves.

## Security cases (tests)
Spoofed author and board (above), undo across users and boards, commit id collision across users, no action before join, validation of every client event, rate limiting per socket (added in the security phase with its own tests), message size limit (probe), CORS (probe), XSS name rendering (browser check).

## Not covered by automated tests
Visual look, other browsers, touch and pen hardware, real network latency, multi-server scaling. These are listed in the final report.

## Red phase
Tests are written before the implementation against a placeholder server with no handlers. Every server test must fail because a handler is missing (ack timeout) and every unit test because the helper is not implemented.
