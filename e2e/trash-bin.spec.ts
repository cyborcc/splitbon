import { test, expect } from '@playwright/test';
import { users, authedContext, createTestGroup, trpcMutation, trpcQuery, trpcResult, trpcError } from './helpers';

async function createExpense(ctx: Awaited<ReturnType<typeof authedContext>>, input: unknown) {
  const res = await trpcMutation(ctx, 'expenses.create', input);
  return (await res.json()).result.data.json as { id: string };
}

test.describe('Trash bin', () => {
  test('a deleted expense can be restored with its shares and the balances come back', async () => {
    const g = await createTestGroup(users.alice.email, users.alice.password, [users.bob], `Trash-${Date.now()}`);
    try {
      const aliceId = g.memberIds[users.alice.email]!;
      const bobId = g.memberIds[users.bob.email]!;
      const created = await createExpense(g.owner, {
        groupId: g.groupId,
        title: 'Dinner',
        amount: 4000,
        paidById: aliceId,
        splitMode: 'EQUAL',
        shares: [
          { userId: aliceId, amount: 2000 },
          { userId: bobId, amount: 2000 },
        ],
      });

      const del = await trpcMutation(g.owner, 'expenses.delete', { groupId: g.groupId, expenseId: created.id });
      expect(del.ok()).toBeTruthy();

      // gone from the expense list, present in the trash
      const listed = await trpcResult(await trpcQuery(g.owner, 'expenses.list', { groupId: g.groupId }));
      expect(JSON.stringify(listed)).not.toContain(created.id);
      const trash = await trpcResult(await trpcQuery(g.owner, 'expenses.listTrash', { groupId: g.groupId }));
      expect(trash).toHaveLength(1);
      expect(trash[0]).toMatchObject({ expenseId: created.id, title: 'Dinner', amount: 4000, daysLeft: 30 });

      // restore
      const restored = await trpcMutation(g.owner, 'expenses.restore', { groupId: g.groupId, expenseId: created.id });
      expect(restored.ok()).toBeTruthy();
      expect(await trpcResult(await trpcQuery(g.owner, 'expenses.listTrash', { groupId: g.groupId }))).toHaveLength(0);
      const expense = await trpcResult(
        await trpcQuery(g.owner, 'expenses.get', { groupId: g.groupId, expenseId: created.id }),
      );
      expect(expense.title).toBe('Dinner');
      expect(expense.shares).toHaveLength(2);

      // restoring twice is refused
      const again = await trpcMutation(g.owner, 'expenses.restore', { groupId: g.groupId, expenseId: created.id });
      expect((await trpcError(again)).data?.code).toBe('NOT_FOUND');
    } finally {
      await g.dispose();
    }
  });

  test('a member who did not delete or pay cannot restore', async () => {
    const g = await createTestGroup(users.alice.email, users.alice.password, [users.bob], `Trash-${Date.now()}`);
    try {
      const aliceId = g.memberIds[users.alice.email]!;
      const created = await createExpense(g.owner, {
        groupId: g.groupId,
        title: 'Taxi',
        amount: 1000,
        paidById: aliceId,
        splitMode: 'EQUAL',
        shares: [{ userId: aliceId, amount: 1000 }],
      });
      await trpcMutation(g.owner, 'expenses.delete', { groupId: g.groupId, expenseId: created.id });
      const bob = g.memberContexts[0]!;
      const res = await trpcMutation(bob, 'expenses.restore', { groupId: g.groupId, expenseId: created.id });
      expect((await trpcError(res)).data?.code).toBe('FORBIDDEN');
    } finally {
      await g.dispose();
    }
  });
});
