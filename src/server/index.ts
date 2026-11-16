import "dotenv/config"; // must stay the first import so DATABASE_URL is set before Prisma is used
import { createPrisma } from "../lib/prisma";
import { createWhiteboardServer } from "./app";

const port = Number(process.env.SOCKET_PORT ?? 4000);
const corsOrigin = process.env.CORS_ORIGIN;

if (!corsOrigin) throw new Error("CORS_ORIGIN is not set");
if (corsOrigin === "*") throw new Error('CORS_ORIGIN must be one exact origin, never "*"');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SOCKET_PORT is invalid");

const prisma = createPrisma();
const { httpServer, io } = createWhiteboardServer({ prisma, corsOrigin });

httpServer.listen(port, () => console.log(`socket server listening on :${port}`));

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(`${signal} received, shutting down`);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  await io.close(); // also closes the http server
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
