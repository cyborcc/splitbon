import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { Prisma } from '@/generated/prisma/client';
import type { PrismaClient } from '@/generated/prisma/client';
import { createTRPCRouter, protectedProcedure, groupMemberProcedure } from '../init';
import { processReceiptImage } from '../../lib/receipt-processor';
import { logger } from '../../lib/logger';
import { parseExtractedData } from '../../lib/json-schemas';
import { getAIProvidersWithFallback, getConfiguredProviderPriority, getSelectableModels } from '@/server/ai/registry';
import { convertCents, isValidCurrency, type RateQuote } from '../../lib/exchange-rates';
import { getReceiptRate, relabelReceiptCurrency } from '../../lib/receipt-conversion';
import { previewReceiptCorrection, resolveReceiptCorrection } from '../../lib/receipt-correction';
import { stripUndefined } from '../../lib/strip-undefined';
import { getUserPromptLanguage } from '../../lib/user-language';
import { money, sendNotifications, shareChangeItems } from '../../lib/notifications';
import { checkRateLimit } from '../../lib/rate-limit';

/**
 * Verify that a receipt exists and the user has access to it (via group membership).
 * When additional `include` fields are passed, the return type is widened since
 * Prisma cannot statically infer dynamic includes -- callers should cast as needed.
 */
async function verifyReceiptAccess(
  db: PrismaClient,
  receiptId: string,
  userId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  include?: Record<string, any>,
) {
  const receipt = await db.receipt.findUnique({
    where: { id: receiptId },
    include: { group: { include: { members: true } }, ...include },
  });
  if (!receipt) throw new TRPCError({ code: 'NOT_FOUND' });
  if (receipt.group) {
    const isMember = receipt.group.members.some((m: { userId: string }) => m.userId === userId);
    if (!isMember) throw new TRPCError({ code: 'FORBIDDEN' });
  } else {
    // Ungrouped receipt: only the uploader can access it
    if (receipt.uploadedById !== userId) {
      throw new TRPCError({ code: 'FORBIDDEN' });
    }
  }
  return receipt;
}

/**
 * Records a change of receipt lines for the receipt's history. Only receipts of a group have
 * one; the activity points at the receipt so the history can be read without a JSON filter.
 */
async function logReceiptChange(
  db: Pick<PrismaClient, 'activityLog'>,
  receipt: { id: string; groupId: string | null },
  userId: string,
  change: Record<string, unknown>,
) {
  if (!receipt.groupId) return;
  await db.activityLog.create({
    data: {
      groupId: receipt.groupId,
      userId,
      type: 'RECEIPT_ITEMS_CHANGED',
      entityId: receipt.id,
      metadata: { receiptId: receipt.id, ...change } as Prisma.InputJsonValue,
    },
  });
}

/** Members who can pick: real accounts, not placeholders (they never open the app). */
async function realMemberIds(db: PrismaClient, memberIds: string[]): Promise<string[]> {
  const users = await db.user.findMany({
    where: { id: { in: memberIds }, isPlaceholder: false },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

/**
 * After a pick or someone finishing: tells everyone once when every line has someone ("ready to book"),
 * or once when everyone is done but lines are left. Each message goes out only once per request; the
 * marker is set with a conditional update, so two people finishing at the same moment send one message.
 */
async function checkClaimProgress(db: PrismaClient, receiptId: string, actorId: string) {
  const receipt = await db.receipt.findUnique({
    where: { id: receiptId },
    select: {
      id: true,
      groupId: true,
      originalName: true,
      extractedData: true,
      claimRequestedAt: true,
      group: { select: { members: { select: { userId: true } } } },
      items: { select: { id: true, claims: { select: { userId: true }, take: 1 } } },
      claimsDone: { select: { userId: true } },
    },
  });
  if (!receipt?.groupId || !receipt.group || !receipt.claimRequestedAt || receipt.items.length === 0) return;
  const open = receipt.items.filter((i) => i.claims.length === 0).length;
  const members = await realMemberIds(
    db,
    receipt.group.members.map((m) => m.userId),
  );
  const done = new Set(receipt.claimsDone.map((d) => d.userId));
  const title =
    (receipt.extractedData ? parseExtractedData(receipt.extractedData)?.merchantName?.trim() : '') ||
    receipt.originalName;

  let kind: 'CLAIMS_COMPLETE' | 'CLAIMS_OPEN' | null = null;
  if (open === 0) {
    const marked = await db.receipt.updateMany({
      where: { id: receipt.id, claimsCompleteNotifiedAt: null },
      data: { claimsCompleteNotifiedAt: new Date() },
    });
    if (marked.count === 1) kind = 'CLAIMS_COMPLETE';
  } else if (members.length > 0 && members.every((id) => done.has(id))) {
    const marked = await db.receipt.updateMany({
      where: { id: receipt.id, claimsOpenNotifiedAt: null },
      data: { claimsOpenNotifiedAt: new Date() },
    });
    if (marked.count === 1) kind = 'CLAIMS_OPEN';
  }
  if (!kind) return;
  await sendNotifications(
    db,
    members
      .filter((id) => id !== actorId)
      .map((userId) => ({
        userId,
        kind: kind!,
        groupId: receipt.groupId!,
        entityId: receipt.id,
        vars: { actor: '', title, count: open },
      })),
  );
}

type Units = Record<string, number>; // userId -> units of a line

function sameUnits(a: Units, b: Units): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

export const receiptsRouter = createTRPCRouter({
  previewCorrection: protectedProcedure
    .input(
      z
        .object({
          receiptId: z.string().max(100),
          groupId: z.string().max(100),
          correctionHint: z.string().trim().min(1).max(500),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      previewReceiptCorrection(ctx.db, input.receiptId, input.groupId, ctx.user.id, input.correctionHint),
    ),
  confirmCorrection: protectedProcedure
    .input(
      z.object({ receiptId: z.string().max(100), groupId: z.string().max(100), token: z.string().uuid() }).strict(),
    )
    .mutation(({ ctx, input }) =>
      resolveReceiptCorrection(ctx.db, input.receiptId, input.groupId, ctx.user.id, input.token, true),
    ),
  discardCorrection: protectedProcedure
    .input(
      z.object({ receiptId: z.string().max(100), groupId: z.string().max(100), token: z.string().uuid() }).strict(),
    )
    .mutation(({ ctx, input }) =>
      resolveReceiptCorrection(ctx.db, input.receiptId, input.groupId, ctx.user.id, input.token, false),
    ),
  getScanProviderInfo: protectedProcedure.query(async () => {
    try {
      const configured = getConfiguredProviderPriority();
      const [active] = await getAIProvidersWithFallback();
      return {
        configuredProviders: configured,
        activeProvider: active?.name ?? null,
        // models a user can pick per scan; the first is the default
        models: getSelectableModels(),
      };
    } catch {
      // Keep response shape stable even if provider checks fail.
      return {
        configuredProviders: [],
        activeProvider: null,
        models: [] as string[],
      };
    }
  }),

  processReceipt: protectedProcedure
    .input(
      z.object({
        receiptId: z.string(),
        groupId: z.string().optional(),
        correctionHint: z.string().max(500).optional(),
        model: z.string().max(100).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const receipt = await verifyReceiptAccess(ctx.db, input.receiptId, ctx.user.id);
      if (!receipt) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Receipt not found' });
      }

      if (input.correctionHint !== undefined) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Use previewCorrection and confirmCorrection for corrections.',
        });
      }
      if (input.model && !getSelectableModels().includes(input.model)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'This model is not available.' });
      }
      if (await ctx.db.expense.findUnique({ where: { receiptId: input.receiptId } })) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Finalized receipts cannot be reprocessed.' });
      }

      if (input.groupId) {
        const membership = await ctx.db.groupMember.findUnique({
          where: {
            userId_groupId: {
              userId: ctx.user.id,
              groupId: input.groupId,
            },
          },
        });
        if (!membership) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Not a member of this group' });
        }
      }

      // Note: old items are NOT deleted here — processReceiptImage handles
      // delete + recreate atomically, so if the AI provider fails the old items remain.

      // Conditional update doubles as a mutex: a receipt already PROCESSING
      // is rejected so concurrent calls can't interleave delete/recreate.
      // A PROCESSING receipt untouched for 15+ minutes is considered stale
      // (crashed run) and may be re-claimed. The threshold deliberately
      // exceeds the worst-case provider pipeline (2 passes x per-provider
      // timeouts of 30-120s) so a slow-but-live run is never re-claimed.
      const claimed = await ctx.db.receipt.updateMany({
        where: {
          id: input.receiptId,
          OR: [{ status: { not: 'PROCESSING' } }, { updatedAt: { lt: new Date(Date.now() - 15 * 60 * 1000) } }],
        },
        data: {
          status: 'PROCESSING',
          ...(input.groupId ? { groupId: input.groupId, savedById: ctx.user.id } : {}),
        },
      });
      if (claimed.count === 0) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Receipt is already being processed',
        });
      }

      const language = await getUserPromptLanguage(ctx.db, ctx.user.id);
      try {
        return await processReceiptImage({
          db: ctx.db,
          receiptId: input.receiptId,
          receipt,
          ...(input.correctionHint !== undefined ? { correctionHint: input.correctionHint } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(language ? { language } : {}),
          logPrefix: 'receipt',
        });
      } catch (error) {
        logger.error('receipt.failed', {
          receiptId: input.receiptId,
          error: error instanceof Error ? error.message : 'Unknown',
        });
        await ctx.db.receipt.update({
          where: { id: input.receiptId },
          data: {
            status: 'FAILED',
            rawResponse: {
              error: error instanceof Error ? error.message : 'Unknown error',
            } as unknown as Prisma.InputJsonValue,
          },
        });

        // Details are logged and stored in rawResponse; don't echo raw
        // provider/internal errors to the client.
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Receipt processing failed. Please try again.',
        });
      }
    }),

  getReceiptItems: protectedProcedure.input(z.object({ receiptId: z.string() })).query(async ({ ctx, input }) => {
    const receipt = await verifyReceiptAccess(ctx.db, input.receiptId, ctx.user.id, {
      items: {
        orderBy: { sortOrder: 'asc' },
        include: { assignments: true },
      },
    });

    type ReceiptItem = {
      id: string;
      name: string;
      quantity: number;
      unitPrice: number;
      totalPrice: number;
      sortOrder: number;
      assignments: { id: string; receiptItemId: string; userId: string; shareOfItem: number }[];
    };

    const receiptWithItems = receipt as typeof receipt & { items: ReceiptItem[] };

    return {
      receipt: {
        id: receiptWithItems.id,
        status: receiptWithItems.status,
        imagePath: receiptWithItems.imagePath,
        paidById: receiptWithItems.paidById,
        aiProvider: receiptWithItems.aiProvider,
        extractedData: receiptWithItems.extractedData ? parseExtractedData(receiptWithItems.extractedData) : null,
      },
      items: receiptWithItems.items as ReceiptItem[],
    };
  }),

  getConversionPreview: groupMemberProcedure
    .input(z.object({ groupId: z.string(), receiptId: z.string(), useLatestRate: z.boolean().default(false) }))
    .query(async ({ ctx, input }) => {
      const receipt = await verifyReceiptAccess(ctx.db, input.receiptId, ctx.user.id);
      if (receipt.groupId && receipt.groupId !== input.groupId) throw new TRPCError({ code: 'FORBIDDEN' });
      const data = parseExtractedData(receipt.extractedData);
      const group = await ctx.db.group.findUniqueOrThrow({ where: { id: input.groupId }, select: { currency: true } });
      const euro = await getReceiptRate(data, 'EUR', input.useLatestRate, ctx.db);
      const groupRate =
        group.currency.toUpperCase() === 'EUR'
          ? euro
          : await getReceiptRate(data, group.currency, input.useLatestRate, ctx.db);
      return { euro, groupRate, currency: data.currency, receiptDate: data.date?.slice(0, 10) ?? null };
    }),

  correctCurrency: protectedProcedure
    .input(z.object({ receiptId: z.string(), currency: z.string().refine(isValidCurrency) }))
    .mutation(async ({ ctx, input }) => {
      await verifyReceiptAccess(ctx.db, input.receiptId, ctx.user.id);
      await ctx.db.$transaction(async (tx) => {
        const receipt = await tx.receipt.findUniqueOrThrow({ where: { id: input.receiptId } });
        if (
          receipt.status !== 'COMPLETED' ||
          (await tx.expense.findUnique({ where: { receiptId: input.receiptId } }))
        ) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Only unlinked, completed receipts can be corrected.' });
        }
        const data = relabelReceiptCurrency(parseExtractedData(receipt.extractedData), input.currency);
        // Conditional write refuses a rescan/edit that raced this correction.
        const updated = await tx.receipt.updateMany({
          where: { id: receipt.id, updatedAt: receipt.updatedAt, status: 'COMPLETED' },
          data: { extractedData: data as unknown as Prisma.InputJsonValue },
        });
        if (updated.count !== 1)
          throw new TRPCError({ code: 'CONFLICT', message: 'Receipt changed. Reload and try again.' });
      });
      return { success: true };
    }),

  updateItem: protectedProcedure
    .input(
      z.object({
        itemId: z.string(),
        name: z.string().min(1).max(200).optional(),
        quantity: z.number().int().min(1).optional(),
        unitPrice: z.number().int().min(0).optional(),
        totalPrice: z.number().int().min(0).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const item = await ctx.db.receiptItem.findUnique({
        where: { id: input.itemId },
      });
      if (!item) throw new TRPCError({ code: 'NOT_FOUND' });
      const receipt = await verifyReceiptAccess(ctx.db, item.receiptId, ctx.user.id);

      const { itemId, ...data } = input;
      const updated = await ctx.db.receiptItem.update({
        where: { id: itemId },
        data: stripUndefined(data),
      });
      const before = { name: item.name, quantity: item.quantity, totalPrice: item.totalPrice };
      const after = { name: updated.name, quantity: updated.quantity, totalPrice: updated.totalPrice };
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        await logReceiptChange(ctx.db, receipt, ctx.user.id, {
          action: 'update',
          itemId,
          itemName: updated.name,
          before,
          after,
        });
      }
      return updated;
    }),

  addItem: protectedProcedure
    .input(
      z.object({
        receiptId: z.string(),
        name: z.string().min(1).max(200),
        quantity: z.number().int().min(1).default(1),
        unitPrice: z.number().int().min(0),
        totalPrice: z.number().int().min(0),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const receipt = await verifyReceiptAccess(ctx.db, input.receiptId, ctx.user.id);

      const maxSort = await ctx.db.receiptItem.findFirst({
        where: { receiptId: input.receiptId },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });
      const created = await ctx.db.receiptItem.create({
        data: {
          receiptId: input.receiptId,
          name: input.name,
          quantity: input.quantity,
          unitPrice: input.unitPrice,
          totalPrice: input.totalPrice,
          sortOrder: (maxSort?.sortOrder ?? 0) + 1,
        },
      });
      await logReceiptChange(ctx.db, receipt, ctx.user.id, {
        action: 'add',
        itemId: created.id,
        itemName: created.name,
        after: { name: created.name, quantity: created.quantity, totalPrice: created.totalPrice },
      });
      return created;
    }),

  deleteItem: protectedProcedure.input(z.object({ itemId: z.string() })).mutation(async ({ ctx, input }) => {
    const item = await ctx.db.receiptItem.findUnique({
      where: { id: input.itemId },
    });
    if (!item) throw new TRPCError({ code: 'NOT_FOUND' });
    const receipt = await verifyReceiptAccess(ctx.db, item.receiptId, ctx.user.id);

    await ctx.db.receiptItemAssignment.deleteMany({
      where: { receiptItemId: input.itemId },
    });
    await ctx.db.receiptItem.delete({ where: { id: input.itemId } });
    await logReceiptChange(ctx.db, receipt, ctx.user.id, {
      action: 'delete',
      itemId: input.itemId,
      itemName: item.name,
      before: { name: item.name, quantity: item.quantity, totalPrice: item.totalPrice },
    });
    return { success: true };
  }),

  splitItem: protectedProcedure
    .input(
      z.object({
        itemId: z.string(),
        splitQuantity: z.number().int().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const item = await ctx.db.receiptItem.findUnique({
        where: { id: input.itemId },
      });
      if (!item) throw new TRPCError({ code: 'NOT_FOUND' });
      const receipt = await verifyReceiptAccess(ctx.db, item.receiptId, ctx.user.id);

      if (input.splitQuantity >= item.quantity) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Split quantity must be less than total quantity',
        });
      }

      return ctx.db.$transaction(async (tx) => {
        const current = await tx.receiptItem.findUniqueOrThrow({
          where: { id: input.itemId },
        });

        if (input.splitQuantity >= current.quantity) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Split quantity must be less than total quantity',
          });
        }

        const maxNewTotal = current.totalPrice - 1;
        if (maxNewTotal <= 0) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Item price too low to split',
          });
        }

        const newTotalPrice = Math.min(current.unitPrice * input.splitQuantity, maxNewTotal);
        const remainingQuantity = current.quantity - input.splitQuantity;
        const remainingTotalPrice = current.totalPrice - newTotalPrice;

        if (newTotalPrice <= 0 || remainingTotalPrice <= 0) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Split would result in invalid price distribution',
          });
        }

        await tx.receiptItem.updateMany({
          where: {
            receiptId: current.receiptId,
            sortOrder: { gt: current.sortOrder },
          },
          data: { sortOrder: { increment: 1 } },
        });

        await tx.receiptItem.update({
          where: { id: input.itemId },
          data: {
            quantity: remainingQuantity,
            totalPrice: remainingTotalPrice,
          },
        });

        const created = await tx.receiptItem.create({
          data: {
            receiptId: current.receiptId,
            name: current.name,
            quantity: input.splitQuantity,
            unitPrice: current.unitPrice,
            totalPrice: newTotalPrice,
            sortOrder: current.sortOrder + 1,
          },
        });
        await logReceiptChange(tx, receipt, ctx.user.id, {
          action: 'split',
          itemId: current.id,
          newItemId: created.id,
          itemName: current.name,
          quantity: input.splitQuantity,
          of: current.quantity,
        });
        return created;
      });
    }),

  updateExtractedData: protectedProcedure
    .input(
      z.object({
        receiptId: z.string(),
        tax: z.number().int().min(0).optional(),
        tip: z.number().int().min(0).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const receipt = await verifyReceiptAccess(ctx.db, input.receiptId, ctx.user.id);

      const current = (receipt.extractedData ?? {}) as Record<string, unknown>;
      const updated = {
        ...current,
        ...(input.tax !== undefined ? { tax: input.tax } : {}),
        ...(input.tip !== undefined ? { tip: input.tip } : {}),
      };

      await ctx.db.receipt.update({
        where: { id: input.receiptId },
        data: { extractedData: updated as unknown as Prisma.InputJsonValue },
      });
      return { success: true };
    }),

  retryProcessing: protectedProcedure.input(z.object({ receiptId: z.string() })).mutation(async ({ ctx, input }) => {
    const receipt = await verifyReceiptAccess(ctx.db, input.receiptId, ctx.user.id);

    // Reset status to PROCESSING and re-run extraction; conditional update
    // rejects concurrent reprocessing of the same receipt. A PROCESSING
    // receipt untouched for 15+ minutes is stale and may be re-claimed
    // (threshold exceeds the worst-case provider pipeline duration).
    const claimed = await ctx.db.receipt.updateMany({
      where: {
        id: input.receiptId,
        OR: [{ status: { not: 'PROCESSING' } }, { updatedAt: { lt: new Date(Date.now() - 15 * 60 * 1000) } }],
      },
      data: { status: 'PROCESSING' },
    });
    if (claimed.count === 0) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Receipt is already being processed',
      });
    }

    const language = await getUserPromptLanguage(ctx.db, ctx.user.id);
    try {
      return await processReceiptImage({
        db: ctx.db,
        receiptId: input.receiptId,
        receipt: { imagePath: receipt.imagePath, mimeType: receipt.mimeType },
        ...(language ? { language } : {}),
        logPrefix: 'receipt.retry',
      });
    } catch (error) {
      await ctx.db.receipt.update({
        where: { id: input.receiptId },
        data: {
          status: 'FAILED',
          rawResponse: {
            error: error instanceof Error ? error.message : 'Unknown error',
          } as unknown as Prisma.InputJsonValue,
        },
      });
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Reprocessing failed',
      });
    }
  }),

  assignItemsAndCreateExpense: groupMemberProcedure
    .input(
      z.object({
        groupId: z.string(),
        receiptId: z.string(),
        title: z.string().min(1).max(200),
        paidById: z.string(),
        placeName: z.string().max(200).optional(),
        category: z.string().max(50).optional(),
        latitude: z.number().min(-90).max(90).optional(),
        longitude: z.number().min(-180).max(180).optional(),
        useLatestRate: z.boolean().default(false),
        expectedConversion: z
          .object({
            rate: z.number().positive().finite(),
            source: z.string(),
            rateDate: z.string(),
            requestedDate: z.string().nullable(),
          })
          .optional(),
        tipOverride: z.number().int().min(0).optional(),
        // What the card was actually charged, in group currency cents (replaces the reference rate)
        chargedAmount: z.number().int().positive().max(100_000_000).optional(),
        // Set when an expense that was already created from this receipt is edited: the
        // expense, its shares and the item assignments are replaced instead of created.
        expenseId: z.string().optional(),
        assignments: z.array(
          z
            .object({
              receiptItemId: z.string(),
              userIds: z.array(z.string()).min(1),
              // how many units of the line each person has, aligned with userIds (default 1 each)
              weights: z.array(z.number().int().min(1).max(99)).optional(),
            })
            .refine((a) => !a.weights || a.weights.length === a.userIds.length, {
              message: 'weights must match userIds',
            }),
        ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Verify group is not archived
      const group = await ctx.db.group.findUnique({ where: { id: input.groupId } });
      if (group?.archivedAt) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot create expenses in archived groups' });
      }

      const receipt = await ctx.db.receipt.findUnique({
        where: { id: input.receiptId },
        include: { items: { include: { assignments: true } } },
      });
      if (!receipt || receipt.status !== 'COMPLETED') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Receipt not ready' });
      }

      // Verify the caller has access to this receipt
      if (receipt.groupId) {
        // If already assigned to a group, it must match the target group
        if (receipt.groupId !== input.groupId) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Receipt belongs to a different group' });
        }
      } else {
        // Ungrouped receipt: only the uploader can use it
        if (receipt.uploadedById !== ctx.user.id) {
          throw new TRPCError({ code: 'FORBIDDEN' });
        }
      }

      const extractedData = parseExtractedData(receipt.extractedData);

      const tax = extractedData.tax;
      const tip = input.tipOverride ?? extractedData.tip;

      // Verify paidBy and all assignees are members of this group
      const groupMembers = await ctx.db.groupMember.findMany({
        where: { groupId: input.groupId },
        select: { userId: true },
      });
      const memberIds = new Set(groupMembers.map((m) => m.userId));
      if (!memberIds.has(input.paidById)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Payer is not a member of this group' });
      }
      for (const a of input.assignments) {
        for (const uid of a.userIds) {
          if (!memberIds.has(uid)) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'Assignee is not a member of this group' });
          }
        }
      }

      // Build item map and verify all referenced items belong to this receipt
      const itemMap = new Map(receipt.items.map((item) => [item.id, item]));
      for (const a of input.assignments) {
        if (!itemMap.has(a.receiptItemId)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Item does not belong to this receipt' });
        }
      }

      let existing: {
        receiptId: string | null;
        splitMode: string;
        paidById: string;
        addedById: string;
        title: string;
        amount: number;
        category: string | null;
        placeName: string | null;
        baseCurrencyAmount: number | null;
        shares: { userId: string; amount: number }[];
      } | null = null;
      if (input.expenseId) {
        existing = await ctx.db.expense.findFirst({
          where: { id: input.expenseId, groupId: input.groupId },
          select: {
            receiptId: true,
            splitMode: true,
            paidById: true,
            addedById: true,
            title: true,
            amount: true,
            category: true,
            placeName: true,
            baseCurrencyAmount: true,
            shares: { select: { userId: true, amount: true } },
          },
        });
        if (!existing || existing.receiptId !== input.receiptId || existing.splitMode !== 'ITEM') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Expense does not belong to this receipt' });
        }
        const isOwnerOrAdmin = ctx.membership.role === 'OWNER' || ctx.membership.role === 'ADMIN';
        if (!isOwnerOrAdmin && existing.paidById !== ctx.user.id && existing.addedById !== ctx.user.id) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Only the expense creator, payer, or group owner/admin can modify this expense',
          });
        }
      }

      // Calculate per-user item subtotals
      const userSubtotals = new Map<string, number>();

      for (const assignment of input.assignments) {
        const item = itemMap.get(assignment.receiptItemId)!;

        if (assignment.weights && assignment.weights.some((w) => w !== 1)) {
          // Split by the units each person had (e.g. 2 of 3 coffees); the last share takes the rounding rest
          const totalWeight = assignment.weights.reduce((a, b) => a + b, 0);
          let allocated = 0;
          for (const [i, userId] of assignment.userIds.entries()) {
            const amount =
              i === assignment.userIds.length - 1
                ? item.totalPrice - allocated
                : Math.floor((item.totalPrice * assignment.weights[i]!) / totalWeight);
            allocated += amount;
            userSubtotals.set(userId, (userSubtotals.get(userId) ?? 0) + amount);
          }
          continue;
        }

        const perPerson = Math.floor(item.totalPrice / assignment.userIds.length);
        const remainder = item.totalPrice - perPerson * assignment.userIds.length;

        for (const [i, userId] of assignment.userIds.entries()) {
          const amount = perPerson + (i < remainder ? 1 : 0);
          userSubtotals.set(userId, (userSubtotals.get(userId) ?? 0) + amount);
        }
      }

      // Proportionally distribute tax and tip using receipt subtotal as denominator.
      // This ensures each assigned item gets its fair share of tax/tip relative to
      // the full receipt subtotal, even when not all items are assigned.
      const actualSubtotal = Array.from(userSubtotals.values()).reduce((a, b) => a + b, 0);
      const receiptSubtotal = extractedData.subtotal > 0 ? extractedData.subtotal : actualSubtotal;
      const totalAmount = actualSubtotal + tax + tip;

      const userTotals = new Map<string, number>();
      let allocatedTotal = 0;
      const userEntries = Array.from(userSubtotals.entries());

      for (const [i, [userId, itemTotal]] of userEntries.entries()) {
        const proportion = receiptSubtotal > 0 ? itemTotal / receiptSubtotal : 0;

        let userTax: number;
        let userTip: number;

        if (i === userEntries.length - 1) {
          // Last user gets remainder to prevent off-by-one
          const alreadyAllocated = allocatedTotal;
          const userTotal = totalAmount - alreadyAllocated;
          userTotals.set(userId, userTotal);
          allocatedTotal += userTotal;
        } else {
          userTax = Math.round(tax * proportion);
          userTip = Math.round(tip * proportion);
          const userTotal = itemTotal + userTax + userTip;
          userTotals.set(userId, userTotal);
          allocatedTotal += userTotal;
        }
      }

      // Save assignments in a single batch (replaces N×M individual upserts)
      const assignmentData = input.assignments.flatMap((a) =>
        a.userIds.map((userId, i) => ({
          receiptItemId: a.receiptItemId,
          userId,
          shareOfItem: a.weights?.[i] ?? 1,
        })),
      );

      // Currency conversion for receipt expenses
      const rawCurrency = extractedData.currency;
      if (!isValidCurrency(rawCurrency))
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Correct the receipt currency before saving.' });
      const receiptCurrency = rawCurrency.toUpperCase();
      const groupCurrency = group!.currency.toUpperCase();
      let exchangeRate: number | null = null;
      let conversionQuote: RateQuote | null = null;
      let baseCurrencyAmount: number | null = null;
      // Paid by card: the amount the bank actually charged (group currency) is what gets shared;
      // the receipt only decides who carries which part of it. Balances follow baseCurrencyAmount.
      let cardCharge: { amount: number; currency: string; rate: number } | null = null;

      if (input.chargedAmount !== undefined) {
        if (receiptCurrency === groupCurrency) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'The charged amount is only needed when the receipt is in another currency.',
          });
        }
        if (totalAmount <= 0) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Receipt total is zero.' });
        exchangeRate = input.chargedAmount / totalAmount;
        baseCurrencyAmount = input.chargedAmount;
        cardCharge = { amount: input.chargedAmount, currency: groupCurrency, rate: exchangeRate };
      } else if (receiptCurrency !== groupCurrency) {
        conversionQuote = await getReceiptRate(extractedData, groupCurrency, input.useLatestRate, ctx.db);
        if (!conversionQuote)
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              'No valid rate for the requested receipt date. Preview and explicitly select a latest estimate if appropriate.',
          });
        const expected = input.expectedConversion;
        if (
          !expected ||
          expected.rate !== conversionQuote.rate ||
          expected.source !== conversionQuote.source ||
          expected.rateDate !== conversionQuote.rateDate ||
          expected.requestedDate !== conversionQuote.requestedDate
        ) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Exchange rate changed or was not previewed. Reload the conversion preview before saving.',
          });
        }
        exchangeRate = conversionQuote.rate;
        baseCurrencyAmount = convertCents(totalAmount, exchangeRate);
      }

      // Which lines changed hands compared with what was saved before (an edit, or a receipt
      // saved for later): the history shows who reassigned what.
      const unitsAfter = new Map(
        input.assignments.map((a) => [
          a.receiptItemId,
          Object.fromEntries(a.userIds.map((u, i) => [u, a.weights?.[i] ?? 1])) as Units,
        ]),
      );
      const assignmentChanges = receipt.items.flatMap((item) => {
        const before: Units = Object.fromEntries((item.assignments ?? []).map((a) => [a.userId, a.shareOfItem ?? 1]));
        const after = unitsAfter.get(item.id) ?? {};
        const hadBefore = Object.keys(before).length > 0;
        if ((!hadBefore && !input.expenseId) || sameUnits(before, after)) return [];
        return [{ itemId: item.id, itemName: item.name, before, after }];
      });
      const category = input.category?.trim() || null;
      const expenseChanges: Record<string, [unknown, unknown]> = {};
      if (existing) {
        const next = {
          title: input.title,
          paidById: input.paidById,
          amount: totalAmount,
          ...(input.category !== undefined ? { category } : {}),
          placeName: input.placeName || null,
          baseCurrencyAmount,
        };
        for (const [key, value] of Object.entries(next)) {
          const old = existing[key as keyof typeof existing] ?? null;
          if (old !== value) expenseChanges[key] = [old, value];
        }
      }

      // All writes in a single transaction for atomicity
      const expense = await ctx.db.$transaction(async (tx) => {
        // Lock/version-check the receipt before linking it: a currency correction
        // or rescan must never race an expense built from older amounts/labels.
        const claimed = await tx.receipt.updateMany({
          where: { id: receipt.id, status: 'COMPLETED', updatedAt: receipt.updatedAt },
          data: {
            extractedData: {
              ...extractedData,
              expenseConversion: conversionQuote,
              cardCharge,
              latestRateAccepted: input.useLatestRate,
            } as unknown as Prisma.InputJsonValue,
          },
        });
        if (claimed.count !== 1)
          throw new TRPCError({ code: 'CONFLICT', message: 'Receipt changed. Reload before saving.' });
        const shareRows = Array.from(userTotals.entries()).map(([userId, amount]) => ({ userId, amount }));
        const hasPlace = input.latitude !== undefined && input.longitude !== undefined;
        const exp = input.expenseId
          ? await tx.expense.update({
              where: { id: input.expenseId },
              data: {
                title: input.title,
                amount: totalAmount,
                currency: receiptCurrency,
                exchangeRate: exchangeRate ?? 1.0,
                baseCurrencyAmount,
                paidById: input.paidById,
                ...(input.category !== undefined ? { category } : {}),
                placeName: input.placeName ? input.placeName : null,
                latitude: hasPlace ? input.latitude! : null,
                longitude: hasPlace ? input.longitude! : null,
                shares: { deleteMany: {}, create: shareRows },
              },
            })
          : await tx.expense.create({
              data: {
                groupId: input.groupId,
                title: input.title,
                amount: totalAmount,
                currency: receiptCurrency,
                exchangeRate: exchangeRate ?? 1.0,
                baseCurrencyAmount,
                splitMode: 'ITEM',
                paidById: input.paidById,
                addedById: ctx.user.id,
                receiptId: input.receiptId,
                ...(category ? { category } : {}),
                ...(input.placeName ? { placeName: input.placeName } : {}),
                ...(hasPlace ? { latitude: input.latitude!, longitude: input.longitude! } : {}),
                shares: { create: shareRows },
              },
            });

        // When editing, drop the assignments of every item of the receipt: an item that was
        // unassigned in the editor must not keep its old assignee.
        const itemIds = input.expenseId
          ? receipt.items.map((item) => item.id)
          : [...new Set(input.assignments.map((a) => a.receiptItemId))];
        await tx.receiptItemAssignment.deleteMany({
          where: { receiptItemId: { in: itemIds } },
        });
        await tx.receiptItemAssignment.createMany({
          data: assignmentData,
          skipDuplicates: true,
        });

        await tx.activityLog.create({
          data: {
            groupId: input.groupId,
            userId: ctx.user.id,
            type: input.expenseId ? 'EXPENSE_UPDATED' : 'EXPENSE_CREATED',
            entityId: exp.id,
            metadata: {
              title: input.title,
              amount: totalAmount,
              fromReceipt: true,
              receiptId: input.receiptId,
              ...(Object.keys(expenseChanges).length > 0 ? { changes: expenseChanges } : {}),
            } as Prisma.InputJsonValue,
          },
        });
        if (assignmentChanges.length > 0) {
          await logReceiptChange(tx, { id: input.receiptId, groupId: input.groupId }, ctx.user.id, {
            action: 'assign',
            changes: assignmentChanges,
          });
        }

        return exp;
      });

      // Same rules as manual bookings: new expense -> its sharers; changed total -> everyone involved
      const others = Array.from(userTotals.entries(), ([userId, amount]) => ({ userId, amount })).filter(
        (r) => r.userId !== ctx.user.id && r.amount > 0,
      );
      if (!input.expenseId) {
        void sendNotifications(
          ctx.db,
          others.map((r) => ({
            userId: r.userId,
            kind: 'EXPENSE_ADDED' as const,
            groupId: input.groupId,
            entityId: expense.id,
            vars: {
              actor: ctx.user.name ?? '?',
              title: input.title,
              amount: money(totalAmount, receiptCurrency),
              share: money(r.amount, receiptCurrency),
            },
          })),
        );
      } else if (expenseChanges.amount) {
        const involved = new Set([input.paidById, ...others.map((r) => r.userId)]);
        involved.delete(ctx.user.id);
        void sendNotifications(
          ctx.db,
          [...involved].map((userId) => ({
            userId,
            kind: 'PRICE_CHANGED' as const,
            groupId: input.groupId,
            entityId: expense.id,
            vars: {
              actor: ctx.user.name ?? '?',
              title: input.title,
              from: money(Number(expenseChanges.amount![0]), receiptCurrency),
              to: money(totalAmount, receiptCurrency),
            },
          })),
        );
      } else if (existing) {
        // Same price, other split: tell each person whose own share changed
        void sendNotifications(
          ctx.db,
          shareChangeItems({
            before: existing.shares,
            after: Array.from(userTotals.entries(), ([userId, amount]) => ({ userId, amount })),
            actorId: ctx.user.id,
            actorName: ctx.user.name ?? '?',
            groupId: input.groupId,
            entityId: expense.id,
            title: input.title,
            currency: receiptCurrency,
          }),
        );
      }

      return expense;
    }),

  saveForLater: groupMemberProcedure
    .input(
      z.object({
        groupId: z.string(),
        receiptId: z.string(),
        paidById: z.string().nullable().optional(),
        assignments: z
          .array(
            z.object({
              receiptItemId: z.string(),
              userIds: z.array(z.string()).max(100),
              weights: z.array(z.number().int().min(1).max(99)).max(100).optional(),
            }),
          )
          .max(200)
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await verifyReceiptAccess(ctx.db, input.receiptId, ctx.user.id);

      await ctx.db.$transaction(async (tx) => {
        const receipt = await tx.receipt.findUnique({
          where: { id: input.receiptId },
        });
        if (!receipt || receipt.status !== 'COMPLETED') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Receipt must be processed first' });
        }
        // Check it's not already linked to an expense
        const existing = await tx.expense.findUnique({
          where: { receiptId: input.receiptId },
        });
        if (existing) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Receipt already has an expense' });
        }

        const userIdsToValidate = new Set<string>();
        if (input.paidById) {
          userIdsToValidate.add(input.paidById);
        }
        for (const assignment of input.assignments ?? []) {
          for (const userId of assignment.userIds) {
            userIdsToValidate.add(userId);
          }
        }

        if (userIdsToValidate.size > 0) {
          const validMembers = await tx.groupMember.findMany({
            where: {
              groupId: input.groupId,
              userId: { in: Array.from(userIdsToValidate) },
            },
            select: { userId: true },
          });
          const validMemberIds = new Set(validMembers.map((member) => member.userId));
          for (const userId of userIdsToValidate) {
            if (!validMemberIds.has(userId)) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: `User ${userId} is not a member of this group`,
              });
            }
          }
        }

        await tx.receipt.update({
          where: { id: input.receiptId },
          data: {
            groupId: input.groupId,
            savedById: ctx.user.id,
            ...(input.paidById !== undefined ? { paidById: input.paidById } : {}),
          },
        });

        // Save partial assignments if provided (empty array clears existing)
        if (input.assignments) {
          // Validate that all receiptItemIds belong to this receipt
          if (input.assignments.length > 0) {
            const itemIds = input.assignments.map((a) => a.receiptItemId);
            const validItems = await tx.receiptItem.findMany({
              where: { id: { in: itemIds }, receiptId: input.receiptId },
              select: { id: true },
            });
            const validIds = new Set(validItems.map((i) => i.id));
            for (const id of itemIds) {
              if (!validIds.has(id)) {
                throw new TRPCError({ code: 'BAD_REQUEST', message: `Item ${id} does not belong to this receipt` });
              }
            }
          }

          // Clear any existing assignments first
          await tx.receiptItemAssignment.deleteMany({
            where: {
              receiptItem: { receiptId: input.receiptId },
            },
          });

          // Create new assignments
          const seenAssignments = new Set<string>();
          const assignmentData: { receiptItemId: string; userId: string; shareOfItem: number }[] = [];
          for (const assignment of input.assignments) {
            for (const [i, userId] of assignment.userIds.entries()) {
              const key = `${assignment.receiptItemId}\u0000${userId}`;
              if (seenAssignments.has(key)) {
                continue;
              }
              seenAssignments.add(key);
              assignmentData.push({
                receiptItemId: assignment.receiptItemId,
                userId,
                shareOfItem: assignment.weights?.[i] ?? 1,
              });
            }
          }
          if (assignmentData.length > 0) {
            await tx.receiptItemAssignment.createMany({
              data: assignmentData,
            });
          }
        }
      });

      return { success: true };
    }),

  /** Who changed which line of a receipt and when (newest first), plus creating/editing its expense. */
  history: protectedProcedure.input(z.object({ receiptId: z.string() })).query(async ({ ctx, input }) => {
    const receipt = await verifyReceiptAccess(ctx.db, input.receiptId, ctx.user.id);
    if (!receipt.groupId) return [];
    const expense = await ctx.db.expense.findUnique({
      where: { receiptId: input.receiptId },
      select: { id: true },
    });
    const logs = await ctx.db.activityLog.findMany({
      where: {
        groupId: receipt.groupId,
        OR: [
          { type: 'RECEIPT_ITEMS_CHANGED', entityId: receipt.id },
          ...(expense
            ? [{ type: { in: ['EXPENSE_CREATED' as const, 'EXPENSE_UPDATED' as const] }, entityId: expense.id }]
            : []),
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { user: { select: { id: true, name: true } } },
    });
    return logs.map((log) => ({
      id: log.id,
      type: log.type,
      createdAt: log.createdAt,
      userId: log.userId,
      userName: log.user?.name ?? null,
      metadata: (log.metadata ?? {}) as Record<string, unknown>,
    }));
  }),

  // ─── Everyone picks their own lines ───────────────────────

  /**
   * Asks every other member of the receipt's group to pick their own lines (bell + push). The receipt
   * stays open (no expense yet) until someone books it with the picks applied.
   */
  startClaimRequest: protectedProcedure.input(z.object({ receiptId: z.string() })).mutation(async ({ ctx, input }) => {
    const receipt = await verifyReceiptAccess(ctx.db, input.receiptId, ctx.user.id);
    if (!receipt.groupId || !receipt.group) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Only a receipt of a group can be shared with it' });
    }
    if (receipt.status !== 'COMPLETED') {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Receipt must be processed first' });
    }
    const expense = await ctx.db.expense.findUnique({ where: { receiptId: receipt.id }, select: { id: true } });
    if (expense) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Receipt already has an expense' });
    if (!checkRateLimit(`claim-request:${receipt.id}`, 5, 60 * 60 * 1000).allowed) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many requests for this receipt. Try again later.',
      });
    }

    await ctx.db.receiptClaimDone.deleteMany({ where: { receiptId: receipt.id } });
    await ctx.db.receipt.update({
      where: { id: receipt.id },
      data: {
        claimRequestedAt: new Date(),
        claimRequestedById: ctx.user.id,
        // A new request starts the "everyone done" round again
        claimsCompleteNotifiedAt: null,
        claimsOpenNotifiedAt: null,
        savedById: receipt.savedById ?? ctx.user.id,
      },
    });

    const extracted = receipt.extractedData ? parseExtractedData(receipt.extractedData) : null;
    const actor = await ctx.db.user.findUnique({ where: { id: ctx.user.id }, select: { name: true, email: true } });
    const others = receipt.group.members.map((m: { userId: string }) => m.userId).filter((id) => id !== ctx.user.id);
    await sendNotifications(
      ctx.db,
      others.map((userId) => ({
        userId,
        kind: 'CLAIM_REQUEST' as const,
        groupId: receipt.groupId!,
        entityId: receipt.id,
        vars: {
          actor: actor?.name ?? actor?.email ?? '?',
          title: extracted?.merchantName?.trim() || receipt.originalName,
        },
      })),
    );
    return { notified: others.length };
  }),

  /** Who picked which line so far, and whether picking was asked for. */
  getClaims: protectedProcedure.input(z.object({ receiptId: z.string() })).query(async ({ ctx, input }) => {
    const receipt = await verifyReceiptAccess(ctx.db, input.receiptId, ctx.user.id);
    const [claims, expense, requestedBy, done, members] = await Promise.all([
      ctx.db.receiptItemClaim.findMany({
        where: { receiptItem: { receiptId: receipt.id } },
        select: { receiptItemId: true, userId: true },
        orderBy: { createdAt: 'asc' },
      }),
      ctx.db.expense.findUnique({ where: { receiptId: receipt.id }, select: { id: true } }),
      receipt.claimRequestedById
        ? ctx.db.user.findUnique({ where: { id: receipt.claimRequestedById }, select: { id: true, name: true } })
        : null,
      ctx.db.receiptClaimDone.findMany({ where: { receiptId: receipt.id }, select: { userId: true } }),
      receipt.group
        ? realMemberIds(
            ctx.db,
            receipt.group.members.map((m: { userId: string }) => m.userId),
          )
        : Promise.resolve([] as string[]),
    ]);
    const doneIds = new Set(done.map((d) => d.userId));
    return {
      requestedAt: receipt.claimRequestedAt,
      requestedBy,
      expenseId: expense?.id ?? null,
      claims,
      /** Members who said they picked everything, and those still picking */
      done: members.filter((id) => doneIds.has(id)),
      waiting: members.filter((id) => !doneIds.has(id)),
    };
  }),

  /**
   * Marks a line as (not) the signed-in person's own. Each person only changes their own row, so
   * people picking at the same time never undo each other's picks.
   */
  setClaim: protectedProcedure
    .input(z.object({ receiptItemId: z.string(), claimed: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const item = await ctx.db.receiptItem.findUnique({
        where: { id: input.receiptItemId },
        select: { id: true, receiptId: true },
      });
      if (!item) throw new TRPCError({ code: 'NOT_FOUND' });
      const receipt = await verifyReceiptAccess(ctx.db, item.receiptId, ctx.user.id);
      if (!receipt.groupId) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Only a receipt of a group' });
      const expense = await ctx.db.expense.findUnique({ where: { receiptId: receipt.id }, select: { id: true } });
      if (expense) {
        throw new TRPCError({ code: 'CONFLICT', message: 'This receipt has already been booked' });
      }
      if (input.claimed) {
        await ctx.db.receiptItemClaim.createMany({
          data: [{ receiptItemId: item.id, userId: ctx.user.id }],
          skipDuplicates: true,
        });
      } else {
        await ctx.db.receiptItemClaim.deleteMany({ where: { receiptItemId: item.id, userId: ctx.user.id } });
      }
      if (input.claimed) await checkClaimProgress(ctx.db, receipt.id, ctx.user.id);
      return { claimed: input.claimed };
    }),

  /** The signed-in person has picked all their lines. When everyone has, the group hears what is left. */
  finishClaims: protectedProcedure.input(z.object({ receiptId: z.string() })).mutation(async ({ ctx, input }) => {
    const receipt = await verifyReceiptAccess(ctx.db, input.receiptId, ctx.user.id);
    if (!receipt.groupId) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Only a receipt of a group' });
    await ctx.db.receiptClaimDone.createMany({
      data: [{ receiptId: receipt.id, userId: ctx.user.id }],
      skipDuplicates: true,
    });
    await checkClaimProgress(ctx.db, receipt.id, ctx.user.id);
    return { done: true };
  }),

  listPending: groupMemberProcedure.input(z.object({ groupId: z.string() })).query(async ({ ctx, input }) => {
    const receipts = await ctx.db.receipt.findMany({
      where: {
        groupId: input.groupId,
        status: 'COMPLETED',
        expense: null,
      },
      take: 200,
      orderBy: { createdAt: 'desc' },
    });

    return receipts.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      extractedData: r.extractedData as {
        merchantName?: string;
        merchantAddress?: string;
        date?: string;
        subtotal: number;
        tax: number;
        tip: number;
        total: number;
        currency: string;
      } | null,
    }));
  }),

  deletePending: protectedProcedure.input(z.object({ receiptId: z.string() })).mutation(async ({ ctx, input }) => {
    const receipt = await ctx.db.receipt.findUnique({
      where: { id: input.receiptId },
    });
    if (!receipt) {
      throw new TRPCError({ code: 'NOT_FOUND' });
    }
    // Only the uploader or the person who saved it can delete it
    const isUploader = receipt.uploadedById === ctx.user.id;
    const isSaver = receipt.savedById && receipt.savedById === ctx.user.id;
    if (!isUploader && !isSaver) {
      throw new TRPCError({ code: 'FORBIDDEN' });
    }
    // Can't delete if already linked to expense
    const expense = await ctx.db.expense.findUnique({
      where: { receiptId: input.receiptId },
    });
    if (expense) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Receipt has an expense' });
    }

    await ctx.db.receiptItem.deleteMany({ where: { receiptId: input.receiptId } });
    await ctx.db.receipt.delete({ where: { id: input.receiptId } });

    // Clean up the uploaded image file
    try {
      const { unlink } = await import('fs/promises');
      const { resolveUploadPath } = await import('../../lib/upload-dir');
      const filepath = resolveUploadPath(receipt.imagePath);
      await unlink(filepath);
    } catch {
      // Non-fatal: file may already be missing
      logger.warn('receipt.delete.fileCleanupFailed', {
        receiptId: input.receiptId,
        imagePath: receipt.imagePath,
      });
    }

    return { success: true };
  }),
});
