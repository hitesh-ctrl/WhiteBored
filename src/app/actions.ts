"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "../lib/db";
import { nameSchema } from "../shared/protocol";

export type CreateBoardState = { error?: string };

export async function createBoard(_prev: CreateBoardState, formData: FormData): Promise<CreateBoardState> {
  const parsed = nameSchema.safeParse(formData.get("name"));
  if (!parsed.success) {
    return { error: "Enter a board name of 1 to 30 characters." };
  }
  const board = await prisma.board.create({ data: { name: z.string().parse(parsed.data) } });
  redirect(`/board/${board.id}`);
}
