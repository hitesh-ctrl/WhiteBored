# Final report

## What was built
A real-time collaborative whiteboard. People open a board link, pick a name and draw on a shared 1600x900 canvas. Lines grow live in the other windows, named cursors are shown, each person can undo their own strokes (newest first, button or Ctrl/Cmd+Z), and the board can be cleared after a confirmation. Strokes are stored as points in Postgres, so a refresh, a late joiner or a server restart shows the full board.

- Web app: Next.js 16 (App Router), React 19, Tailwind 4. Home page with a create-board server action, board page that returns 404 for unknown or malformed ids.
- Socket server: separate Node 22 process, Socket.IO 4.8, every client message validated with zod 4, rate limited per socket, one configured CORS origin, graceful shutdown.
- Data: Prisma 7 and Postgres 16 (append-only stroke rows, per-board caps of 5000 strokes and 500,000 points).
- Pinned exact versions, `prisma` and `@prisma/client` both 7.10.1.

Design and test approach: `docs/DESIGN.md`, `docs/TEST_PLAN.md`. Product notes: `docs/UNDERSTANDING.md`.

## How to run
See `README.md`. In short: `npm ci`, copy `.env.example` to `.env` and set the database URLs, `npm run db:deploy`, then `npm run server` and `npm run dev`.

## What was tested (all measured in the final clean run)
Clean install (`node_modules` removed, `npm ci`) followed by:
| Check | Result |
|---|---|
| Unit and server integration tests (vitest, real sockets, real Postgres) | 75 of 75 passed (4 files) |
| TypeScript check | no errors |
| ESLint including the security plugin | 0 errors, 5 reviewed warnings |
| `next build` | succeeded |
| Browser end-to-end (two Chromium windows, Playwright) | 15 of 15 passed |
| Hostile-input probes against a running server | 8 of 8 passed |
| XSS proof in a real browser | 7 of 7 passed |
| Mutation check (rules broken on purpose, server tests must fail) | 16 of 16 caught |

End-to-end checks cover: create board, 404 on bad ids, security headers present, two users joining, live progress visible before the stroke ends, committed stroke visible, identical picture on a 1280x800 and a 900x700 window, named cursor with percentage position, refresh persistence, late joiner, undo of own stroke only, undo after a same-tab refresh, clear with confirmation, kill and restart of the socket server with reconnect and intact history, and no uncaught page errors or CSP violations.

Probes cover: 150 malformed messages (none accepted), a 560 KB message (connection closed, nothing stored), a 25,000-message flood from one socket (peer saw 84 progress and 6 cursor events, other clients kept getting acknowledgements), unknown board, SQL-style strings, undo of another user's and another board's stroke, spoofed author and board, CORS from a wrong origin (HTTP and WebSocket).

An independent code review produced 18 findings. All medium and high ones were fixed (rate limiting, ghost user on disconnect during join, relay ordering, undo and clear races, missing security headers, abandoned live strokes). Details in the findings table of the build log.

### Measured numbers (loopback, one machine, one server process, local Postgres, Node 22.16; server cost only, not internet latency)
Final run, samples paced under the per-socket rate limits:
| Metric | samples | p50 | p95 | max |
|---|---|---|---|---|
| Progress relay, sender to receiver | 1000 | 0.94 ms | 1.887 ms | 9.998 ms |
| Commit acknowledgement round trip (includes the database write) | 300 | 6.879 ms | 10.065 ms | 23.842 ms |
| Commit relay, sender to receiver | 300 | 6.772 ms | 9.934 ms | 23.792 ms |

An earlier run, made before rate limiting and per-board ordering were added and with samples sent back to back (2000 each), gave p50 0.064 / 0.606 / 0.598 ms and max 4.192 / 5.447 / 5.432 ms. The difference was not isolated: it mixes the pacing (idle gaps between samples) with the added ordering queue and limiter. The final table is the one that describes the shipped code.

## What was NOT tested
- Real deployment (hosting, TLS, reverse proxy, HSTS, production environment variables). Next.js and the socket server were only run locally on localhost.
- Browsers other than headless Chromium. No Firefox or Safari.
- Phones, touch screens and pens. Pointer handling for touch and pen exists in code but was only exercised with a mouse.
- Real-network latency, packet loss and slow connections. Only loopback was measured.
- Multi-server scaling. Presence and relay ordering are per process; more than one socket server would need a shared adapter (not built).
- Load with many users or many boards. Tests used a handful of clients.
- Visual design, accessibility with screen readers and keyboard-only drawing (drawing needs a pointer).
- The client fixes for stale live strokes, undo bound to a stroke id, and re-join after a racing clear have no dedicated automated tests; they are covered by code review and the unchanged end-to-end suite.
- No container image was built.

## Open findings
- SEC-04 (low): the content security policy allows inline scripts, which Next.js needs for hydration without a nonce setup.
- SEC-05 (medium): no cap on concurrent connections per client address; each socket is limited, but one client can open many sockets. Belongs at a reverse proxy or needs per-address accounting.
- SEC-06 (low): board creation is not rate limited.
- SEC-08 (info): no HSTS or TLS in this repository.
- Accepted, with reasons in the log: 8 moderate `npm audit` advisories in the lint toolchain (production dependencies report 0), the whole history being sent in the join acknowledgement (bounded by the board caps), no authentication by design.
