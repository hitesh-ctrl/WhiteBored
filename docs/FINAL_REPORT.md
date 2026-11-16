# Final report

## What was built
A real-time collaborative whiteboard. People open a board link, pick a name and draw on a shared canvas. Everyone sees lines grow live, sees each other's named and coloured cursors, and can undo or redo their own strokes. Everything is saved, so a refresh, a late joiner or a server restart shows the full board.

Drawing: pen, line, arrow, rectangle, ellipse and text; an eraser that removes the person's own strokes; zoom and pan; a laser pointer; PNG and SVG export.
Sharing: the creator of a board is its owner and can clear and rename it; anyone with the board link can draw; a separate view-only link lets people watch and point without changing anything; each browser keeps a list of recent boards.
Safety: every message is validated, every socket is rate limited, a stroke can only be removed by the person who drew it (bound to a secret key kept by the browser), connections are capped per client address, and names and text are always shown as text.

Stack: Next.js 16, React 19, Tailwind 4, a separate Node 22 Socket.IO 4.8 server, Prisma 7 with Postgres 16, zod 4, vitest, Playwright. Exact versions are pinned; `prisma` and `@prisma/client` are both 7.10.1.

Design and test approach: `docs/DESIGN.md`, `docs/TEST_PLAN.md`. How to run: `README.md`.

## What was tested (measured in the final clean run: `node_modules` removed, `npm ci`)
| Check | Result |
|---|---|
| Unit and server integration tests (vitest, real sockets, real Postgres) | 209 of 209 passed (18 files) |
| TypeScript check | no errors |
| ESLint with the security plugin | 0 errors, 15 reviewed warnings |
| `next build` (without any `.env`) | succeeded |
| Browser end-to-end, original features (two Chromium windows) | 15 of 15 passed |
| Browser end-to-end, new features (two to three browser contexts) | 20 of 20 passed |
| Hostile-input probes against a running server | 12 of 12 passed |
| XSS proof in a real browser | 7 of 7 passed |
| Mutation checks (rules broken on purpose, tests must fail) | 49 of 49 caught across three rounds |
| `npm audit --omit=dev` | 0 vulnerabilities |

The browser checks cover: owner key handling (kept in the browser, only a hash stored), editor versus owner controls, eraser limited to own strokes, redo, shapes with live preview, text with markup staying text, SVG escaping and a valid PNG, zoom and pan landing on the right canvas position, laser, rename, recent boards, a view-only visitor that cannot change anything and never receives the edit id, live updates, persistence, reconnect after killing and restarting the socket server, security headers and no CSP violations.

Two independent code reviews were done by a reviewer with no knowledge of the build process (18 and 17 findings). All medium and high findings were fixed, plus the cheap low ones. The review of the second round found a real flaw: a person's client id is public, so another editor could delete their strokes; strokes are now bound to a secret key.

### Measured numbers (loopback, one machine, one server process, local Postgres, Node 22.16; server cost only, not internet latency)
Samples are paced under the per-socket rate limits (1000 progress samples at about 33 per second, 300 commit samples at 4 per second).

| Metric | samples | p50 | p95 | max |
|---|---|---|---|---|
| Progress relay, sender to receiver | 1000 | 1.866 ms | 2.2 ms | 4.063 ms |
| Commit acknowledgement round trip (includes the database write) | 300 | 7.837 ms | 9.122 ms | 16.843 ms |
| Commit relay, sender to receiver | 300 | 7.898 ms | 9.171 ms | 16.793 ms |

An earlier run of the same benchmark gave p50 0.94 / 6.879 / 6.772 ms (p95 1.887 / 10.065 / 9.934 ms, max 9.998 / 23.842 / 23.792 ms). The two runs differ by up to a factor of two for the relay; the cause (machine load, timer wake-ups after idle gaps, code changes in between) was not isolated, so treat the numbers as a rough scale, not a precise figure. A run before rate limiting existed, with samples sent back to back, was about ten times faster (p50 0.064 ms for the relay) and is not comparable.

## What was NOT tested
- **Container images and the compose stack were never built or run.** The Docker storage on the test machine went read-only when the disk filled up, and recovering it needs a restart of Docker Desktop, which was not done. What was checked instead: `docker compose config` validates, and the exact files the socket image copies were assembled in a clean directory with production-only dependencies and run with the image's start command (health, token-protected metrics, a join, commit and undo over a real socket, graceful shutdown on SIGTERM). Image layers, the non-root user, the health checks and the web image are unverified.
- **The CI workflow was never run**; it was only checked to be valid YAML.
- Real deployment (hosting, TLS, reverse proxy, forwarded headers, HSTS).
- Browsers other than headless Chromium; no Firefox or Safari (the wheel handling for Firefox line mode is untested).
- Phones, touch screens and pens (including pinch zoom, which does not exist) and input method editors.
- Real-network latency, packet loss, and load with many users or boards.
- Multi-server scaling: presence, relay order and per-address counts are per process; there is no shared adapter.
- Accessibility with screen readers and keyboard-only drawing.
- Client logic without dedicated tests (covered by code review and the browser suites): the stale live stroke expiry, the rejoin after a racing clear, join retry, commit retry guard and the per-author live stroke cap.

## Open findings
- R2-01 (medium): container images, the non-root check and the compose stack are unverified (see above).
- R2-02 (medium): the test machine's disk was completely full during this work (it has since been freed); it broke Docker and can break any build.
- SEC-04 (low): the content security policy allows inline scripts, which Next.js needs for hydration without a nonce setup.
- SEC-05 (medium): no total cap on connections across all addresses, and presence after a server restart is first come first served until a client leaves.
- SEC-06 (low): without a trusted proxy, board creation uses one shared allowance for everyone.
- SEC-08 (info): no HSTS or TLS in this repository.
- Accepted with reasons in the build log: 8 moderate `npm audit` advisories in the lint toolchain only, the whole history being sent in the join acknowledgement (bounded by the board caps and compressed), no accounts by design, the owner key kept in plain text in the browser's local storage.

## Not built
Follow mode, a Redis adapter for several socket servers, and history paging or snapshots.
