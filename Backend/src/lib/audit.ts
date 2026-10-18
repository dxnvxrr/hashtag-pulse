import type { Prisma } from '@prisma/client';
import { prisma, type Tx } from './prisma.js';

export type AuditSeverity = 'info' | 'warn' | 'critical';

export async function audit(
  action: string,
  opts: { userId?: string | null; severity?: AuditSeverity; ip?: string | null; metadata?: Prisma.InputJsonValue },
  tx: Tx | typeof prisma = prisma,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      action,
      userId: opts.userId ?? null,
      severity: opts.severity ?? 'info',
      ip: opts.ip ?? null,
      metadata: opts.metadata ?? undefined,
    },
  });
}
