import { expect, test } from 'vitest';
import { claimShare, claimsToAssignments, openUnits } from './receipt-claims';

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

test('units decide how a line of several is split', () => {
  const beer = [{ id: 'beer', totalPrice: 1500 }];
  const claims = [
    { receiptItemId: 'beer', userId: 'a', units: 2 },
    { receiptItemId: 'beer', userId: 'b', units: 1 },
  ];
  expect(claimShare({ items: beer, claims, userId: 'a', extra: 0 })).toBe(1000);
  expect(claimShare({ items: beer, claims, userId: 'b', extra: 0 })).toBe(500);
});

test('a line is open until its units are picked', () => {
  expect(openUnits(1, [])).toBe(1);
  expect(openUnits(1, [{ units: 1 }, { units: 1 }])).toBe(0);
  expect(openUnits(3, [{ units: 2 }])).toBe(1);
  expect(openUnits(3, [{ units: 2 }, { units: 1 }])).toBe(0);
  expect(openUnits(3, [{ units: 5 }])).toBe(0);
});

test('picks become assignments and units, people outside the group are left out', () => {
  const { assignments, counts } = claimsToAssignments(
    [
      { receiptItemId: 'pizza', userId: 'a', units: 2 },
      { receiptItemId: 'pizza', userId: 'b', units: 1 },
      { receiptItemId: 'wine', userId: 'gone' },
    ],
    new Set(['a', 'b']),
  );
  expect(Object.keys(assignments)).toEqual(['pizza']);
  expect([...assignments.pizza!]).toEqual(['a', 'b']);
  expect(counts).toEqual({ pizza: { a: 2 } });
});
