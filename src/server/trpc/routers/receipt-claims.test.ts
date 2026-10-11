import { beforeEach, expect, test, vi } from 'vitest';
vi.mock('@/server/auth', () => ({ auth: vi.fn() }));
vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/server/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/server/lib/receipt-processor', () => ({ processReceiptImage: vi.fn() }));
vi.mock('@/server/ai/registry', () => ({
  getAIProvidersWithFallback: vi.fn(),
  getConfiguredProviderPriority: vi.fn(),
}));
const { sendNotifications } = vi.hoisted(() => ({ sendNotifications: vi.fn(async () => undefined) }));
vi.mock('../../lib/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/notifications')>()),
  sendNotifications,
}));
import { receiptsRouter } from './receipts';
import type { TRPCContext } from '../init';

let receiptCounter = 0;

function fixture(opts: { expense?: boolean; groupId?: string | null; userId?: string } = {}) {
  const receiptId = `receipt-${++receiptCounter}`;
  const receipt = {
    id: receiptId,
    uploadedById: 'alice',
    savedById: null,
    status: 'COMPLETED',
    originalName: 'bon.jpg',
    groupId: opts.groupId === undefined ? 'group' : opts.groupId,
    claimRequestedAt: null,
    claimRequestedById: null,
    group: opts.groupId === null ? null : { members: [{ userId: 'alice' }, { userId: 'bob' }, { userId: 'carol' }] },
    extractedData: {
      merchantName: 'Café Nil',
      currency: 'EUR',
      total: 1000,
      subtotal: 1000,
      tax: 0,
      tip: 0,
      items: [],
    },
  };
  const db = {
    user: {
      findUnique: vi.fn(async () => ({ id: 'alice', name: 'Alice', email: 'a@x', suspendedAt: null })),
    },
    receipt: {
      findUnique: vi.fn(async () => receipt),
      update: vi.fn(async () => receipt),
    },
    receiptItem: { findUnique: vi.fn(async () => ({ id: 'line', receiptId })) },
    receiptItemClaim: {
      findMany: vi.fn(async () => [{ receiptItemId: 'line', userId: 'bob' }]),
      createMany: vi.fn(async () => ({ count: 1 })),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    expense: { findUnique: vi.fn(async () => (opts.expense ? { id: 'exp' } : null)) },
  };
  const caller = receiptsRouter.createCaller({
    db,
    session: { user: { id: opts.userId ?? 'alice' } },
    headers: new Headers(),
    impersonating: null,
  } as unknown as TRPCContext);
  return { caller, db, receiptId };
}

beforeEach(() => sendNotifications.mockClear());

test('starting a request marks the receipt and notifies every other member', async () => {
  const { caller, db, receiptId } = fixture();
  const result = await caller.startClaimRequest({ receiptId });
  expect(result).toEqual({ notified: 2 });
  expect(db.receipt.update).toHaveBeenCalledWith({
    where: { id: receiptId },
    data: expect.objectContaining({ claimRequestedById: 'alice', savedById: 'alice' }),
  });
  const items = (sendNotifications.mock.calls[0] as unknown as [unknown, { userId: string; kind: string }[]])[1];
  expect(items.map((i) => i.userId)).toEqual(['bob', 'carol']);
  expect(items.every((i) => i.kind === 'CLAIM_REQUEST')).toBe(true);
});

test('a booked receipt or one without a group cannot be shared for picking', async () => {
  await expect(fixture({ expense: true }).caller.startClaimRequest({ receiptId: 'receipt-x' })).rejects.toThrow(
    /already has an expense/,
  );
  const ungrouped = fixture({ groupId: null });
  await expect(ungrouped.caller.startClaimRequest({ receiptId: ungrouped.receiptId })).rejects.toThrow(/group/);
});

test('a person only adds and removes their own pick', async () => {
  const { caller, db } = fixture({ userId: 'bob' });
  await caller.setClaim({ receiptItemId: 'line', claimed: true });
  expect(db.receiptItemClaim.createMany).toHaveBeenCalledWith({
    data: [{ receiptItemId: 'line', userId: 'bob' }],
    skipDuplicates: true,
  });
  await caller.setClaim({ receiptItemId: 'line', claimed: false });
  expect(db.receiptItemClaim.deleteMany).toHaveBeenCalledWith({ where: { receiptItemId: 'line', userId: 'bob' } });
});

test('picks are closed once the receipt is booked', async () => {
  const { caller, db } = fixture({ expense: true, userId: 'bob' });
  await expect(caller.setClaim({ receiptItemId: 'line', claimed: true })).rejects.toThrow(/already been booked/);
  expect(db.receiptItemClaim.createMany).not.toHaveBeenCalled();
});

test('someone outside the group cannot pick', async () => {
  const { caller } = fixture({ userId: 'mallory' });
  await expect(caller.setClaim({ receiptItemId: 'line', claimed: true })).rejects.toThrow();
});

test('getClaims lists the picks', async () => {
  const { caller, receiptId } = fixture({ userId: 'bob' });
  const result = await caller.getClaims({ receiptId });
  expect(result.claims).toEqual([{ receiptItemId: 'line', userId: 'bob' }]);
  expect(result.expenseId).toBeNull();
});
