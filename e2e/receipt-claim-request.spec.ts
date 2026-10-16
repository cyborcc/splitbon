import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { users, login, createTestGroup, trpcMutation, trpcQuery, trpcResult } from './helpers';
import { openUnits } from '../src/lib/receipt-claims';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function mutationResult(res: { json: () => Promise<any> }) {
  const body = await res.json();
  const entry = Array.isArray(body) ? body[0] : body;
  if (entry?.error) throw new Error(JSON.stringify(entry.error));
  return entry?.result?.data?.json;
}

// Uses the mock scan provider, like the correction chat test; never against production.
test('everyone picks their own lines and the organizer gets them automatically', async ({ page }) => {
  test.skip(process.env.E2E_AI_CORRECTION !== '1', 'Requires isolated test server and mock provider; never production');
  test.setTimeout(90_000);
  const { owner, memberContexts, groupId, memberIds, dispose } = await createTestGroup(
    users.alice.email,
    users.alice.password,
    [{ email: users.bob.email, password: users.bob.password }],
    `Claim request ${Date.now()}`,
  );
  const bob = memberContexts[0]!;
  try {
    const uploaded = await owner.post('/api/upload', {
      multipart: {
        file: {
          name: 'claim.png',
          mimeType: 'image/png',
          buffer: readFileSync(resolve('e2e/receipts/coffee-shop.png')),
        },
      },
    });
    const { receiptId } = await uploaded.json();
    await mutationResult(await trpcMutation(owner, 'receipts.processReceipt', { receiptId, groupId }));
    const { items } = await trpcResult(await trpcQuery(owner, 'receipts.getReceiptItems', { receiptId }));
    expect(items.length).toBeGreaterThan(1);

    // Alice asks the group; Bob gets a notification that leads to the picking page
    await login(page, users.alice.email, users.alice.password);
    await page.goto(`/en/groups/${groupId}/scan?receiptId=${receiptId}`);
    await page.locator('#title').fill('Breakfast by the Nile');
    await page.locator('#location').fill('Terrace');
    await page.getByTestId('receipt-date-input').fill('2026-10-12');
    const bobId = memberIds[users.bob.email];
    if (!bobId) throw new Error('Test group is missing Bob');
    await page.getByTestId('paid-by-select').selectOption(bobId);
    await page.getByTestId('tip-input').fill('2.50');
    await page.getByTestId('paid-total-input').fill('100.00');
    await page.getByTestId('start-claim-request-btn').click();
    await expect(page).toHaveURL(new RegExp(`/receipts/${receiptId}/claim`));
    await expect(page.getByTestId('claim-receipt-info')).toContainText('Breakfast by the Nile');
    await expect(page.getByTestId('claim-receipt-info')).toContainText('Terrace');
    const draft = await trpcResult(await trpcQuery(owner, 'receipts.getReceiptItems', { receiptId }));
    expect(draft.receipt.extractedData.receiptDraft).toMatchObject({
      title: 'Breakfast by the Nile', place: { placeName: 'Terrace' },
      tipOverride: '2.50', paidTotalStr: '100.00', useCharged: false, chargedStr: '', useLatestRate: false,
    });
    const bobNotes = await trpcResult(await trpcQuery(bob, 'notifications.list'));
    expect(
      bobNotes.items.some(
        (n: { type: string; entityId: string }) => n.type === 'CLAIM_REQUEST' && n.entityId === receiptId,
      ),
    ).toBe(true);

    // Both pick at the same time; neither overwrites the other
    await Promise.all([
      trpcMutation(owner, 'receipts.setClaim', { receiptItemId: items[0].id, claimed: true }),
      trpcMutation(bob, 'receipts.setClaim', { receiptItemId: items[0].id, claimed: true }),
      trpcMutation(bob, 'receipts.setClaim', { receiptItemId: items[1].id, claimed: true }),
    ]);
    const claims = await trpcResult(await trpcQuery(owner, 'receipts.getClaims', { receiptId }));
    expect(claims.claims).toHaveLength(3);

    // Bob says he is done; the page lists him as done
    await mutationResult(await trpcMutation(bob, 'receipts.finishClaims', { receiptId }));
    const afterFinish = await trpcResult(await trpcQuery(owner, 'receipts.getClaims', { receiptId }));
    expect(afterFinish.done).toContain(memberIds[users.bob.email]);

    // Alice's picking page shows her pick, shared with Bob
    await login(page, users.alice.email, users.alice.password);
    // The request is also reachable without the notification: dashboard and group page list it
    await page.goto('/en/dashboard');
    await expect(page.getByTestId(`open-claim-${receiptId}`)).toBeVisible();
    await page.goto(`/en/groups/${groupId}`);
    await expect(page.getByTestId(`open-claim-${receiptId}`)).toBeVisible();
    await page.goto(`/en/groups/${groupId}/receipts/${receiptId}/claim`);
    const first = page.getByTestId(`claim-item-${items[0].id}`);
    await expect(first).toHaveAttribute('aria-pressed', 'true');
    await expect(first).toContainText('shared by 2');
    await expect(page.getByTestId('claim-my-share')).toContainText(/\d/);
    await expect(page.getByTestId('claim-progress')).toContainText('Done:');

    // Tapping a line picks it for Alice
    const second = page.getByTestId(`claim-item-${items[1].id}`);
    await second.click();
    await expect(second).toHaveAttribute('aria-pressed', 'true');

    // A line of several: Alice takes 2 of 3 with the + button, Bob the third one
    const tacos = items.find((i: { quantity: number }) => i.quantity === 3);
    if (tacos) {
      await page.getByTestId(`claim-item-${tacos.id}`).click();
      await expect(page.getByTestId(`claim-my-units-${tacos.id}`)).toHaveText('1');
      await expect(page.getByTestId(`claim-item-${tacos.id}`)).toContainText(`1× ${tacos.name}`);
      const { formatCents } = await import('../src/lib/money');
      await expect(page.getByTestId(`claim-price-${tacos.id}`)).toHaveText(formatCents(Math.round(tacos.totalPrice / 3), draft.receipt.extractedData.currency, 'en'));
      await page.getByTestId(`claim-units-${tacos.id}`).getByRole('button', { name: 'One more' }).click();
      await expect(page.getByTestId(`claim-my-units-${tacos.id}`)).toHaveText('2');
      await mutationResult(await trpcMutation(bob, 'receipts.setClaim', { receiptItemId: tacos.id, units: 1 }));
      const units = await trpcResult(await trpcQuery(owner, 'receipts.getClaims', { receiptId }));
      const onTacos = units.claims.filter((c: { receiptItemId: string }) => c.receiptItemId === tacos.id);
      expect(onTacos.map((c: { units: number }) => c.units).sort()).toEqual([1, 2]);
    }

    // Cover all remaining units, not just one pick per line. Only then auto-apply is safe.
    const beforeApply = await trpcResult(await trpcQuery(owner, 'receipts.getClaims', { receiptId }));
    const currentClaims = beforeApply.claims as { receiptItemId: string; userId: string; units: number }[];
    for (const item of items as { id: string; quantity: number }[]) {
      const onLine = currentClaims.filter((claim) => claim.receiptItemId === item.id);
      const missing = openUnits(item.quantity, onLine);
      if (missing === 0) continue;
      const mine = onLine.find((claim) => claim.userId === memberIds[users.alice.email])?.units ?? 0;
      await mutationResult(
        await trpcMutation(owner, 'receipts.setClaim', { receiptItemId: item.id, units: mine + missing }),
      );
    }

    // On the receipt, complete picks become assignments without a second Apply action.
    await page.goto(`/en/groups/${groupId}/scan?receiptId=${receiptId}`);
    await expect(page.locator('#title')).toHaveValue('Breakfast by the Nile');
    await expect(page.locator('#location')).toHaveValue('Terrace');
    await expect(page.getByTestId('receipt-date-input')).toHaveValue('2026-10-12');
    await expect(page.getByTestId('paid-by-select')).toHaveValue(bobId);
    await expect(page.getByTestId('paid-total-input')).toHaveValue('100.00');
    await expect(page.getByTestId('claim-status')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('claims-auto-applied')).toContainText("The group's picks are applied automatically");
    await expect(
      page.getByTestId(`item-card-${items[0].id}`).getByTestId(`member-toggle-${memberIds[users.alice.email]}`),
    ).toContainText('✓');
  } finally {
    await dispose();
  }
});
