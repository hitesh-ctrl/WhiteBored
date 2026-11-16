import type { PrismaClient } from "../generated/prisma/client";
import { createPrisma } from "./prisma";

const g = globalThis as unknown as { __prisma?: PrismaClient };

/**
 * One client per Next.js process, kept across hot reloads in development. It is created on first
 * use, not on import, so `next build` works in an environment that has no DATABASE_URL.
 */
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    return Reflect.get((g.__prisma ??= createPrisma()), prop);
  },
});
