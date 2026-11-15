import { expect, test, vi } from 'vitest';
import { startSavedClaimRequest } from './receipt-claim-request';

test('the request waits until the current title and place draft is saved', async () => {
  let resolveSave!: () => void;
  const save = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
  );
  const start = vi.fn(async () => undefined);
  const result = startSavedClaimRequest(save, start);
  expect(save).toHaveBeenCalledOnce();
  expect(start).not.toHaveBeenCalled();
  resolveSave();
  await result;
  expect(start).toHaveBeenCalledOnce();
});

test('a failed save prevents the request and leaves the form available', async () => {
  const start = vi.fn(async () => undefined);
  await expect(
    startSavedClaimRequest(async () => {
      throw new Error('Save failed');
    }, start),
  ).rejects.toThrow('Save failed');
  expect(start).not.toHaveBeenCalled();
});

test('request failures are reported after preserving the draft', async () => {
  const save = vi.fn(async () => undefined);
  await expect(
    startSavedClaimRequest(save, async () => {
      throw new Error('Request failed');
    }),
  ).rejects.toThrow('Request failed');
  expect(save).toHaveBeenCalledOnce();
});
