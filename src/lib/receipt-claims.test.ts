import { expect, test } from 'vitest';
import { claimShare, claimsToAssignments } from './receipt-claims';

const items = [
  { id: 'pizza', totalPrice: 1200 },
  { id: 'wine', totalPrice: 2000 },
  { id: 'water', totalPrice: 800 },
];

test('a shared line is split between everyone who picked it, tax and tip follow the lines', () => {
  const claims = [
    { receiptItemId: 'pizza', userId: 'a' },
    { receiptItemId: 'wine', userId: 'a' },
    { receiptItemId: 'wine', userId: 'b' },
  ];
  // a: 1200 + 1000 = 2200 of 4000 lines; extra 400 -> 220
  expect(claimShare({ items, claims, userId: 'a', extra: 400 })).toBe(2420);
  expect(claimShare({ items, claims, userId: 'b', extra: 400 })).toBe(1100);
  expect(claimShare({ items, claims, userId: 'c', extra: 400 })).toBe(0);
});

test('picks become assignments, people outside the group are left out', () => {
  const result = claimsToAssignments(
    [
      { receiptItemId: 'pizza', userId: 'a' },
      { receiptItemId: 'pizza', userId: 'b' },
      { receiptItemId: 'wine', userId: 'gone' },
    ],
    new Set(['a', 'b']),
  );
  expect(Object.keys(result)).toEqual(['pizza']);
  expect([...result.pizza!]).toEqual(['a', 'b']);
});
