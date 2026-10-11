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

function fixture(
  opts: {
    expense?: boolean;
    groupId?: string | null;
    userId?: string;
    requested?: boolean;
    lines?: { id: string; quantity?: number; claims: { userId: string; units?: number }[] }[];
    done?: string[];
    quantity?: number;
  } = {},
) {
  const receiptId = `receipt-${++receiptCounter}`;
  const receipt = {
    id: receiptId,
    uploadedById: 'alice',
    savedById: null,
    status: 'COMPLETED',
    originalName: 'bon.jpg',
    groupId: opts.groupId === undefined ? 'group' : opts.groupId,
    claimRequestedAt: opts.requested ? new Date() : null,
    claimRequestedById: opts.requested ? 'alice' : null,
    claimsCompleteNotifiedAt: null,
    claimsOpenNotifiedAt: null,
    items: (opts.lines ?? [{ id: 'line', claims: [] }]).map((l) => ({ quantity: 1, ...l })),
    claimsDone: (opts.done ?? []).map((userId) => ({ userId })),
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
      findMany: vi.fn(async () => [{ id: 'alice' }, { id: 'bob' }, { id: 'carol' }]),
    },
    receipt: {
      findUnique: vi.fn(async () => receipt),
      update: vi.fn(async () => receipt),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    receiptClaimDone: {
      findMany: vi.fn(async () => (opts.done ?? []).map((userId) => ({ userId }))),
      createMany: vi.fn(async () => ({ count: 1 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    receiptItem: { findUnique: vi.fn(async () => ({ id: 'line', receiptId, quantity: opts.quantity ?? 1 })) },
    receiptItemClaim: {
      findMany: vi.fn(async () => [{ receiptItemId: 'line', userId: 'bob' }]),
      upsert: vi.fn(async () => ({})),
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
  expect(db.receiptItemClaim.upsert).toHaveBeenCalledWith({
    where: { receiptItemId_userId: { receiptItemId: 'line', userId: 'bob' } },
    create: { receiptItemId: 'line', userId: 'bob', units: 1 },
    update: { units: 1 },
  });
  await caller.setClaim({ receiptItemId: 'line', claimed: false });
  expect(db.receiptItemClaim.deleteMany).toHaveBeenCalledWith({ where: { receiptItemId: 'line', userId: 'bob' } });
});

test('picks are closed once the receipt is booked', async () => {
  const { caller, db } = fixture({ expense: true, userId: 'bob' });
  await expect(caller.setClaim({ receiptItemId: 'line', claimed: true })).rejects.toThrow(/already been booked/);
  expect(db.receiptItemClaim.upsert).not.toHaveBeenCalled();
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

test('getClaims tells who is done and who is still picking', async () => {
  const { caller, receiptId } = fixture({ userId: 'bob', done: ['alice'] });
  const result = await caller.getClaims({ receiptId });
  expect(result.done).toEqual(['alice']);
  expect(result.waiting).toEqual(['bob', 'carol']);
});

test('the last open line picked tells the others once that everything is picked', async () => {
  const { caller, db } = fixture({
    userId: 'bob',
    requested: true,
    lines: [
      { id: 'line', claims: [{ userId: 'bob' }] },
      { id: 'other', claims: [{ userId: 'alice' }] },
    ],
  });
  await caller.setClaim({ receiptItemId: 'line', claimed: true });
  expect(db.receipt.updateMany).toHaveBeenCalledWith({
    where: { id: expect.any(String), claimsCompleteNotifiedAt: null },
    data: { claimsCompleteNotifiedAt: expect.any(Date) },
  });
  const items = (sendNotifications.mock.calls[0] as unknown as [unknown, { userId: string; kind: string }[]])[1];
  expect(items.map((i) => [i.userId, i.kind])).toEqual([
    ['alice', 'CLAIMS_COMPLETE'],
    ['carol', 'CLAIMS_COMPLETE'],
  ]);
});

test('when the marker was already set, nobody is told twice', async () => {
  const { caller, db } = fixture({
    userId: 'bob',
    requested: true,
    lines: [{ id: 'line', claims: [{ userId: 'bob' }] }],
  });
  db.receipt.updateMany.mockResolvedValueOnce({ count: 0 });
  await caller.setClaim({ receiptItemId: 'line', claimed: true });
  expect(sendNotifications).not.toHaveBeenCalled();
});

test('everyone done with lines left: the group hears how many are open', async () => {
  const { caller, db, receiptId } = fixture({
    userId: 'carol',
    requested: true,
    lines: [
      { id: 'line', claims: [{ userId: 'bob' }] },
      { id: 'other', claims: [] },
    ],
    done: ['alice', 'bob', 'carol'],
  });
  await caller.finishClaims({ receiptId });
  expect(db.receiptClaimDone.createMany).toHaveBeenCalledWith({
    data: [{ receiptId, userId: 'carol' }],
    skipDuplicates: true,
  });
  const items = (
    sendNotifications.mock.calls[0] as unknown as [unknown, { userId: string; kind: string; vars: { count: number } }[]]
  )[1];
  expect(items.map((i) => i.userId)).toEqual(['alice', 'bob']);
  expect(items.every((i) => i.kind === 'CLAIMS_OPEN' && i.vars.count === 1)).toBe(true);
});

test('finishing while others still pick sends nothing', async () => {
  const { caller, receiptId } = fixture({
    userId: 'carol',
    requested: true,
    lines: [{ id: 'other', claims: [] }],
    done: ['carol'],
  });
  await caller.finishClaims({ receiptId });
  expect(sendNotifications).not.toHaveBeenCalled();
});

test('a person picks several units of a line, never more than it has', async () => {
  const { caller, db } = fixture({ userId: 'bob', quantity: 3 });
  const result = await caller.setClaim({ receiptItemId: 'line', units: 2 });
  expect(result).toEqual({ claimed: true, units: 2 });
  await caller.setClaim({ receiptItemId: 'line', units: 9 });
  expect(db.receiptItemClaim.upsert).toHaveBeenLastCalledWith(expect.objectContaining({ update: { units: 3 } }));
  await caller.setClaim({ receiptItemId: 'line', units: 0 });
  expect(db.receiptItemClaim.deleteMany).toHaveBeenCalledWith({ where: { receiptItemId: 'line', userId: 'bob' } });
});

test('a line of several stays open until its units are picked', async () => {
  const { caller } = fixture({
    userId: 'bob',
    requested: true,
    lines: [{ id: 'line', quantity: 3, claims: [{ userId: 'bob', units: 2 }] }],
  });
  await caller.setClaim({ receiptItemId: 'line', units: 2 });
  expect(sendNotifications).not.toHaveBeenCalled();
});
