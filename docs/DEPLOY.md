# Deploying for free

The app needs a program that stays running (the socket server keeps live connections and some state in memory) and a Postgres database. That rules out hosts that only run short-lived functions.

## Recommended: one Render web service plus a free Neon database
The container image runs the pages, the socket server and a small router together behind one address (`Dockerfile`, last stage `app`; `render.yaml` is the Render blueprint). The sockets use the page's own address, so nothing needs the public address in advance.

**What you need:** a GitHub account, a Render account and a Neon account. No payment card was needed for the free plans when this was written, but check each sign-up page.

1. **Put the project on GitHub.** Create an empty repository, then in the project folder run `git remote add origin <your repository address>` and `git push -u origin HEAD`. (The history contains only your own name and e-mail. `.env` is not in it; do not add it.)
2. **Create the database on Neon.** New project, any region near you. Copy the connection string and choose the **direct** (not pooled) one; it ends with `?sslmode=require`.
3. **Deploy on Render.** New, Blueprint, pick the repository; Render reads `render.yaml`. When asked, paste the connection string as `DATABASE_URL`. Apply. The first build takes several minutes.
4. **Open the address Render gives you** (`https://whiteboard-xxxx.onrender.com`). Create a board, use **Copy link** and open that link in another browser or on a phone. `/healthz` should answer `ok`.

Later changes: push to GitHub and Render redeploys. The database schema is applied automatically at every start (`RUN_MIGRATIONS`).

### What to expect on the free plans
- **Render free** stops the service after 15 minutes without traffic and needs about a minute to wake up; messages on an open websocket count as traffic. The first visitor after a quiet period waits. Board data is not lost, it lives in Neon. The browser reconnects by itself.
- **Neon free** gives 1 GB of storage and 100 compute-hours a month per project, and the database pauses after 5 minutes without queries (the next query wakes it). The 1 GB is far more than a few boards need; each board is capped at 500,000 points.
- **Pictures live in the database.** A board may hold up to 8 pictures and 2.5 MB of uploads; on Neon's free 1 GB that is room for hundreds of boards' worth, but many busy boards would fill it. Delete boards you no longer need.
- **Do not use Render's own free Postgres** for anything you want to keep: it is deleted 30 days after creation.
- Memory: the container used about 185 MiB with three browsers connected on a local test; the free instance has 512 MB.
- The owner of a board is whoever created it in that browser; the owner key lives in the browser's storage. If the browser data is cleared, the owner rights for that board are gone (anyone can still draw).
- The per-address connection limit cannot tell visitors apart behind the router, so the app uses one shared cap of 500 connections.

### If something does not work
- *"Could not join the board" or an empty page:* open the service logs on Render. A wrong `DATABASE_URL` or a missing `sslmode=require` shows up as a connection error.
- *"Migration failed":* use the direct (not pooled) Neon connection string, or set it as `DIRECT_DATABASE_URL` (used only for migrations).
- *Websocket blocked:* the app only accepts connections from the same address as the page. Opening it through a different address (for example an old preview link) fails by design.

## Also free: run it on your own computer and open a tunnel
```bash
npm run share:public
```
This builds the app for one address and serves it on port 3500 of your computer (it needs the same `.env` as local development). Then expose that port with a tunnel service and send people the address the tunnel prints. Any service that forwards `https://something` to `http://localhost:3500` works, for example `ssh -R 80:localhost:3500 nokey@localhost.run` (no account, nothing to install) or Cloudflare's `cloudflared tunnel --url http://localhost:3500`. The link works while your computer is on and the command keeps running. The tunnel services are third parties and their terms change; this route was tested up to the local port, not with a tunnel.

## Why not Vercel
Vercel added WebSocket support for its functions as a public beta in 2026, with a limit on how long one connection can live, and its own guidance is to keep a dedicated host for serious real-time work. This app also keeps live state in one running process, which does not fit functions that can run as many separate copies. Vercel could serve the pages, but the socket server would still need another host, so it adds a second platform for no gain.

## Not tested
A real Render and Neon deployment; a tunnel; Safari's treatment of the content security policy for same-address websockets (the policy relies on `'self'`).

Sources used for the free-plan details: Render's free-plan documentation (https://render.com/docs/free), Neon's free-plan limits (https://neon.com/faqs/free-plan-limits-and-quotas) and Vercel's WebSocket announcement (https://vercel.com/changelog/websocket-support-is-now-in-public-beta-1Wz7OuDJmgObCjILLggdQI). Check them again before relying on exact numbers.
