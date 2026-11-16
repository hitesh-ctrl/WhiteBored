import { notFound } from "next/navigation";
import Board from "../../../components/Board";
import { prisma } from "../../../lib/db";
import { idSchema } from "../../../shared/protocol";

export default async function BoardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!idSchema.safeParse(id).success) notFound();
  const board = await prisma.board.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!board) notFound();
  return <Board boardId={board.id} boardName={board.name} />;
}
