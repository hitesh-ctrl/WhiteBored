-- CreateTable
CREATE TABLE "Board" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Board_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stroke" (
    "seq" SERIAL NOT NULL,
    "id" UUID NOT NULL,
    "boardId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "color" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "points" JSONB NOT NULL,
    "pointCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Stroke_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Stroke_seq_key" ON "Stroke"("seq");

-- CreateIndex
CREATE INDEX "Stroke_boardId_seq_idx" ON "Stroke"("boardId", "seq");

-- AddForeignKey
ALTER TABLE "Stroke" ADD CONSTRAINT "Stroke_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "Board"("id") ON DELETE CASCADE ON UPDATE CASCADE;
