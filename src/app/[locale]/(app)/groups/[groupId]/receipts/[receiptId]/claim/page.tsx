'use client';

import { use, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useSession } from 'next-auth/react';
import { ArrowLeft, Check, Minus, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Link, useRouter } from '@/i18n/navigation';
import { trpc } from '@/lib/trpc';
import { formatCents } from '@/lib/money';
import { claimShare, openUnits } from '@/lib/receipt-claims';
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
  const router = useRouter();
  const [onlyOpen, setOnlyOpen] = useState(false);

  const group = trpc.groups.get.useQuery({ groupId });
  const receiptData = trpc.receipts.getReceiptItems.useQuery({ receiptId });
  const claims = trpc.receipts.getClaims.useQuery({ receiptId }, { refetchInterval: 4000 });
  // Amounts in the group currency too, at the same rate as the receipt page
  const groupCurrency = group.data?.currency?.toUpperCase() ?? '';
  const receiptCurrency = receiptData.data?.receipt.extractedData?.currency?.toUpperCase() ?? '';
  const foreign = !!groupCurrency && !!receiptCurrency && groupCurrency !== receiptCurrency;
  const conversion = trpc.receipts.getConversionPreview.useQuery(
    { groupId, receiptId },
    { enabled: foreign, staleTime: 60_000 },
  );
  const rate = foreign ? (conversion.data?.groupRate?.rate ?? conversion.data?.groupEstimate?.rate ?? null) : null;

  const setClaim = trpc.receipts.setClaim.useMutation({
    onMutate: async ({ receiptItemId, claimed, units }) => {
      await utils.receipts.getClaims.cancel({ receiptId });
      const previous = utils.receipts.getClaims.getData({ receiptId });
      const next = units ?? (claimed ? 1 : 0);
      if (previous && myId) {
        const rest = previous.claims.filter((c) => !(c.receiptItemId === receiptItemId && c.userId === myId));
        utils.receipts.getClaims.setData(
          { receiptId },
          { ...previous, claims: next > 0 ? [...rest, { receiptItemId, userId: myId, units: next }] : rest },
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

  const finish = trpc.receipts.finishClaims.useMutation({
    onSuccess: () => {
      toast.success(t('finishedToast'));
      router.push(`/groups/${groupId}`);
    },
    onError: (err) => toast.error(err.message),
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
  const fmtGroup = (cents: number) => {
    if (rate === null) return null;
    try {
      return formatCents(Math.round(cents * rate), groupCurrency, locale);
    } catch {
      return null;
    }
  };
  const members = new Map(
    (group.data?.members ?? []).map((m) => [
      m.user.id,
      { id: m.user.id, name: m.user.placeholderName ?? m.user.name ?? m.user.email, image: m.user.image },
    ]),
  );
  const byItem = new Map<string, { userId: string; units: number }[]>();
  for (const c of claims.data.claims) {
    byItem.set(c.receiptItemId, [...(byItem.get(c.receiptItemId) ?? []), { userId: c.userId, units: c.units }]);
  }
  const openOf = (item: { id: string; quantity: number }) => openUnits(item.quantity, byItem.get(item.id) ?? []);
  const booked = !!claims.data.expenseId;
  const unclaimed = items.filter((i) => openOf(i) > 0).length;
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
  const iAmDone = !!myId && claims.data.done.includes(myId);
  const shown = onlyOpen ? items.filter((i) => openOf(i) > 0) : items;
  const nameOf = (id: string) => members.get(id)?.name ?? '?';
  // Not done yet: who already picked something, and who has not started
  const pickedSomething = new Set(claims.data.claims.map((c) => c.userId));
  const picking = claims.data.waiting.filter((id) => pickedSomething.has(id));
  const notStarted = claims.data.waiting.filter((id) => !pickedSomething.has(id));

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

      {/* Live state: what is still open, who is done */}
      <Card className={unclaimed === 0 ? 'border-primary bg-primary/5' : ''} data-testid="claim-progress">
        <CardContent className="space-y-2 py-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium" data-testid="claim-open-count">
              {unclaimed > 0 ? t('unclaimed', { count: unclaimed }) : t('allPickedBanner')}
            </span>
            {unclaimed > 0 && (
              <button
                type="button"
                onClick={() => setOnlyOpen((v) => !v)}
                className="text-xs text-primary hover:underline"
                data-testid="claim-only-open"
              >
                {onlyOpen ? t('showAll') : t('onlyOpen')}
              </button>
            )}
          </div>
          {(claims.data.done.length > 0 || claims.data.waiting.length > 0) && (
            <div className="space-y-1 text-xs text-muted-foreground">
              {claims.data.done.length > 0 && (
                <p>
                  ✅ {t('doneLabel')} {claims.data.done.map(nameOf).join(', ')}
                </p>
              )}
              {picking.length > 0 && (
                <p>
                  ✏️ {t('pickingLabel')} {picking.map(nameOf).join(', ')}
                </p>
              )}
              {notStarted.length > 0 && (
                <p>
                  ⏳ {t('notStartedLabel')} {notStarted.map(nameOf).join(', ')}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="space-y-2" data-testid="claim-items">
        {shown.map((item) => {
          const claimers = byItem.get(item.id) ?? [];
          const myUnits = claimers.find((c) => c.userId === myId)?.units ?? 0;
          const mine = myUnits > 0;
          const several = item.quantity > 1;
          const open = openOf(item);
          const locked = booked || !myId;
          return (
            <div
              key={item.id}
              className={cn(
                'flex items-center gap-2 rounded-xl border p-3 transition-colors',
                mine ? 'border-primary bg-primary/10' : 'hover:bg-muted/60',
                !mine && open > 0 && 'border-dashed border-amber-500/60',
                booked && 'opacity-70',
              )}
            >
              <button
                type="button"
                disabled={locked}
                aria-pressed={mine}
                onClick={() => setClaim.mutate({ receiptItemId: item.id, units: mine ? 0 : 1 })}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
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
                    {several ? `${item.quantity}× ` : ''}
                    {item.name}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-1">
                    {claimers.map(({ userId: uid, units }) => {
                      const m = members.get(uid);
                      return (
                        <span key={uid} className="inline-flex items-center gap-0.5">
                          <UserAvatar
                            id={uid}
                            image={m?.image}
                            name={m?.name}
                            {...(m?.name ? { title: m.name } : {})}
                            className="h-5 w-5 text-[9px]"
                          />
                          {several && <span className="text-[10px] tabular-nums text-muted-foreground">{units}×</span>}
                        </span>
                      );
                    })}
                    {open > 0 && (
                      <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
                        {several && claimers.length > 0 ? t('openUnits', { count: open }) : t('openBadge')}
                      </span>
                    )}
                    {!several && claimers.length > 1 && (
                      <span className="text-xs text-muted-foreground">{t('sharedBy', { count: claimers.length })}</span>
                    )}
                  </span>
                </span>
              </button>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <span className="text-sm font-semibold tabular-nums">{fmt(item.totalPrice)}</span>
                {fmtGroup(item.totalPrice) && (
                  <span className="text-xs tabular-nums text-muted-foreground">≈ {fmtGroup(item.totalPrice)}</span>
                )}
                {several && mine && (
                  <span className="inline-flex items-center gap-1" data-testid={`claim-units-${item.id}`}>
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      className="h-7 w-7"
                      disabled={locked}
                      aria-label={t('lessUnits')}
                      onClick={() => setClaim.mutate({ receiptItemId: item.id, units: myUnits - 1 })}
                    >
                      <Minus className="h-3.5 w-3.5" />
                    </Button>
                    <span className="w-6 text-center text-sm tabular-nums" data-testid={`claim-my-units-${item.id}`}>
                      {myUnits}
                    </span>
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      className="h-7 w-7"
                      disabled={locked || myUnits >= item.quantity}
                      aria-label={t('moreUnits')}
                      onClick={() => setClaim.mutate({ receiptItemId: item.id, units: myUnits + 1 })}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 px-4 py-3 backdrop-blur lg:left-64">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold" data-testid="claim-my-share">
              {t('yourShare', { amount: fmt(myShare) })}
              {fmtGroup(myShare) && (
                <span className="ml-1 text-sm font-normal text-muted-foreground" data-testid="claim-my-share-group">
                  ≈ {fmtGroup(myShare)}
                </span>
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {unclaimed > 0 ? t('unclaimed', { count: unclaimed }) : t('allClaimed')}
            </p>
          </div>
          <Button
            disabled={booked || finish.isPending}
            onClick={() => (iAmDone ? router.push(`/groups/${groupId}`) : finish.mutate({ receiptId }))}
            data-testid="claim-done"
          >
            {iAmDone ? t('backToGroup') : t('done')}
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
