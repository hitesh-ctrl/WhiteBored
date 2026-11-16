# Whiteboard

A real-time collaborative whiteboard. Create a board, share the link, pick a name and draw together. Lines appear while they are drawn, named cursors are shown, each person can undo their own strokes, and everything is saved so a refresh or a late joiner sees the whole board.

## Architecture
- **Web**: Next.js 16 (App Router), React 19, Tailwind 4. Home page creates boards through a server action.
- **Socket server**: a separate Node 22 process running Socket.IO 4.8 (`src/server`). It validates every message with zod and stores strokes in Postgres.
- **Database**: Postgres 16 through Prisma 7 and the `@prisma/adapter-pg` driver adapter.
- **Shared**: `src/shared` holds the zod schemas, event types and limits used by both sides.

Design details are in [docs/DESIGN.md](docs/DESIGN.md), the test approach in [docs/TEST_PLAN.md](docs/TEST_PLAN.md).

## Requirements
Node 22, npm, Postgres 16.

## Setup
```bash
npm ci                       # also runs prisma generate
cp .env.example .env         # then edit DATABASE_URL and TEST_DATABASE_URL
npm run db:deploy            # apply migrations to DATABASE_URL
```

Create the two databases first if they do not exist (one for the app, one for tests).

## Run
Two processes are needed.
```bash
npm run server               # socket server on SOCKET_PORT (default 4000)
npm run dev                  # web app on http://localhost:3000
```
For a production build: `npm run build && npm start`.

## Configuration (.env)
| Variable | Meaning |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `TEST_DATABASE_URL` | Separate database used by the test suite |
| `SOCKET_PORT` | Port of the socket server |
| `CORS_ORIGIN` | The one browser origin allowed to connect, for example `http://localhost:3000`. Never `*`. |
| `NEXT_PUBLIC_SOCKET_URL` | Where the browser finds the socket server |

## Scripts
| Command | What it does |
|---|---|
| `npm test` | Unit and server integration tests (needs `TEST_DATABASE_URL`) |
| `npm run typecheck` | TypeScript check |
| `npm run lint` | ESLint |
| `npm run build` | Production build of the web app |
| `npm run e2e` | Browser end-to-end checks with two Chromium windows (needs a build, `npx playwright install chromium`, and free ports 3100 and 4000) |
| `npm run probes` | Hostile-input checks against a running socket server |
| `npm run xss` | Checks that names render as text in a real browser |
| `npm run bench` | Loopback latency benchmark (server cost only) |

## Limits
Canvas 1600x900 logical units. At most 5000 points per stroke, 5000 strokes and 500,000 points per board, 200 points per progress batch, names 1 to 30 characters.
