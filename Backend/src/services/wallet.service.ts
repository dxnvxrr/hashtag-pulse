import { Prisma, type Currency, type TransactionReason, type Wallet } from '@prisma/client';
import { prisma, type Tx } from '../lib/prisma.js';
import { Errors } from '../lib/errors.js';

export interface LedgerEntry {
  currency: Currency;
  /** Signed: positive credits, negative debits. */
  amount: bigint;
  reason: TransactionReason;
  /** Must be unique per logical operation + currency, e.g. `run:<id>:TICKS`. */
  idempotencyKey: string;
  metadata?: Prisma.InputJsonValue;
}

export interface WalletView {
  ticks: string;
  cores: string;
  slowMoTickets: number;
  anchors: number;
  version: number;
}

export function toWalletView(w: Wallet): WalletView {
  // BigInt is serialised as a string so clients never lose precision through JSON doubles.
  return {
    ticks: w.ticks.toString(),
    cores: w.cores.toString(),
    slowMoTickets: w.slowMoTickets,
    anchors: w.anchors,
    version: w.version,
  };
}

type Balances = { ticks: bigint; cores: bigint; slowMoTickets: bigint; anchors: bigint };

const columnFor: Record<Currency, keyof Balances> = {
  TICKS: 'ticks',
  CORES: 'cores',
  SLOWMO_TICKETS: 'slowMoTickets',
  ANCHORS: 'anchors',
};

const INT32_MAX = 2_147_483_647n;

/**
 * Applies a set of ledger entries atomically inside the caller's transaction.
 *
 * Concurrency: the wallet row is locked with SELECT ... FOR UPDATE, so concurrent mutations for one
 * user serialise. Idempotency is checked under that lock, so a retried request returns `applied=false`
 * instead of double-crediting. The CHECK constraints in the migration are the last line of defence.
 */
export async function applyLedgerEntries(
  tx: Tx,
  userId: string,
  entries: LedgerEntry[],
): Promise<{ applied: boolean; wallet: Wallet }> {
  if (entries.length === 0) throw Errors.badRequest('empty_ledger', 'No ledger entries');

  const locked = await tx.$queryRaw<Array<{ userId: string }>>(
    Prisma.sql`SELECT "userId" FROM "wallets" WHERE "userId" = ${userId}::uuid FOR UPDATE`,
  );
  if (locked.length === 0) throw Errors.notFound('wallet_not_found', 'Wallet not found');

  const keys = entries.map((e) => e.idempotencyKey);
  const existing = await tx.transaction.findMany({ where: { idempotencyKey: { in: keys } }, select: { idempotencyKey: true } });
  if (existing.length === keys.length) {
    const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId } });
    return { applied: false, wallet };
  }
  if (existing.length > 0) {
    // A partially-applied operation means two different operations share keys — a programming error.
    throw Errors.conflict('idempotency_key_collision', 'Idempotency keys partially consumed');
  }

  const w = await tx.wallet.findUniqueOrThrow({ where: { userId } });
  const balances: Balances = {
    ticks: w.ticks,
    cores: w.cores,
    slowMoTickets: BigInt(w.slowMoTickets),
    anchors: BigInt(w.anchors),
  };

  const rows: Prisma.TransactionCreateManyInput[] = [];
  for (const e of entries) {
    const col = columnFor[e.currency];
    const next = balances[col] + e.amount;
    if (next < 0n) throw Errors.conflict('insufficient_funds', `Insufficient ${e.currency}`);
    if ((col === 'slowMoTickets' || col === 'anchors') && next > INT32_MAX) {
      throw Errors.badRequest('balance_overflow', `${e.currency} overflow`);
    }
    balances[col] = next;
    rows.push({
      userId,
      currency: e.currency,
      amount: e.amount,
      balanceAfter: next,
      reason: e.reason,
      idempotencyKey: e.idempotencyKey,
      metadata: e.metadata ?? Prisma.JsonNull,
    });
  }

  const wallet = await tx.wallet.update({
    where: { userId },
    data: {
      ticks: balances.ticks,
      cores: balances.cores,
      slowMoTickets: Number(balances.slowMoTickets),
      anchors: Number(balances.anchors),
      version: { increment: 1 },
    },
  });
  await tx.transaction.createMany({ data: rows });
  return { applied: true, wallet };
}

/** Convenience wrapper that opens its own transaction. */
export async function applyLedger(userId: string, entries: LedgerEntry[]) {
  return prisma.$transaction((tx) => applyLedgerEntries(tx, userId, entries), {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    timeout: 10_000,
  });
}

export async function getWallet(userId: string): Promise<WalletView> {
  const w = await prisma.wallet.findUnique({ where: { userId } });
  if (!w) throw Errors.notFound('wallet_not_found', 'Wallet not found');
  return toWalletView(w);
}
