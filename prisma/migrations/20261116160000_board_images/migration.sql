-- CreateTable
CREATE TABLE "BoardImage" (
    "seq" SERIAL NOT NULL,
    "id" UUID NOT NULL,
    "boardId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "authorProof" TEXT,
    "template" TEXT,
    "mime" TEXT,
    "data" BYTEA,
    "byteSize" INTEGER NOT NULL DEFAULT 0,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "w" DOUBLE PRECISION NOT NULL,
    "h" DOUBLE PRECISION NOT NULL,
    "opacity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BoardImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BoardImage_seq_key" ON "BoardImage"("seq");

-- CreateIndex
CREATE INDEX "BoardImage_boardId_seq_idx" ON "BoardImage"("boardId", "seq");

-- AddForeignKey
ALTER TABLE "BoardImage" ADD CONSTRAINT "BoardImage_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "Board"("id") ON DELETE CASCADE ON UPDATE CASCADE;

