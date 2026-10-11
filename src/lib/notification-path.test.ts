import { expect, test } from 'vitest';
import { notificationPath } from './notification-path';

test('each kind of notification opens its page', () => {
  expect(notificationPath('EXPENSE_ADDED', 'g', 'e')).toBe('/groups/g/expenses/e');
  expect(notificationPath('SETTLEMENT', 'g', 's')).toBe('/groups/g');
  expect(notificationPath('CLAIM_REQUEST', 'g', 'r')).toBe('/groups/g/receipts/r/claim');
  expect(notificationPath('CLAIMS_OPEN', 'g', 'r')).toBe('/groups/g/receipts/r/claim');
  expect(notificationPath('PRICE_CHANGED', 'g', null)).toBe('/groups/g');
  expect(notificationPath('EXPENSE_ADDED', null, 'e')).toBe('/notifications');
});
