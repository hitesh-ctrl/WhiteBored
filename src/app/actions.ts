"use server";

import { createHash, randomBytes } from "node:crypto";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { KeyedLimiter } from "../lib/keyedLimiter";
import { prisma } from "../lib/db";
import { clientAddress, trustHops } from "../lib/proxy";
import { BOARD_CREATES_PER_MINUTE } from "../shared/limits";
import { nameSchema } from "../shared/protocol";

export type CreateBoardState = { error?: string };

const hops = trustHops(process.env.TRUST_PROXY);
const trustProxy = hops > 0;
// With a trusted proxy every client address gets its own small allowance. Without one the real
// address is unknown, so a single shared allowance protects the database instead.
const limiter = new KeyedLimiter({
  burst: trustProxy ? BOARD_CREATES_PER_MINUTE : 60,
  perMinute: trustProxy ? BOARD_CREATES_PER_MINUTE : 60,
});

export async function createBoard(_prev: CreateBoardState, formData: FormData): Promise<CreateBoardState> {
  const parsed = nameSchema.safeParse(formData.get("name"));
  if (!parsed.success) {
    return { error: "Enter a board name of 1 to 30 characters." };
  }
  const h = await headers();
  const key = trustProxy ? clientAddress(h.get("x-forwarded-for") ?? undefined, hops, "unknown") : "all";
  if (!limiter.allow(key)) {
    return { error: "Too many boards were created. Please wait a minute and try again." };
  }

  // The owner key is shown to the creator once, in the URL fragment. Only its hash is stored.
  const ownerKey = randomBytes(24).toString("base64url");
  const ownerHash = createHash("sha256").update(ownerKey).digest("hex");
  let id: string;
  try {
    id = (await prisma.board.create({ data: { name: parsed.data, ownerHash }, select: { id: true } })).id;
  } catch (err) {
    console.error("create board failed:", err instanceof Error ? err.message : "unknown error");
    return { error: "Could not create the board. Please try again." };
  }
  redirect(`/board/${id}#owner=${ownerKey}`); // outside try/catch: redirect works by throwing
}
