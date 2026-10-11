import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import {
  TRASH_RETENTION_DAYS,
  buildSnapshot,
  deletedExpenseSnapshotSchema,
  purgeExpiredTrash,
  trashCutoff,
  trashDaysLeft,
  trashPurgeDate,
} from './trash';

const DAY = 24 * 60 * 60 * 1000;

describe('trash retention', () => {
  it('keeps entries for 30 days', () => {
    const deleted = new Date('2026-01-01T12:00:00Z');
    expect(TRASH_RETENTION_DAYS).toBe(30);
    expect(trashPurgeDate(deleted).getTime() - deleted.getTime()).toBe(30 * DAY);
  });

  it('counts the days left and never goes below 0', () => {
    const deleted = new Date('2026-01-01T12:00:00Z');
    expect(trashDaysLeft(deleted, deleted)).toBe(30);
    expect(trashDaysLeft(deleted, new Date(deleted.getTime() + 29.5 * DAY))).toBe(1);
    expect(trashDaysLeft(deleted, new Date(deleted.getTime() + 45 * DAY))).toBe(0);
  });

  it('purges everything older than the cutoff', async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 3 });
    const now = new Date('2026-03-01T00:00:00Z');
    const count = await purgeExpiredTrash({ deletedExpense: { deleteMany } } as unknown as PrismaClient, now);
    expect(count).toBe(3);
    expect(deleteMany).toHaveBeenCalledWith({ where: { deletedAt: { lt: trashCutoff(now) } } });
  });
});

describe('snapshot', () => {
  it('round-trips an expense through the schema', () => {
    const snapshot = buildSnapshot({
      title: 'Dinner',
      description: null,
      amount: 5000,
      currency: 'EUR',
      exchangeRate: 1,
      baseCurrencyAmount: null,
      category: 'Food',
      placeName: null,
      isPrivate: false,
      latitude: null,
      longitude: null,
      expenseDate: new Date('2026-02-01T10:00:00Z'),
      splitMode: 'EQUAL',
      paidById: 'u1',
      addedById: 'u1',
      receiptId: 'r1',
      createdAt: new Date('2026-02-01T10:05:00Z'),
      shares: [
        { userId: 'u1', amount: 2500, shares: 1, percentage: null },
        { userId: 'u2', amount: 2500, shares: 1, percentage: null },
      ],
    });
    const parsed = deletedExpenseSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot)));
    expect(parsed).toEqual(snapshot);
    expect(parsed.expenseDate).toBe('2026-02-01T10:00:00.000Z');
  });

  it('rejects a malformed snapshot', () => {
    expect(deletedExpenseSnapshotSchema.safeParse({ title: 'x' }).success).toBe(false);
  });
});
