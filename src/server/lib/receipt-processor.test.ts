import { beforeEach, describe, expect, test, vi } from 'vitest';

const mockGetAIProvidersWithFallback = vi.fn();
const mockClearProviderCache = vi.fn();

vi.mock('../ai/registry', () => ({
  getAIProvidersWithFallback: mockGetAIProvidersWithFallback,
  clearProviderCache: mockClearProviderCache,
}));

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./upload-dir', () => ({
  getUploadDir: () => '/tmp/uploads',
  resolveUploadPath: (relativePath: string) => `/tmp/uploads/${relativePath}`,
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from('fake-image')),
}));

describe('processReceiptImage fallback behavior', () => {
  beforeEach(() => {
    vi.resetModules();
    mockGetAIProvidersWithFallback.mockReset();
    mockClearProviderCache.mockReset();
  });

  function makeDbMock() {
    const db = {
      receiptItem: {
        deleteMany: vi.fn().mockResolvedValue(undefined),
        createMany: vi.fn().mockResolvedValue(undefined),
      },
      receipt: {
        update: vi.fn().mockResolvedValue(undefined),
      },
      // Interactive transaction: run the callback against the same mock
      $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(db)),
    };
    return db;
  }

  const successResult = {
    merchantName: 'Store',
    date: '2026-04-13',
    subtotal: 1000,
    tax: 80,
    tip: 0,
    total: 1080,
    currency: 'USD',
    items: [{ name: 'Item', quantity: 1, unitPrice: 1080, totalPrice: 1080 }],
  };

  test('falls back to next provider when first extraction fails', async () => {
    const provider1 = {
      name: 'openai-codex',
      extractReceipt: vi.fn().mockRejectedValue(new Error('expired')),
    };
    const provider2 = {
      name: 'openai',
      extractReceipt: vi.fn().mockResolvedValue(successResult),
    };
    mockGetAIProvidersWithFallback.mockResolvedValue([provider1, provider2]);

    const { processReceiptImage } = await import('./receipt-processor');
    const db = makeDbMock();

    await processReceiptImage({
      db: db as never,
      receiptId: 'r1',
      receipt: { imagePath: 'r1.jpg', mimeType: 'image/jpeg' },
    });

    expect(provider1.extractReceipt).toHaveBeenCalledTimes(1);
    expect(provider2.extractReceipt).toHaveBeenCalledTimes(1);
    expect(db.receipt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ aiProvider: 'openai' }),
      }),
    );
    expect(mockClearProviderCache).not.toHaveBeenCalled();
  });

  test('clears provider cache and retries provider list on first full-pass failure', async () => {
    const badProvider = {
      name: 'openai-codex',
      extractReceipt: vi.fn().mockRejectedValue(new Error('auth expired')),
    };
    const recoveredProvider = {
      name: 'openai-codex',
      extractReceipt: vi.fn().mockResolvedValue(successResult),
    };

    mockGetAIProvidersWithFallback.mockResolvedValueOnce([badProvider]).mockResolvedValueOnce([recoveredProvider]);

    const { processReceiptImage } = await import('./receipt-processor');
    const db = makeDbMock();

    await processReceiptImage({
      db: db as never,
      receiptId: 'r2',
      receipt: { imagePath: 'r2.jpg', mimeType: 'image/jpeg' },
    });

    expect(mockGetAIProvidersWithFallback).toHaveBeenCalledTimes(2);
    expect(mockClearProviderCache).toHaveBeenCalledTimes(1);
    expect(recoveredProvider.extractReceipt).toHaveBeenCalledTimes(1);
  });

  test('throws after both fallback passes fail', async () => {
    const badProvider = {
      name: 'openai-codex',
      extractReceipt: vi.fn().mockRejectedValue(new Error('still expired')),
    };
    mockGetAIProvidersWithFallback.mockResolvedValue([badProvider]);

    const { processReceiptImage } = await import('./receipt-processor');
    const db = makeDbMock();

    await expect(
      processReceiptImage({
        db: db as never,
        receiptId: 'r3',
        receipt: { imagePath: 'r3.jpg', mimeType: 'image/jpeg' },
      }),
    ).rejects.toThrow('Receipt extraction failed across configured providers');

    expect(mockClearProviderCache).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['2024-03-01', { photoCapturedDate: '2024-02-29' }, '2024-03-01', 'printed'],
    ['2023-02-29', { photoCapturedDate: '2024-02-29' }, '2024-02-29', 'exif'],
    [undefined, {}, '2026-10-05', 'upload'],
    [
      '2024-03-01',
      { date: '2024-03-10', dateSource: 'manual', photoCapturedDate: '2024-02-29' },
      '2024-03-10',
      'manual',
    ],
  ])('processing persists date precedence (%s)', async (printed, metadata, expected, source) => {
    mockGetAIProvidersWithFallback.mockResolvedValue([
      { name: 'test', extractReceipt: vi.fn().mockResolvedValue({ ...successResult, date: printed }) },
    ]);
    const { processReceiptImage } = await import('./receipt-processor');
    const db = makeDbMock();
    const result = await processReceiptImage({
      db: db as never,
      receiptId: 'r',
      receipt: {
        imagePath: 'r.jpg',
        mimeType: 'image/jpeg',
        extractedData: metadata,
        createdAt: new Date('2026-10-05T12:00:00Z'),
      },
    });
    expect(result.date).toBe(expected);
    expect(db.receipt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          extractedData: expect.objectContaining({ date: expected, dateSource: source }),
        }),
      }),
    );
  });
  test.each([
    // [case, items, subtotal, tax, tip, total, expected tax, expected subtotal]
    ['gross prices with a VAT summary', [2000, 1150], 3150, 414, 0, 3150, 0, 3150],
    ['gross prices, net subtotal read', [2000, 1150], 2736, 414, 0, 3150, 0, 3150],
    ['gross prices plus a tip', [4000], 4000, 667, 400, 4400, 0, 4000],
    ['one cent of rounding', [3149], 3149, 414, 0, 3150, 0, 3149],
    ['net prices with sales tax on top', [1000], 1000, 80, 0, 1080, 80, 1000],
    ['no printed total', [3150], 3150, 414, 0, 0, 414, 3150],
    ['a missed line', [2800], 2800, 414, 0, 3150, 414, 2800],
    ['no tax', [3150], 3150, 0, 0, 3150, 0, 3150],
  ])('dropIncludedTax: %s', async (_name, prices, subtotal, tax, tip, total, expectedTax, expectedSubtotal) => {
    const { dropIncludedTax } = await import('./receipt-processor');
    const result = dropIncludedTax({ items: prices.map((totalPrice) => ({ totalPrice })), subtotal, tax, tip, total });
    expect(result.tax).toBe(expectedTax);
    expect(result.subtotal).toBe(expectedSubtotal);
  });

  test('processing stores tax 0 when the items already add up to the printed total', async () => {
    // successResult: items 1080 = total 1080, with 80 of VAT printed for information
    mockGetAIProvidersWithFallback.mockResolvedValue([
      { name: 'test', extractReceipt: vi.fn().mockResolvedValue(successResult) },
    ]);
    const { processReceiptImage } = await import('./receipt-processor');
    const db = makeDbMock();
    const result = await processReceiptImage({
      db: db as never,
      receiptId: 'r',
      receipt: { imagePath: 'r.jpg', mimeType: 'image/jpeg' },
    });
    expect(result).toMatchObject({ tax: 0, subtotal: 1080, total: 1080 });
    expect(db.receipt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          extractedData: expect.objectContaining({ tax: 0, subtotal: 1080, total: 1080 }),
        }),
      }),
    );
  });
});
