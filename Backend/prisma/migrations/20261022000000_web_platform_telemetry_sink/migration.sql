-- AlterEnum
ALTER TYPE "Platform" ADD VALUE 'WEB';

-- CreateTable
CREATE TABLE "telemetry_events" (
    "id" BIGSERIAL NOT NULL,
    "streamId" VARCHAR(64) NOT NULL,
    "category" VARCHAR(32) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "userId" UUID NOT NULL,
    "clientTs" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "appVersion" VARCHAR(32) NOT NULL,
    "platform" VARCHAR(16) NOT NULL,
    "sessionId" VARCHAR(64) NOT NULL,
    "props" JSONB NOT NULL,

    CONSTRAINT "telemetry_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "telemetry_events_category_name_receivedAt_idx" ON "telemetry_events"("category", "name", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "telemetry_events_category_streamId_key" ON "telemetry_events"("category", "streamId");

