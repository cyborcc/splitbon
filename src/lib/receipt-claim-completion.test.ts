import { expect, test } from 'vitest';
import { completedClaimAssignments } from './receipt-claims';

const base = {
  items: [{ id: 'coffee', quantity: 2 }, { id: 'cake', quantity: 1 }],
  memberIds: new Set(['alice', 'bob']),
  manuallyAdjusted: false,
  editingExpense: false,
};
const complete = [
  { receiptItemId: 'coffee', userId: 'alice', units: 2 },
  { receiptItemId: 'cake', userId: 'bob', units: 1 },
];

test('complete picks automatically become weighted editor assignments', () => {
  const result = completedClaimAssignments({ ...base, claims: complete });
  expect(result?.assignments).toEqual({ coffee: new Set(['alice']), cake: new Set(['bob']) });
  expect(result?.counts).toEqual({ coffee: { alice: 2 } });
});

test('a partially claimed quantity is not complete even if every line has somebody', () => {
  expect(completedClaimAssignments({ ...base, claims: [{ ...complete[0]!, units: 1 }, complete[1]!] })).toBeNull();
});

test('empty receipts, missing lines and absent claims never auto-apply', () => {
  expect(completedClaimAssignments({ ...base, items: [], claims: [] })).toBeNull();
  expect(completedClaimAssignments({ ...base, claims: [complete[0]!] })).toBeNull();
  expect(completedClaimAssignments({ ...base, claims: [] })).toBeNull();
});

test('departed members cannot complete a line; claims for removed items are ignored', () => {
  expect(completedClaimAssignments({ ...base, claims: complete, memberIds: new Set(['bob']) })).toBeNull();
  const result = completedClaimAssignments({ ...base, claims: [...complete, { receiptItemId: 'removed', userId: 'alice' }] });
  expect(Object.keys(result!.assignments)).toEqual(['coffee', 'cake']);
});

test('manual corrections and booked expenses are never overwritten', () => {
  expect(completedClaimAssignments({ ...base, claims: complete, manuallyAdjusted: true })).toBeNull();
  expect(completedClaimAssignments({ ...base, claims: complete, editingExpense: true })).toBeNull();
});

test('a single item shared by several members is complete', () => {
  const result = completedClaimAssignments({
    ...base,
    items: [{ id: 'cake', quantity: 1 }],
    claims: [{ receiptItemId: 'cake', userId: 'alice' }, { receiptItemId: 'cake', userId: 'bob' }],
  });
  expect(result?.assignments.cake).toEqual(new Set(['alice', 'bob']));
});
