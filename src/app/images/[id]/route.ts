import { prisma } from "../../../lib/db";
import { imageHeaders } from "../../../lib/imageResponse";
import { idSchema } from "../../../shared/protocol";

export const dynamic = "force-dynamic";

/**
 * The bytes of an uploaded picture. Served from the same address as the page, so the browser may
 * read the picture back when the board is exported. The id is a random uuid that only people who
 * joined the board were told, and a picture's bytes never change under its id.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!idSchema.safeParse(id).success) return new Response(null, { status: 404 });
  const row = await prisma.boardImage.findUnique({ where: { id }, select: { data: true, mime: true } });
  const headers = row?.data ? imageHeaders(row.mime) : null;
  if (!row?.data || !headers) return new Response(null, { status: 404 });
  return new Response(new Uint8Array(row.data), { headers });
}
