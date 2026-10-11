'use client';

import { use } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowLeft, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import { formatCents } from '@/lib/money';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { LoadingSpinner } from '@/components/ui/loading-spinner';

export default function TrashPage({ params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = use(params);
  const t = useTranslations('groups');
  const locale = useLocale();
  const utils = trpc.useUtils();
  const trash = trpc.expenses.listTrash.useQuery({ groupId });
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
          {trash.data.map((item) => (
            <Card key={item.expenseId} data-testid="trash-item">
              <CardContent className="flex items-center gap-3 py-3">
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
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
