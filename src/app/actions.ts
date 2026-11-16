"use server";

import { redirect } from "next/navigation";
import { prisma } from "../lib/db";
import { nameSchema } from "../shared/protocol";

export type CreateBoardState = { error?: string };

export async function createBoard(_prev: CreateBoardState, formData: FormData): Promise<CreateBoardState> {
  const parsed = nameSchema.safeParse(formData.get("name"));
  if (!parsed.success) {
    return { error: "Enter a board name of 1 to 30 characters." };
  }
  let id: string;
  try {
    id = (await prisma.board.create({ data: { name: parsed.data }, select: { id: true } })).id;
  } catch (err) {
    console.error("create board failed:", err instanceof Error ? err.message : "unknown error");
    return { error: "Could not create the board. Please try again." };
  }
  redirect(`/board/${id}`); // outside try/catch: redirect works by throwing
}
