'use client';

import { use, useState, useMemo } from 'react';
import { useSession } from 'next-auth/react';
import { useLocale, useTranslations } from 'next-intl';
import { trpc } from '@/lib/trpc';
import { formatCents } from '@/lib/money';
import { buildVenmoPayUrl, isValidVenmoHandle } from '@/lib/venmo';
import { buildPaypalEmailUrl, buildPaypalMeUrl, isValidIban, isValidPaypalEmail } from '@/lib/payments';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import {
  BarChart3,
  History,
  Plus,
  Settings,
  UserPlus,
  Receipt,
  Handshake,
  Camera,
  Archive,
  Trash2,
  CreditCard,
  Landmark,
} from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { toast } from 'sonner';
import { InviteDialog } from '@/components/groups/invite-dialog';
import { SettleDialog } from '@/components/groups/settle-dialog';
import { BankTransferDialog } from '@/components/groups/bank-transfer-dialog';
import { ExternalPaymentConfirmation } from '@/components/groups/external-payment-confirmation';
import { OpenClaims } from '@/components/receipts/open-claims';
import { MySpendingCard } from '@/components/groups/my-spending-card';
import { BalanceStandings } from '@/components/groups/balance-standings';
import { ExpenseRow, PersonFilter, dayLabel, involves, type RowMember } from '@/components/expenses/expense-row';

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
  const [externalPayment, setExternalPayment] = useState<{
    debt: { from: string; to: string; amount: number };
    toName: string;
    kind: 'venmo' | 'paypal';
    currency: string;
  } | null>(null);

  const t = useTranslations('groups');
  const { data: authSession } = useSession();
  const group = trpc.groups.get.useQuery({ groupId });
  const expenses = trpc.expenses.list.useQuery({ groupId, limit: 50 });
  const balances = trpc.balances.getGroupBalances.useQuery({ groupId });
  const myId = authSession?.user?.id;
  // Starts on the signed-in person; 'Alle' ('') is a choice
  const [chosenFilter, setPersonFilter] = useState<string | null>(null);
  const personFilter = chosenFilter ?? myId ?? '';
  // Newest first, grouped by day; a private expense remains hidden from everyone but its payer.
  const days = useMemo(() => {
    const list = (expenses.data?.expenses ?? []).filter(
      (expense) =>
        (!expense.isPrivate || expense.paidById === myId) && (!personFilter || involves(expense, personFilter)),
    );
    const out: { key: string; date: Date; items: typeof list }[] = [];
    for (const e of list) {
      const date = new Date(e.expenseDate);
      const key = date.toLocaleDateString('sv-SE');
      const last = out[out.length - 1];
      if (last && last.key === key) last.items.push(e);
      else out.push({ key, date, items: [e] });
    }
    return out;
  }, [expenses.data, myId, personFilter]);
  const myTotals = trpc.expenses.myTotals.useQuery({
    groupId,
    ...(personFilter ? { personId: personFilter } : {}),
  });
  const debts = trpc.balances.getSimplifiedDebts.useQuery({ groupId });
  const pendingReceipts = trpc.receipts.listPending.useQuery({ groupId });
  const venmoSetting = trpc.admin.getVenmoEnabled.useQuery();
  const deletePending = trpc.receipts.deletePending.useMutation({
    onSuccess: () => {
      pendingReceipts.refetch();
      utils.receipts.listOpenClaims.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const utils = trpc.useUtils();
  const settleVenmo = trpc.settlements.create.useMutation({
    onSuccess: () => {
      setExternalPayment(null);
      setBankTransfer(null);
      utils.balances.getGroupBalances.invalidate({ groupId });
      utils.balances.getSimplifiedDebts.invalidate({ groupId });
      utils.balances.getDashboard.invalidate();
      utils.settlements.list.invalidate({ groupId });
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const requestPaymentDetails = trpc.notifications.requestPaymentDetails.useMutation({
    onSuccess: () => toast.success(t('payment.requestStored')),
    onError: (err) => toast.error(err.message),
  });

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

  // Opening a payment link never records a settlement. Explicit confirmation is required.
  function startExternalPayment(
    url: string,
    debt: { from: string; to: string; amount: number },
    toName: string,
    kind: 'venmo' | 'paypal',
  ) {
    if (externalPayment || settleVenmo.isPending) return;
    window.open(url, '_blank', 'noopener,noreferrer');
    setExternalPayment({ debt, toName, kind, currency: g.currency });
  }
  // Verwendungszweck: Gruppenname, Zahler -> Empfaenger (z.B. "Urlaub Stefan → Alex")
  function paymentReference(debt: { from: string; to: string }) {
    const nameOf = (id: string) => {
      const u = memberMap.get(id);
      const full = u?.placeholderName ?? u?.name ?? u?.email?.split('@')[0] ?? '?';
      return full.trim().split(/\s+/)[0] ?? full;
    };
    return `${g.name} ${nameOf(debt.from)} → ${nameOf(debt.to)}`;
  }
  // Ways the signed-in person can pay a debt of theirs: what the receiver has saved, as ready-made links
  function paymentOptions(debt: { from: string; to: string; amount: number }) {
    const to = memberMap.get(debt.to);
    const isMyDebt = debt.from === authSession?.user?.id;
    const reference = paymentReference(debt);
    const showVenmo =
      venmoSetting.data?.enabled &&
      g.currency === 'USD' &&
      isMyDebt &&
      to?.venmoUsername &&
      isValidVenmoHandle(to.venmoUsername);
    const venmoUrl = showVenmo ? buildVenmoPayUrl(to.venmoUsername!, debt.amount, reference) : null;
    // PayPal.me kann keinen Verwendungszweck per Link, daher zusaetzlich die E-Mail-Variante (mit item_name)
    const paypalMeUrl =
      isMyDebt && to?.paypalMeName ? buildPaypalMeUrl(to.paypalMeName, debt.amount, g.currency) : null;
    const paypalEmailUrl =
      isMyDebt && to?.paypalEmail && isValidPaypalEmail(to.paypalEmail)
        ? buildPaypalEmailUrl(to.paypalEmail, debt.amount, g.currency, reference)
        : null;
    const paypalUrl = paypalMeUrl ?? paypalEmailUrl;
    const bankIban = isMyDebt && to?.iban && isValidIban(to.iban) ? to.iban : null;
    return { isMyDebt, venmoUrl, paypalUrl, paypalMeUrl, paypalEmailUrl, reference, bankIban };
  }
  // Pay buttons inside the settle dialog, so the way to pay is found where "Zahlung erfassen" is opened
  function settleActions(from: string, to: string, amount: number) {
    const debt = { from, to, amount };
    const { isMyDebt, venmoUrl, paypalUrl, paypalMeUrl, paypalEmailUrl, reference, bankIban } = paymentOptions(debt);
    if (!isMyDebt) return null;
    const receiver = memberMap.get(to);
    const toName = receiver?.name ?? receiver?.email ?? t('detail.unknown');
    return (
      <div className="space-y-3" data-testid="settle-pay-options">
        <div className="grid gap-2 sm:grid-cols-2">
          <Button
            type="button"
            size="lg"
            className="h-auto min-h-20 justify-start gap-3 px-4 py-3 text-left"
            disabled={!paypalMeUrl || !!externalPayment || settleVenmo.isPending}
            data-testid="settle-pay-paypal"
            onClick={() => {
              if (!paypalMeUrl) return;
              // PayPal.me nimmt keinen Zweck per Link: in die Zwischenablage, zum Einfuegen bei PayPal
              void navigator.clipboard?.writeText(reference).then(
                () => toast.success(t('detail.referenceCopied', { reference })),
                () => undefined,
              );
              setSettleState((st) => ({ ...st, open: false }));
              startExternalPayment(paypalMeUrl, debt, toName, 'paypal');
            }}
          >
            <CreditCard className="h-5 w-5 shrink-0" />
            <span className="flex flex-col items-start gap-0.5">
              <span>{t('detail.payViaPaypal')}</span>
              <span className="text-xs font-normal opacity-80">
                {paypalMeUrl ? toName : t('detail.noPaymentData', { name: toName })}
              </span>
            </span>
          </Button>
          <Button
            type="button"
            size="lg"
            className="h-auto min-h-20 justify-start gap-3 px-4 py-3 text-left"
            disabled={!paypalEmailUrl || !!externalPayment || settleVenmo.isPending}
            data-testid="settle-pay-paypal-email"
            onClick={() => {
              if (!paypalEmailUrl) return;
              setSettleState((st) => ({ ...st, open: false }));
              startExternalPayment(paypalEmailUrl, debt, toName, 'paypal');
            }}
          >
            <CreditCard className="h-5 w-5 shrink-0" />
            <span className="flex flex-col items-start gap-0.5">
              <span>{t('detail.payViaPaypalEmail')}</span>
              <span className="text-xs font-normal opacity-80">
                {paypalEmailUrl ? toName : t('detail.noPaymentData', { name: toName })}
              </span>
            </span>
          </Button>
          <Button
            type="button"
            size="lg"
            className="h-auto min-h-20 justify-start gap-3 px-4 py-3 text-left"
            disabled={!bankIban || !!externalPayment || settleVenmo.isPending}
            data-testid="settle-pay-bank"
            onClick={() => {
              if (!bankIban) return;
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
            <Landmark className="h-5 w-5 shrink-0" />
            <span className="flex flex-col items-start gap-0.5">
              <span>IBAN · {t('detail.payViaBank')}</span>
              <span className="text-xs font-normal opacity-80">
                {bankIban ? receiver?.ibanHolder?.trim() || toName : t('detail.noPaymentData', { name: toName })}
              </span>
            </span>
          </Button>
        </div>
        {!paypalUrl && !bankIban && !venmoUrl && !receiver?.isPlaceholder && (
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={
              requestPaymentDetails.isPending ||
              (requestPaymentDetails.isSuccess && requestPaymentDetails.variables?.userId === to)
            }
            data-testid="request-payment-details"
            onClick={() => requestPaymentDetails.mutate({ groupId, userId: to })}
          >
            {requestPaymentDetails.isSuccess && requestPaymentDetails.variables?.userId === to
              ? t('payment.requested')
              : t('payment.requestDetails')}
          </Button>
        )}
        {venmoUrl && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!!externalPayment || settleVenmo.isPending}
            onClick={() => {
              setSettleState((st) => ({ ...st, open: false }));
              startExternalPayment(venmoUrl, debt, toName, 'venmo');
            }}
          >
            {t('detail.payViaVenmo')}
          </Button>
        )}
      </div>
    );
  }
  const rowMembers = new Map<string, RowMember>(g.members.map((m) => [m.user.id, m.user]));
  const selectedMember = personFilter ? rowMembers.get(personFilter) : undefined;
  const selectedMemberName = selectedMember
    ? (selectedMember.placeholderName ?? selectedMember.name ?? selectedMember.email ?? undefined)
    : undefined;
  const spendingScopeLabel = !personFilter
    ? t('detail.totalSpent').toLocaleLowerCase(locale)
    : personFilter === myId
      ? t('detail.myShare').toLocaleLowerCase(locale)
      : t('detail.onlyFor', { name: selectedMemberName ?? t('detail.unknown') });

  return (
    <div className="space-y-6">
      {externalPayment && (
        <ExternalPaymentConfirmation
          amount={externalPayment.debt.amount}
          currency={externalPayment.currency}
          name={externalPayment.toName}
          pending={settleVenmo.isPending}
          onDismiss={() => setExternalPayment(null)}
          onPaid={() => {
            if (settleVenmo.isPending) return;
            settleVenmo.mutate({
              groupId,
              fromId: externalPayment.debt.from,
              toId: externalPayment.debt.to,
              amount: externalPayment.debt.amount,
              currency: externalPayment.currency,
              note: externalPayment.kind === 'venmo' ? t('detail.settledViaVenmo') : t('detail.settledViaPaypal'),
            });
          }}
        />
      )}
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

      {/* Simplified Debts */}
      {debts.data && debts.data.debts.length > 0 && (
        <Card
          className="cursor-pointer transition-colors hover:bg-muted/40"
          onClick={(event) => {
            if ((event.target as HTMLElement).closest('button')) return;
            setSettleState({ open: true });
          }}
        >
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
                priorityIds={
                  myId
                    ? debts.data.debts.flatMap((debt) =>
                        debt.from === myId ? [debt.to] : debt.to === myId ? [debt.from] : [],
                      )
                    : []
                }
              />
            )}
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
          <Card>
            <CardHeader className="space-y-3 pb-3">
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="text-lg">{t('detail.expenses')}</CardTitle>
                <Link href={`/groups/${groupId}/stats`} className="text-sm text-primary hover:underline">
                  {t('detail.stats')}
                </Link>
              </div>
              <PersonFilter
                members={g.members.map((m) => ({ ...m.user }))}
                value={personFilter}
                onChange={setPersonFilter}
                myId={myId}
              />
            </CardHeader>
            <CardContent className="space-y-5">
              {myTotals.data && (
                <MySpendingCard
                  totals={myTotals.data}
                  budget={g.budgetTotal}
                  people={g.members.length}
                  currency={g.currency}
                  locale={locale}
                  paidBy={selectedMemberName}
                  scopeLabel={spendingScopeLabel}
                  all={!personFilter}
                />
              )}

              <Separator />

              {days.length === 0 ? (
                <div className="py-3 text-center text-sm text-muted-foreground">{t('detail.noneForFilter')}</div>
              ) : (
                <div className="space-y-3">
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

              <Link href={`/groups/${groupId}/expenses`} className="block text-sm text-primary hover:underline">
                {t('detail.allExpenses')}
              </Link>
            </CardContent>
          </Card>
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
          reference={paymentReference({ from: bankTransfer.fromId, to: bankTransfer.toId })}
          pending={settleVenmo.isPending}
          onPaid={() => {
            if (settleVenmo.isPending) return;
            settleVenmo.mutate({
              groupId,
              fromId: bankTransfer.fromId,
              toId: bankTransfer.toId,
              amount: bankTransfer.amount,
              currency: g.currency,
              note: t('detail.settledViaBank'),
            });
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
        suggestions={debts.data?.debts ?? []}
        onSelectSuggestion={(suggestion) =>
          setSettleState({
            open: true,
            from: suggestion.from,
            to: suggestion.to,
            amount: suggestion.amount,
          })
        }
        currency={g.currency}
        open={settleState.open}
        onOpenChange={(open) => setSettleState(open ? { open: true } : { open: false })}
      />
    </div>
  );
}
