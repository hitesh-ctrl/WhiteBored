import { createPrisma } from "./prisma";
import type { PrismaClient } from "../generated/prisma/client";

const g = globalThis as unknown as { __prisma?: PrismaClient };
/** One client per Next.js process, kept across hot reloads in development. */
export const prisma = (g.__prisma ??= createPrisma());
