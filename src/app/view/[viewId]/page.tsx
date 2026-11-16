import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Board from "../../../components/Board";
import { prisma } from "../../../lib/db";
import { idSchema } from "../../../shared/protocol";

export const metadata: Metadata = { robots: { index: false, follow: false } };

/** Read-only page. It only knows the view id, never the edit id. */
export default async function ViewPage({ params }: { params: Promise<{ viewId: string }> }) {
  const { viewId } = await params;
  if (!idSchema.safeParse(viewId).success) notFound();
  const board = await prisma.board.findUnique({ where: { viewId }, select: { name: true } });
  if (!board) notFound();
  return <Board viewId={viewId} boardName={board.name} />;
}
