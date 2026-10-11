'use client';

import { use, useState, useRef, useEffect, useMemo } from 'react';
import { useSession } from 'next-auth/react';
import { useLocale, useTranslations } from 'next-intl';
import { trpc } from '@/lib/trpc';
import { formatCents } from '@/lib/money';
import { buildVenmoPayUrl, isValidVenmoHandle } from '@/lib/venmo';
import { buildPaypalEmailUrl, buildPaypalMeUrl, isValidIban, isValidPaypalEmail } from '@/lib/payments';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { UserAvatar } from '@/components/ui/user-avatar';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import {
  BarChart3,
  History,
  Plus,
  Settings,
  UserPlus,
  ArrowRight,
  Receipt,
  Handshake,
  Camera,
  Archive,
  Trash2,
} from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { toast } from 'sonner';
import { InviteDialog } from '@/components/groups/invite-dialog';
import { SettleDialog } from '@/components/groups/settle-dialog';
import { BankTransferDialog } from '@/components/groups/bank-transfer-dialog';
import { OpenClaims } from '@/components/receipts/open-claims';
import { MySpendingCard } from '@/components/groups/my-spending-card';
import { BalanceStandings } from '@/components/groups/balance-standings';
import {
  ExpenseRow,
  MemberAvatar,
  PersonFilter,
  dayLabel,
  involves,
  memberName,
  type RowMember,
} from '@/components/expenses/expense-row';

export default function GroupDetailPage({ params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = use(params);
  const locale = useLocale();
  const [showInvite, setShowInvite] = useState(false);
  const [bankTransfer, setBankTransfer] = useState<{
    fromId: string;
    toId: string;
    amount: number;
    holder: string;
    iban: string;
  } | null>(null);
  const [settleState, setSettleState] = useState<{
    open: boolean;
    from?: string;
    to?: string;
    amount?: number;
  }>({ open: false });

  const t = useTranslations('groups');
  const { data: authSession } = useSession();
  const group = trpc.groups.get.useQuery({ groupId });
  const expenses = trpc.expenses.list.useQuery({ groupId, limit: 50 });
  const balances = trpc.balances.getGroupBalances.useQuery({ groupId });
  const myId = authSession?.user?.id;
  // Starts on the signed-in person; 'Alle' ('') is a choice
  const [chosenFilter, setPersonFilter] = useState<string | null>(null);
  const personFilter = chosenFilter ?? myId ?? '';
  // Newest first, grouped by day; the person filter keeps what someone paid for or shares in
  const days = useMemo(() => {
    const list = (expenses.data?.expenses ?? []).filter((e) => !personFilter || involves(e, personFilter));
    const out: { key: string; date: Date; items: typeof list }[] = [];
    for (const e of list) {
      const date = new Date(e.expenseDate);
      const key = date.toLocaleDateString('sv-SE');
      const last = out[out.length - 1];
      if (last && last.key === key) last.items.push(e);
      else out.push({ key, date, items: [e] });
    }
    return out;
  }, [expenses.data, personFilter]);
  const myTotals = trpc.expenses.myTotals.useQuery({ groupId });
  const debts = trpc.balances.getSimplifiedDebts.useQuery({ groupId });
  const pendingReceipts = trpc.receipts.listPending.useQuery({ groupId });
  const venmoSetting = trpc.admin.getVenmoEnabled.useQuery();
  const deletePending = trpc.receipts.deletePending.useMutation({
    onSuccess: () => pendingReceipts.refetch(),
  });

  const utils = trpc.useUtils();
  const settleVenmo = trpc.settlements.create.useMutation({
    onSuccess: () => {
      utils.balances.getGroupBalances.invalidate({ groupId });
      utils.balances.getSimplifiedDebts.invalidate({ groupId });
      utils.balances.getDashboard.invalidate();
      utils.settlements.list.invalidate({ groupId });
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    },
    [],
  );

  if (group.isLoading && !group.isError) {
    return <LoadingSpinner />;
  }

  if (!group.data) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <Receipt className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
        <h2 className="mb-2 text-lg font-semibold">{t('detail.notFound')}</h2>
        <p className="mb-4 text-sm text-muted-foreground">{t('detail.notFoundDescription')}</p>
        <Button nativeButton={false} render={<Link href="/groups" />}>
          {t('detail.backToGroups')}
        </Button>
      </div>
    );
  }

  const g = group.data;
  const memberMap = new Map(g.members.map((m) => [m.user.id, m.user]));

  // Opens an external payment page, then asks whether it went through and records the settlement.
  function startExternalPayment(
    url: string,
    debt: { from: string; to: string; amount: number },
    toName: string,
    kind: 'venmo' | 'paypal',
  ) {
    if (settleTimerRef.current) return;
    window.open(url, '_blank', 'noopener,noreferrer');
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      const values = { amount: formatCents(debt.amount, g.currency, locale), name: toName };
      const question =
        kind === 'venmo' ? t('detail.venmoPaymentConfirm', values) : t('detail.paypalPaymentConfirm', values);
      if (confirm(question)) {
        settleVenmo.mutate({
          groupId,
          fromId: debt.from,
          toId: debt.to,
          amount: debt.amount,
          currency: g.currency,
          note: kind === 'venmo' ? t('detail.settledViaVenmo') : t('detail.settledViaPaypal'),
        });
      }
    }, 2000);
  }
  // Ways the signed-in person can pay a debt of theirs: what the receiver has saved, as ready-made links
  function paymentOptions(debt: { from: string; to: string; amount: number }) {
    const to = memberMap.get(debt.to);
    const isMyDebt = debt.from === authSession?.user?.id;
    const reference = `Splitbon: ${g.name}`;
    const showVenmo =
      venmoSetting.data?.enabled &&
      g.currency === 'USD' &&
      isMyDebt &&
      to?.venmoUsername &&
      isValidVenmoHandle(to.venmoUsername);
    const venmoUrl = showVenmo ? buildVenmoPayUrl(to.venmoUsername!, debt.amount, reference) : null;
    const paypalUrl =
      isMyDebt && to
        ? ((to.paypalMeName ? buildPaypalMeUrl(to.paypalMeName, debt.amount, g.currency) : null) ??
          (to.paypalEmail && isValidPaypalEmail(to.paypalEmail)
            ? buildPaypalEmailUrl(to.paypalEmail, debt.amount, g.currency, reference)
            : null))
        : null;
    const bankIban = isMyDebt && to?.iban && isValidIban(to.iban) ? to.iban : null;
    return { isMyDebt, venmoUrl, paypalUrl, bankIban };
  }
  // Pay buttons inside the settle dialog, so the way to pay is found where "Zahlung erfassen" is opened
  function settleActions(from: string, to: string, amount: number) {
    const debt = { from, to, amount };
    const { isMyDebt, venmoUrl, paypalUrl, bankIban } = paymentOptions(debt);
    if (!isMyDebt) return null;
    const receiver = memberMap.get(to);
    const toName = receiver?.name ?? receiver?.email ?? t('detail.unknown');
    if (!venmoUrl && !paypalUrl && !bankIban) {
      return (
        <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
          {t('detail.noPaymentData', { name: toName })}
        </p>
      );
    }
    return (
      <div className="flex flex-wrap gap-2" data-testid="settle-pay-options">
        {venmoUrl && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setSettleState((st) => ({ ...st, open: false }));
              startExternalPayment(venmoUrl, debt, toName, 'venmo');
            }}
          >
            {t('detail.payViaVenmo')}
          </Button>
        )}
        {paypalUrl && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="settle-pay-paypal"
            onClick={() => {
              setSettleState((st) => ({ ...st, open: false }));
              startExternalPayment(paypalUrl, debt, toName, 'paypal');
            }}
          >
            {t('detail.payViaPaypal')}
          </Button>
        )}
        {bankIban && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setSettleState((st) => ({ ...st, open: false }));
              setBankTransfer({
                fromId: from,
                toId: to,
                amount,
                holder: receiver?.ibanHolder?.trim() || toName,
                iban: bankIban,
              });
            }}
          >
            {t('detail.payViaBank')}
          </Button>
        )}
      </div>
    );
  }
  const rowMembers = new Map<string, RowMember>(g.members.map((m) => [m.user.id, m.user]));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-4">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-accent">
            <span className="text-4xl leading-none">{g.emoji}</span>
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-bold leading-tight">{g.name}</h1>
            {g.description && <p className="mt-0.5 truncate text-sm text-muted-foreground">{g.description}</p>}
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowInvite(true)}>
            <UserPlus className="mr-2 h-4 w-4" />
            {t('detail.invite')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link href={`/groups/${groupId}/stats`} />}
            title={t('detail.stats')}
            aria-label={t('detail.stats')}
          >
            <BarChart3 className="h-4 w-4 sm:mr-2" />
            <span className="hidden sm:inline">{t('detail.stats')}</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link href={`/groups/${groupId}/history`} />}
            title={t('detail.history')}
            aria-label={t('detail.history')}
            data-testid="history-btn"
          >
            <History className="h-4 w-4 sm:mr-2" />
            <span className="hidden sm:inline">{t('detail.history')}</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link href={`/groups/${groupId}/trash`} />}
            title={t('detail.trash')}
            aria-label={t('detail.trash')}
            data-testid="trash-btn"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link href={`/groups/${groupId}/settings`} />}
          >
            <Settings className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <OpenClaims groupId={groupId} />

      {/* Members */}
      <div className="flex flex-wrap gap-2">
        {g.members.map((m) => (
          <div
            key={m.user.id}
            className={`flex items-center gap-2 rounded-full py-1 pr-3 pl-1 ${
              m.user.isPlaceholder ? 'border border-dashed border-muted-foreground/40 bg-muted/50' : 'bg-muted'
            }`}
          >
            <UserAvatar
              image={m.user.image}
              id={m.user.id}
              name={m.user.placeholderName ?? m.user.name}
              email={m.user.email}
              className="h-6 w-6"
            />
            <span className="text-sm font-medium">{m.user.placeholderName ?? m.user.name ?? m.user.email}</span>
            {m.role === 'OWNER' && (
              <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                {t('detail.owner')}
              </span>
            )}
            {m.user.isPlaceholder && (
              <Badge variant="outline" className="ml-0.5 text-[10px]">
                {t('detail.pending')}
              </Badge>
            )}
          </div>
        ))}
      </div>

      {/* The two things people do most, right at the top */}
      {!g.archivedAt && (
        <div className="grid grid-cols-2 gap-3">
          <Button
            size="lg"
            className="h-12 text-base"
            nativeButton={false}
            render={<Link href={`/groups/${groupId}/scan`} />}
            data-testid="top-scan-btn"
          >
            <Camera className="mr-2 h-5 w-5" />
            {t('detail.scanReceipt')}
          </Button>
          <Button
            size="lg"
            variant="outline"
            className="h-12 text-base"
            nativeButton={false}
            render={<Link href={`/groups/${groupId}/expenses/new`} />}
            data-testid="top-add-btn"
          >
            <Plus className="mr-2 h-5 w-5" />
            {t('detail.addExpense')}
          </Button>
        </div>
      )}

      {g.archivedAt && (
        <div className="flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/50 dark:text-amber-200">
          <Archive className="h-4 w-4 shrink-0" />
          <span>{t('detail.archivedMessage')}</span>
          <Button
            variant="link"
            size="sm"
            className="ml-auto h-auto p-0 text-amber-800 dark:text-amber-200"
            nativeButton={false}
            render={<Link href={`/groups/${groupId}/settings`} />}
          >
            {t('detail.manage')}
          </Button>
        </div>
      )}

      <Separator />

      {/* Meine Ausgaben */}
      {myTotals.data && myTotals.data.count > 0 && (
        <MySpendingCard
          groupId={groupId}
          totals={myTotals.data}
          budget={g.budgetTotal}
          people={g.members.length}
          currency={g.currency}
          locale={locale}
        />
      )}

      {/* Simplified Debts */}
      {debts.data && debts.data.debts.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base" data-testid="balances-title">
                {t('detail.balances')}
              </CardTitle>
              <Button variant="outline" size="sm" onClick={() => setSettleState({ open: true })}>
                <Handshake className="mr-2 h-4 w-4" />
                {t('detail.settle')}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {balances.data && (
              <BalanceStandings
                balances={balances.data.balances}
                members={rowMembers}
                currency={g.currency}
                myId={myId}
              />
            )}
            <div className="space-y-1.5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t('detail.howToSettle')}
              </p>
              {debts.data.debts.map((debt, i) => {
                const from = memberMap.get(debt.from);
                const to = memberMap.get(debt.to);
                const toName = to?.name ?? to?.email ?? t('detail.unknown');
                const { venmoUrl, paypalUrl, bankIban } = paymentOptions(debt);
                return (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      aria-label={`${memberName(from, t('detail.unknown'))} → ${toName}: ${formatCents(debt.amount, g.currency, locale)}`}
                      className={`flex flex-1 items-center gap-2 rounded-xl border p-2.5 text-sm transition-all hover:bg-muted/70 hover:shadow-sm ${
                        debt.from === myId || debt.to === myId ? 'border-primary/40 bg-primary/5' : ''
                      }`}
                      onClick={() =>
                        setSettleState({
                          open: true,
                          from: debt.from,
                          to: debt.to,
                          amount: debt.amount,
                        })
                      }
                    >
                      <MemberAvatar member={rowMembers.get(debt.from)} id={debt.from} className="h-7 w-7 text-[10px]" />
                      <span className="truncate text-xs font-medium sm:text-sm">
                        {debt.from === myId ? t('detail.you') : memberName(from, t('detail.unknown')).split(' ')[0]}
                      </span>
                      <span className="flex shrink-0 flex-col items-center px-1">
                        <span className="text-xs font-semibold tabular-nums">
                          {formatCents(debt.amount, g.currency, locale)}
                        </span>
                        <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                      </span>
                      <MemberAvatar member={rowMembers.get(debt.to)} id={debt.to} className="h-7 w-7 text-[10px]" />
                      <span className="truncate text-xs font-medium sm:text-sm">
                        {debt.to === myId ? t('detail.you') : toName.split(' ')[0]}
                      </span>
                      <Handshake className="ml-auto h-4 w-4 shrink-0 text-muted-foreground" />
                    </button>
                    {venmoUrl && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="shrink-0 text-[#008CFF] hover:text-[#0070CC]"
                        disabled={settleVenmo.isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          startExternalPayment(venmoUrl, debt, toName, 'venmo');
                        }}
                        data-testid={`venmo-settle-${i}`}
                      >
                        {t('detail.payViaVenmo')}
                      </Button>
                    )}
                    {paypalUrl && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="shrink-0 text-[#0070BA] hover:text-[#005C99]"
                        disabled={settleVenmo.isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          startExternalPayment(paypalUrl, debt, toName, 'paypal');
                        }}
                        data-testid={`paypal-settle-${i}`}
                      >
                        {t('detail.payViaPaypal')}
                      </Button>
                    )}
                    {bankIban && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="shrink-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          setBankTransfer({
                            fromId: debt.from,
                            toId: debt.to,
                            amount: debt.amount,
                            holder: to?.ibanHolder?.trim() || toName,
                            iban: bankIban,
                          });
                        }}
                        data-testid={`bank-settle-${i}`}
                      >
                        {t('detail.payViaBank')}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {debts.data && debts.data.debts.length === 0 && (
        <Card>
          <CardContent className="py-4 text-center text-sm text-muted-foreground">
            {t('detail.allSettledUp')}
          </CardContent>
        </Card>
      )}

      {/* Pending Receipts */}
      {pendingReceipts.data && pendingReceipts.data.length > 0 && (
        <div>
          <h2 className="mb-3 text-lg font-semibold">{t('detail.pendingReceipts')}</h2>
          <div className="space-y-2">
            {pendingReceipts.data.map((r) => (
              <Card key={r.id} className="transition-colors hover:bg-muted/50">
                <CardContent className="flex items-center justify-between py-3">
                  <Link href={`/groups/${groupId}/scan?receiptId=${r.id}`} className="flex-1 min-w-0">
                    <p className="font-medium">{r.extractedData?.merchantName ?? t('detail.receipt')}</p>
                    <p className="text-sm text-muted-foreground">
                      {r.extractedData?.date ?? new Date(r.createdAt).toLocaleDateString()}
                      {' · '}
                      {t('detail.savedForLater')}
                    </p>
                  </Link>
                  {r.claimRequestedAt && (
                    <Link
                      href={`/groups/${groupId}/receipts/${r.id}/claim`}
                      className="ml-2 shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                      data-testid="pending-receipt-claim-badge"
                    >
                      🙋 {t('detail.claimRunning')}
                    </Link>
                  )}
                  <div className="flex items-center gap-3 ml-3">
                    <div className="text-right">
                      <p className="text-lg font-semibold" data-testid="pending-receipt-total">
                        {r.extractedData
                          ? formatCents(r.extractedData.total, r.extractedData.currency || g.currency, locale)
                          : '—'}
                      </p>
                      {r.groupTotal !== null && (
                        <p className="text-xs text-muted-foreground" data-testid="pending-receipt-group-total">
                          ≈ {formatCents(r.groupTotal, r.groupCurrency, locale)}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-destructive transition-colors p-1"
                      onClick={() => {
                        if (confirm(t('detail.deleteReceiptConfirm'))) {
                          deletePending.mutate({ receiptId: r.id });
                        }
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Expenses */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t('detail.expenses')}</h2>
          <Link href={`/groups/${groupId}/expenses`} className="text-sm text-primary hover:underline">
            {t('detail.allExpenses')}
          </Link>
        </div>

        {expenses.isLoading && <LoadingSpinner />}

        {expenses.data?.expenses.length === 0 && (
          <Card>
            <CardContent className="py-8 text-center">
              <Receipt className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
              <p className="text-muted-foreground">{t('detail.noExpenses')}</p>
              <Button
                className="mt-4"
                size="sm"
                nativeButton={false}
                render={<Link href={`/groups/${groupId}/expenses/new`} />}
              >
                <Plus className="mr-2 h-4 w-4" />
                {t('detail.addFirstExpense')}
              </Button>
            </CardContent>
          </Card>
        )}

        {expenses.data && expenses.data.expenses.length > 0 && (
          <div className="space-y-3">
            <PersonFilter
              members={g.members.map((m) => ({ ...m.user }))}
              value={personFilter}
              onChange={setPersonFilter}
              myId={myId}
            />
            {days.length === 0 && (
              <Card>
                <CardContent className="py-6 text-center text-sm text-muted-foreground">
                  {t('detail.noneForFilter')}
                </CardContent>
              </Card>
            )}
            {days.map((day) => (
              <div key={day.key}>
                <p className="mb-1 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {dayLabel(day.date, locale, t('detail.today'), t('detail.yesterday'))}
                </p>
                <Card className="divide-y divide-border overflow-hidden py-0">
                  {day.items.map((expense) => (
                    <ExpenseRow
                      key={expense.id}
                      expense={expense}
                      groupId={groupId}
                      groupCurrency={g.currency}
                      members={rowMembers}
                      myId={myId}
                    />
                  ))}
                </Card>
              </div>
            ))}
          </div>
        )}
      </div>

      <InviteDialog groupId={groupId} open={showInvite} onOpenChange={setShowInvite} />

      {bankTransfer && (
        <BankTransferDialog
          open
          onOpenChange={(open) => {
            if (!open) setBankTransfer(null);
          }}
          holder={bankTransfer.holder}
          iban={bankTransfer.iban}
          amountCents={bankTransfer.amount}
          currency={g.currency}
          reference={`Splitbon: ${g.name}`}
          onPaid={() => {
            settleVenmo.mutate({
              groupId,
              fromId: bankTransfer.fromId,
              toId: bankTransfer.toId,
              amount: bankTransfer.amount,
              currency: g.currency,
              note: t('detail.settledViaBank'),
            });
            setBankTransfer(null);
          }}
        />
      )}

      <SettleDialog
        {...(settleState.from !== undefined && settleState.to !== undefined && settleState.amount !== undefined
          ? { paymentActions: settleActions(settleState.from, settleState.to, settleState.amount) }
          : {})}
        groupId={groupId}
        members={g.members.map((m) => ({ id: m.user.id, name: m.user.name ?? m.user.email }))}
        {...(settleState.from !== undefined ? { suggestedFrom: settleState.from } : {})}
        {...(settleState.to !== undefined ? { suggestedTo: settleState.to } : {})}
        {...(settleState.amount !== undefined ? { suggestedAmount: settleState.amount } : {})}
        currency={g.currency}
        open={settleState.open}
        onOpenChange={(open) => setSettleState((s) => ({ ...s, open }))}
      />
    </div>
  );
}
