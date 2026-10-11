import { beforeEach, expect, test, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const mocks = vi.hoisted(() => ({
  receipt: {},
  preview: {},
  receiptQuery: vi.fn(),
  previewQuery: vi.fn(),
  invalidateItems: vi.fn(),
  invalidatePreview: vi.fn(),
  correction: vi.fn(),
  recentCurrencies: vi.fn(),
}));
vi.mock('next-intl', () => ({
  useLocale: () => 'de',
  useTranslations: () => Object.assign((key: string) => key, { raw: () => ['Essen'] }),
}));
vi.mock('@/components/expenses/location-field', () => ({ LocationField: () => null }));
vi.mock('@/components/expenses/category-select', () => ({ CategorySelect: () => null }));
vi.mock('@/i18n/navigation', () => ({ Link: () => null }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      receipts: {
        getReceiptItems: { invalidate: mocks.invalidateItems },
        getConversionPreview: { invalidate: mocks.invalidatePreview },
        history: { invalidate: vi.fn() },
      },
    }),
    groups: { recentCurrencies: { useQuery: mocks.recentCurrencies } },
    receipts: {
      getReceiptItems: { useQuery: mocks.receiptQuery },
      getConversionPreview: { useQuery: mocks.previewQuery },
      history: { useQuery: () => ({ data: [] }) },
      getClaims: { useQuery: () => ({ data: undefined }) },
      correctCurrency: { useMutation: mocks.correction },
      ...Object.fromEntries(
        ['assignItemsAndCreateExpense', 'updateItem', 'deleteItem', 'addItem', 'splitItem', 'saveForLater'].map(
          (key) => [key, { useMutation: () => ({ mutate: vi.fn(), isPending: false }) }],
        ),
      ),
    },
  },
}));
import { ItemAssignment } from './item-assignment';
const render = (groupCurrency?: string) =>
  renderToStaticMarkup(
    React.createElement(ItemAssignment, {
      groupId: 'group',
      receiptId: 'receipt',
      members: [{ id: 'user', name: 'User' }],
      onComplete: vi.fn(),
      groupCurrency,
    }),
  );
beforeEach(() => {
  vi.stubGlobal('React', React);
  mocks.receipt = {
    receipt: {
      id: 'receipt',
      paidById: null,
      imagePath: null,
      extractedData: {
        currency: 'EGP',
        date: '2026-10-01',
        merchantName: 'Dinner',
        total: 248338,
        subtotal: 248338,
        tax: 0,
        tip: 0,
        alternateTotals: [],
      },
    },
    items: [{ id: 'item', name: 'Dinner', quantity: 1, totalPrice: 100000, unitPrice: 100000 }],
  };
  mocks.preview = {
    currency: 'EGP',
    euro: {
      from: 'EGP',
      to: 'EUR',
      rate: 0.017,
      source: 'Frankfurter',
      requestedDate: '2026-10-01',
      rateDate: '2026-10-01',
      fetchedAt: Date.parse('2026-10-05T12:00:00Z'),
    },
    groupRate: null,
  };
  mocks.receiptQuery.mockReturnValue({ data: mocks.receipt, isLoading: false });
  mocks.previewQuery.mockReturnValue({ data: mocks.preview, isFetching: false, isError: false });
  mocks.correction.mockReturnValue({ mutate: vi.fn(), isPending: false });
  mocks.recentCurrencies.mockReturnValue({ data: ['EGP'] });
});
test('actual scan assignment requests receipt-bound rates and displays Euro using current item sums instead of stale OCR total', () => {
  const html = render();
  expect(mocks.previewQuery).toHaveBeenLastCalledWith(
    { groupId: 'group', receiptId: 'receipt', useLatestRate: false },
    expect.objectContaining({ staleTime: 0 }),
  );
  expect(html).toContain('Euro-Vorschau');
  expect(html).toContain('17,00');
  expect(html).not.toContain('42,22');
  expect(html).toContain('Belegwährung korrigieren');
  expect(html).toContain('Ändert nur die Währung, nicht die Beträge');
  expect(html).toContain('historischen Kurses vom 2026-10-01');
});
test('currency-correction success invalidates receipt labels and conversion data together', async () => {
  render();
  await mocks.correction.mock.calls.at(-1)![0].onSuccess();
  expect(mocks.invalidateItems).toHaveBeenCalledWith({ receiptId: 'receipt' });
  expect(mocks.invalidatePreview).toHaveBeenCalledWith({ receiptId: 'receipt' });
});
test('malformed OCR currency still renders the correction selector without substituting an amount', () => {
  const data = mocks.receipt as { receipt: { extractedData: { currency: string } } };
  data.receipt.extractedData.currency = 'Egypt pounds';
  const html = render();
  expect(html).toContain('Belegwährung korrigieren');
  expect(html).toContain('1000.00 Egypt pounds');
  expect(html).toContain('Nicht verfügbar');
});
test('incompatible cached source currency is never shown as the current Euro preview', () => {
  mocks.previewQuery.mockReturnValue({
    data: { ...mocks.preview, currency: 'USD' },
    isFetching: false,
    isError: false,
  });
  const html = render();
  expect(html).toContain('Nicht verfügbar');
  expect(html).not.toContain('17,00');
});
test('currency selector lists the group currency first and the trip currency second', () => {
  const html = render('EUR');
  const codes = [...html.matchAll(/<option value="([A-Z]{3})"/g)].map((m) => m[1]);
  expect(codes.slice(0, 3)).toEqual(['EUR', 'EGP', 'USD']);
});
