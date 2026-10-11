'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/**
 * Receipts the group is picking their lines of, so the request can be opened without the notification.
 * A dot pulses for a few seconds when something needs the person's own picks, then stays still.
 */
export function OpenClaims({ groupId, showGroup = false }: { groupId?: string; showGroup?: boolean }) {
  const t = useTranslations('expenses.claim');
  const list = trpc.receipts.listOpenClaims.useQuery(groupId ? { groupId } : undefined, { refetchInterval: 30_000 });
  const [pulse, setPulse] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setPulse(false), 6000);
    return () => clearTimeout(timer);
  }, []);

  const rows = list.data ?? [];
  if (rows.length === 0) return null;

  return (
    <section className="space-y-2" data-testid="open-claims">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{t('todoTitle')}</h2>
      {rows.map((r) => {
        const needsMe = !r.iAmDone && r.open > 0;
        const ready = r.open === 0;
        return (
          <div
            key={r.receiptId}
            className={cn(
              'flex flex-wrap items-center gap-3 rounded-xl border border-l-4 bg-card p-3',
              needsMe ? 'border-l-amber-500' : ready ? 'border-l-primary' : 'border-l-muted-foreground/30',
            )}
            data-testid={`open-claim-${r.receiptId}`}
          >
            <span className="relative flex h-2.5 w-2.5 shrink-0">
              {needsMe && pulse && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500 opacity-60" />
              )}
              <span
                className={cn(
                  'relative inline-flex h-2.5 w-2.5 rounded-full',
                  needsMe ? 'bg-amber-500' : ready ? 'bg-primary' : 'bg-muted-foreground/40',
                )}
              />
            </span>
            <div className="min-w-0 flex-1 text-sm">
              <p className="truncate font-medium">
                {showGroup && r.groupName ? `${r.groupEmoji} ${r.groupName} · ` : ''}
                {r.requestedByMe || !r.requestedByName
                  ? t('todoAskMine', { title: r.title })
                  : t('todoAsk', { name: r.requestedByName, title: r.title })}
              </p>
              <p className="text-xs text-muted-foreground">
                {ready ? t('todoAllPicked') : t('todoOpen', { count: r.open })}
                {r.iAmDone ? ` · ${t('todoDoneMine')}` : ''}
              </p>
            </div>
            {ready && r.requestedByMe ? (
              <Button
                size="sm"
                nativeButton={false}
                render={<Link href={`/groups/${r.groupId}/scan?receiptId=${r.receiptId}`} />}
              >
                {t('bookLink')}
              </Button>
            ) : (
              <Button
                size="sm"
                variant={needsMe ? 'default' : 'outline'}
                nativeButton={false}
                render={<Link href={`/groups/${r.groupId}/receipts/${r.receiptId}/claim`} />}
                data-testid={`open-claim-link-${r.receiptId}`}
              >
                {needsMe ? t('todoPick') : t('todoView')}
              </Button>
            )}
          </div>
        );
      })}
    </section>
  );
}
