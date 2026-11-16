import "dotenv/config"; // must stay the first import so DATABASE_URL is set before Prisma is used
import { createPrisma } from "../lib/prisma";
import { trustHops } from "../lib/proxy";
import { createWhiteboardServer } from "./app";

const port = Number(process.env.SOCKET_PORT ?? 4000);
const corsOrigin = process.env.CORS_ORIGIN;

if (!corsOrigin) throw new Error("CORS_ORIGIN is not set");
if (corsOrigin === "*") throw new Error('CORS_ORIGIN must be one exact origin, never "*"');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SOCKET_PORT is invalid");

const maxConnectionsPerIp = Number(process.env.MAX_CONNECTIONS_PER_IP ?? 30);
if (!Number.isInteger(maxConnectionsPerIp) || maxConnectionsPerIp < 1) throw new Error("MAX_CONNECTIONS_PER_IP is invalid");
const trustProxy = trustHops(process.env.TRUST_PROXY);
const metricsToken = process.env.METRICS_TOKEN || undefined;

const prisma = createPrisma();
const { httpServer, io } = createWhiteboardServer({ prisma, corsOrigin, maxConnectionsPerIp, trustProxy, metricsToken });

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
