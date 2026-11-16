-- AlterTable
ALTER TABLE "Board" ADD COLUMN     "ownerHash" TEXT,
ADD COLUMN     "viewId" UUID NOT NULL DEFAULT gen_random_uuid();

-- AlterTable
ALTER TABLE "Stroke" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'pen',
ADD COLUMN     "text" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Board_viewId_key" ON "Board"("viewId");

