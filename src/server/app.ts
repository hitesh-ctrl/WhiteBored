import { createServer } from "node:http";
import { Server } from "socket.io";

// Placeholder: no handlers yet.
export function createWhiteboardServer(opts: { prisma: unknown; corsOrigin: string }) {
  const httpServer = createServer();
  const io = new Server(httpServer, { cors: { origin: opts.corsOrigin } });
  return { httpServer, io };
}
