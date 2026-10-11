'use client';

import { use } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useSession } from 'next-auth/react';
import { ArrowLeft, Check } from 'lucide-react';
import { toast } from 'sonner';
import { Link } from '@/i18n/navigation';
import { trpc } from '@/lib/trpc';
import { formatCents } from '@/lib/money';
import { claimShare } from '@/lib/receipt-claims';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { UserAvatar } from '@/components/ui/user-avatar';
import { LoadingSpinner } from '@/components/ui/loading-spinner';

/**
 * Every group member picks their own lines of a scanned receipt. Each tap saves one person's own pick,
 * so everybody can pick at the same time; the page refreshes to show what the others picked.
 */
export default function ClaimReceiptPage({ params }: { params: Promise<{ groupId: string; receiptId: string }> }) {
  const { groupId, receiptId } = use(params);
  const t = useTranslations('expenses.claim');
  const locale = useLocale();
  const { data: authSession } = useSession();
  const myId = authSession?.user?.id;
  const utils = trpc.useUtils();

  const group = trpc.groups.get.useQuery({ groupId });
  const receiptData = trpc.receipts.getReceiptItems.useQuery({ receiptId });
  const claims = trpc.receipts.getClaims.useQuery({ receiptId }, { refetchInterval: 4000 });

  const setClaim = trpc.receipts.setClaim.useMutation({
    onMutate: async ({ receiptItemId, claimed }) => {
      await utils.receipts.getClaims.cancel({ receiptId });
      const previous = utils.receipts.getClaims.getData({ receiptId });
      if (previous && myId) {
        const rest = previous.claims.filter((c) => !(c.receiptItemId === receiptItemId && c.userId === myId));
        utils.receipts.getClaims.setData(
          { receiptId },
          { ...previous, claims: claimed ? [...rest, { receiptItemId, userId: myId }] : rest },
        );
      }
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) utils.receipts.getClaims.setData({ receiptId }, context.previous);
      toast.error(err.message);
    },
    onSettled: () => utils.receipts.getClaims.invalidate({ receiptId }),
  });

  if (receiptData.isLoading || claims.isLoading || group.isLoading) return <LoadingSpinner />;
  const receipt = receiptData.data?.receipt;
  const extracted = receipt?.extractedData;
  if (!receiptData.data || !extracted || !claims.data) {
    return <p className="py-16 text-center text-sm text-muted-foreground">{t('notFound')}</p>;
  }

  const items = receiptData.data.items;
  const currency = extracted.currency;
  const fmt = (cents: number) => {
    try {
      return formatCents(cents, currency, locale);
    } catch {
      return `${(cents / 100).toFixed(2)} ${currency}`;
    }
  };
  const members = new Map(
    (group.data?.members ?? []).map((m) => [
      m.user.id,
      { id: m.user.id, name: m.user.placeholderName ?? m.user.name ?? m.user.email, image: m.user.image },
    ]),
  );
  const byItem = new Map<string, string[]>();
  for (const c of claims.data.claims) byItem.set(c.receiptItemId, [...(byItem.get(c.receiptItemId) ?? []), c.userId]);
  const booked = !!claims.data.expenseId;
  const unclaimed = items.filter((i) => !byItem.get(i.id)?.length).length;
  const myShare = myId
    ? claimShare({
        items: items.map((i) => ({ id: i.id, totalPrice: i.totalPrice })),
        claims: claims.data.claims,
        userId: myId,
        extra: extracted.tax + (extracted.tip ?? 0),
      })
    : 0;
  const merchant = extracted.merchantName?.trim() || t('receipt');
  const requester = claims.data.requestedBy?.name;

  return (
    <div className="mx-auto max-w-2xl space-y-4 pb-28">
      <Link
        href={`/groups/${groupId}`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {t('backToGroup')}
      </Link>

      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {requester ? t('introBy', { name: requester, merchant }) : t('intro', { merchant })}
        </p>
      </div>

      {booked && (
        <Card className="border-primary/40">
          <CardContent className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
            <span>{t('booked')}</span>
            <Button
              size="sm"
              variant="outline"
              nativeButton={false}
              render={<Link href={`/groups/${groupId}/expenses/${claims.data.expenseId}`} />}
            >
              {t('openExpense')}
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="space-y-2" data-testid="claim-items">
        {items.map((item) => {
          const claimers = byItem.get(item.id) ?? [];
          const mine = !!myId && claimers.includes(myId);
          return (
            <button
              key={item.id}
              type="button"
              disabled={booked || !myId}
              aria-pressed={mine}
              onClick={() => setClaim.mutate({ receiptItemId: item.id, claimed: !mine })}
              className={cn(
                'flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors',
                mine ? 'border-primary bg-primary/10' : 'hover:bg-muted/60',
                booked && 'opacity-70',
              )}
              data-testid={`claim-item-${item.id}`}
            >
              <span
                className={cn(
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-md border',
                  mine ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40',
                )}
              >
                {mine && <Check className="h-4 w-4" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {item.quantity > 1 ? `${item.quantity}× ` : ''}
                  {item.name}
                </span>
                <span className="mt-1 flex items-center gap-1">
                  {claimers.map((uid) => {
                    const m = members.get(uid);
                    return (
                      <UserAvatar
                        key={uid}
                        id={uid}
                        image={m?.image}
                        name={m?.name}
                        {...(m?.name ? { title: m.name } : {})}
                        className="h-5 w-5 text-[9px]"
                      />
                    );
                  })}
                  {claimers.length > 1 && (
                    <span className="text-xs text-muted-foreground">{t('sharedBy', { count: claimers.length })}</span>
                  )}
                </span>
              </span>
              <span className="shrink-0 text-sm font-semibold tabular-nums">{fmt(item.totalPrice)}</span>
            </button>
          );
        })}
      </div>

      <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 px-4 py-3 backdrop-blur lg:left-64">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold" data-testid="claim-my-share">
              {t('yourShare', { amount: fmt(myShare) })}
            </p>
            <p className="text-xs text-muted-foreground">
              {unclaimed > 0 ? t('unclaimed', { count: unclaimed }) : t('allClaimed')}
            </p>
          </div>
          <Button nativeButton={false} render={<Link href={`/groups/${groupId}`} />} data-testid="claim-done">
            {t('done')}
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t('shareHint')}</p>
      {!booked && (
        <p className="text-xs text-muted-foreground">
          {t('bookHint')}{' '}
          <Link href={`/groups/${groupId}/scan?receiptId=${receiptId}`} className="text-primary hover:underline">
            {t('bookLink')}
          </Link>
        </p>
      )}
    </div>
  );
}
