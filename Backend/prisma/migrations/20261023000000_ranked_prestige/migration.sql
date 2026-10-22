-- AlterEnum
ALTER TYPE "RunMode" ADD VALUE 'RANKED';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "prestige" INTEGER NOT NULL DEFAULT 0;


-- Prestige is capped at 100 levels.
ALTER TABLE "users" ADD CONSTRAINT "users_prestige_range" CHECK ("prestige" BETWEEN 0 AND 100);
