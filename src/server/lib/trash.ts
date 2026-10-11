import { z } from 'zod';
import type { PrismaClient } from '@/generated/prisma/client';
import { SplitMode } from '@/generated/prisma/client';

/** How long a deleted expense stays restorable. */
export const TRASH_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export function trashPurgeDate(deletedAt: Date): Date {
  return new Date(deletedAt.getTime() + TRASH_RETENTION_DAYS * DAY_MS);
}

export function trashCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - TRASH_RETENTION_DAYS * DAY_MS);
}

/** Whole days left before the entry is purged (at least 0). */
export function trashDaysLeft(deletedAt: Date, now: Date = new Date()): number {
  return Math.max(0, Math.ceil((trashPurgeDate(deletedAt).getTime() - now.getTime()) / DAY_MS));
}

/** What is kept of an expense: every column needed to recreate the row, with dates as ISO strings. */
export const deletedExpenseSnapshotSchema = z.object({
  title: z.string(),
  description: z.string().nullable(),
  amount: z.number().int(),
  currency: z.string(),
  exchangeRate: z.number(),
  baseCurrencyAmount: z.number().int().nullable(),
  category: z.string().nullable(),
  placeName: z.string().nullable(),
  isPrivate: z.boolean(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  expenseDate: z.string(),
  splitMode: z.nativeEnum(SplitMode),
  paidById: z.string(),
  addedById: z.string(),
  receiptId: z.string().nullable(),
  createdAt: z.string(),
  shares: z.array(
    z.object({
      userId: z.string(),
      amount: z.number().int(),
      shares: z.number().int(),
      percentage: z.number().int().nullable(),
    }),
  ),
});

export type DeletedExpenseSnapshot = z.infer<typeof deletedExpenseSnapshotSchema>;

type ExpenseWithShares = {
  title: string;
  description: string | null;
  amount: number;
  currency: string;
  exchangeRate: number;
  baseCurrencyAmount: number | null;
  category: string | null;
  placeName: string | null;
  isPrivate: boolean;
  latitude: number | null;
  longitude: number | null;
  expenseDate: Date;
  splitMode: SplitMode;
  paidById: string;
  addedById: string;
  receiptId: string | null;
  createdAt: Date;
  shares: { userId: string; amount: number; shares: number; percentage: number | null }[];
};

export function buildSnapshot(e: ExpenseWithShares): DeletedExpenseSnapshot {
  return {
    title: e.title,
    description: e.description,
    amount: e.amount,
    currency: e.currency,
    exchangeRate: e.exchangeRate,
    baseCurrencyAmount: e.baseCurrencyAmount,
    category: e.category,
    placeName: e.placeName,
    isPrivate: e.isPrivate,
    latitude: e.latitude,
    longitude: e.longitude,
    expenseDate: e.expenseDate.toISOString(),
    splitMode: e.splitMode,
    paidById: e.paidById,
    addedById: e.addedById,
    receiptId: e.receiptId,
    createdAt: e.createdAt.toISOString(),
    shares: e.shares.map((s) => ({
      userId: s.userId,
      amount: s.amount,
      shares: s.shares,
      percentage: s.percentage,
    })),
  };
}

/** Removes trash entries older than the retention period. Returns how many were removed. */
export async function purgeExpiredTrash(db: PrismaClient, now: Date = new Date()): Promise<number> {
  const { count } = await db.deletedExpense.deleteMany({ where: { deletedAt: { lt: trashCutoff(now) } } });
  return count;
}

let purgeTimer: ReturnType<typeof setInterval> | null = null;

/** Purges once now and then every 6 hours (started from instrumentation.ts). */
export function startTrashPurger(db: PrismaClient, onError: (error: unknown) => void): void {
  if (purgeTimer) return;
  const run = () => purgeExpiredTrash(db).catch(onError);
  void run();
  purgeTimer = setInterval(run, 6 * 60 * 60 * 1000);
  purgeTimer.unref?.();
}
