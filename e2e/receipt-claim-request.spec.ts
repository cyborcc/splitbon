import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { users, login, createTestGroup, trpcMutation, trpcQuery, trpcResult } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function mutationResult(res: { json: () => Promise<any> }) {
  const body = await res.json();
  const entry = Array.isArray(body) ? body[0] : body;
  if (entry?.error) throw new Error(JSON.stringify(entry.error));
  return entry?.result?.data?.json;
}

// Uses the mock scan provider, like the correction chat test; never against production.
test('everyone picks their own lines, the organizer applies the picks', async ({ page }) => {
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
    const started = await mutationResult(await trpcMutation(owner, 'receipts.startClaimRequest', { receiptId }));
    expect(started.notified).toBe(1);
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
      await page.getByTestId(`claim-units-${tacos.id}`).getByRole('button', { name: 'One more' }).click();
      await expect(page.getByTestId(`claim-my-units-${tacos.id}`)).toHaveText('2');
      await mutationResult(await trpcMutation(bob, 'receipts.setClaim', { receiptItemId: tacos.id, units: 1 }));
      const units = await trpcResult(await trpcQuery(owner, 'receipts.getClaims', { receiptId }));
      const onTacos = units.claims.filter((c: { receiptItemId: string }) => c.receiptItemId === tacos.id);
      expect(onTacos.map((c: { units: number }) => c.units).sort()).toEqual([1, 2]);
    }

    // On the receipt, the picks become the assignment
    await page.goto(`/en/groups/${groupId}/scan?receiptId=${receiptId}`);
    await expect(page.getByTestId('claim-status')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('apply-claims-btn').click();
    await expect(page.getByText("The group's picks were applied")).toBeVisible();
  } finally {
    await dispose();
  }
});
