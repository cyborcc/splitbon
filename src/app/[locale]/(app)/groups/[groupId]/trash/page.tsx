'use client';

import { use, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowLeft, ChevronDown, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import { formatCents } from '@/lib/money';
import { cn } from '@/lib/utils';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { LoadingSpinner } from '@/components/ui/loading-spinner';

export default function TrashPage({ params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = use(params);
  const t = useTranslations('groups');
  const locale = useLocale();
  const utils = trpc.useUtils();
  const group = trpc.groups.get.useQuery({ groupId });
  const trash = trpc.expenses.listTrash.useQuery({ groupId });
  const [open, setOpen] = useState<string | null>(null);
  const restore = trpc.expenses.restore.useMutation({
    onSuccess: async () => {
      toast.success(t('trash.restored'));
      await Promise.all([
        utils.expenses.listTrash.invalidate({ groupId }),
        utils.expenses.list.invalidate(),
        utils.balances.invalidate(),
      ]);
    },
    onError: (err) => toast.error(err.message),
  });
  const groupCurrency = group.data?.currency;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" nativeButton={false} render={<Link href={`/groups/${groupId}`} />}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Trash2 className="h-6 w-6" /> {t('trash.title')}
        </h1>
      </div>
      <p className="text-sm text-muted-foreground">{t('trash.hint')}</p>

      {trash.isLoading ? (
        <LoadingSpinner />
      ) : !trash.data?.length ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground" data-testid="trash-empty">
            {t('trash.empty')}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2" data-testid="trash-list">
          {trash.data.map((item) => {
            const isOpen = open === item.expenseId;
            const d = item.details;
            return (
              <Card key={item.expenseId} data-testid="trash-item">
                <CardContent className="py-3">
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      onClick={() => setOpen(isOpen ? null : item.expenseId)}
                      aria-expanded={isOpen}
                      data-testid="trash-item-toggle"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{item.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatCents(item.amount, item.currency, locale)}
                          {' · '}
                          {item.deletedByName
                            ? t('trash.deletedBy', {
                                name: item.deletedByName,
                                date: new Date(item.deletedAt).toLocaleDateString(locale),
                              })
                            : new Date(item.deletedAt).toLocaleDateString(locale)}
                          {' · '}
                          {t('trash.daysLeft', { count: item.daysLeft })}
                        </p>
                      </div>
                      <ChevronDown
                        className={cn(
                          'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
                          isOpen && 'rotate-180',
                        )}
                      />
                    </button>
                    {item.canRestore && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={restore.isPending}
                        onClick={() => restore.mutate({ groupId, expenseId: item.expenseId })}
                        data-testid="trash-restore-btn"
                      >
                        <RotateCcw className="h-4 w-4 sm:mr-2" />
                        <span className="hidden sm:inline">{t('trash.restore')}</span>
                      </Button>
                    )}
                  </div>
                  {isOpen && d && (
                    <dl
                      className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t pt-3 text-sm"
                      data-testid="trash-item-details"
                    >
                      <dt className="text-muted-foreground">{t('trash.date')}</dt>
                      <dd>{new Date(d.expenseDate).toLocaleDateString(locale)}</dd>
                      {d.paidByName && (
                        <>
                          <dt className="text-muted-foreground">{t('trash.paidBy')}</dt>
                          <dd>{d.paidByName}</dd>
                        </>
                      )}
                      {d.baseCurrencyAmount !== null && groupCurrency && (
                        <>
                          <dt className="text-muted-foreground">{t('trash.inGroupCurrency')}</dt>
                          <dd>{formatCents(d.baseCurrencyAmount, groupCurrency, locale)}</dd>
                        </>
                      )}
                      {d.category && (
                        <>
                          <dt className="text-muted-foreground">{t('trash.category')}</dt>
                          <dd>{d.category}</dd>
                        </>
                      )}
                      {d.placeName && (
                        <>
                          <dt className="text-muted-foreground">{t('trash.place')}</dt>
                          <dd>📍 {d.placeName}</dd>
                        </>
                      )}
                      {d.description && (
                        <>
                          <dt className="text-muted-foreground">{t('trash.note')}</dt>
                          <dd className="whitespace-pre-wrap">{d.description}</dd>
                        </>
                      )}
                      {d.hasReceipt && (
                        <>
                          <dt className="text-muted-foreground">{t('trash.receipt')}</dt>
                          <dd>🧾 {t('trash.receiptKept')}</dd>
                        </>
                      )}
                      <dt className="col-span-2 mt-2 font-medium">{t('trash.shares')}</dt>
                      {d.shares.map((sh, i) => (
                        <div key={i} className="col-span-2 flex justify-between">
                          <span>{sh.name ?? '?'}</span>
                          <span className="tabular-nums">{formatCents(sh.amount, item.currency, locale)}</span>
                        </div>
                      ))}
                    </dl>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
