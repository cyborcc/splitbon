'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Bell, BellOff, BellRing, Check } from 'lucide-react';
import { toast } from 'sonner';
import { detectPushSupport, readPushEnvironment, type PushSupport } from '@/lib/push-support';
import { trpc } from '@/lib/trpc';
import { notificationPath } from '@/lib/notification-path';
import { Link, useRouter } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingSpinner } from '@/components/ui/loading-spinner';

const ICONS: Record<string, string> = {
  EXPENSE_ADDED: '🧾',
  PRICE_CHANGED: '💶',
  SHARE_CHANGED: '🔀',
  SETTLEMENT: '🤝',
  CLAIM_REQUEST: '🙋',
  CLAIMS_COMPLETE: '🎉',
  CLAIMS_OPEN: '⏳',
};

function keyToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Notifications of the signed-in user, and the switch for push messages on this device. */
export default function NotificationsPage() {
  const t = useTranslations('common.notifications');
  const locale = useLocale();
  const router = useRouter();
  const utils = trpc.useUtils();
  const list = trpc.notifications.list.useQuery();
  const settings = trpc.notifications.getSettings.useQuery();
  const markRead = trpc.notifications.markRead.useMutation({ onSuccess: () => utils.notifications.invalidate() });
  const setEnabled = trpc.notifications.setEnabled.useMutation({ onSuccess: () => utils.notifications.invalidate() });
  const subscribe = trpc.notifications.subscribe.useMutation({ onSuccess: () => utils.notifications.invalidate() });
  const unsubscribe = trpc.notifications.unsubscribe.useMutation({ onSuccess: () => utils.notifications.invalidate() });

  const [push, setPush] = useState<PushSupport | null>(null);
  const pushSupported = push?.supported ?? false;
  const [pushOn, setPushOn] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const detected = detectPushSupport(readPushEnvironment());
    setPush(detected);
    if (!detected.supported) return;
    navigator.serviceWorker
      .getRegistration('/sw.js')
      .then((reg) => reg?.pushManager.getSubscription())
      .then((sub) => setPushOn(!!sub))
      .catch(() => undefined);
  }, []);

  async function enablePush() {
    if (!settings.data) return;
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        toast.error(push?.ios ? t('pushDeniedIos') : t('pushDenied'));
        return;
      }
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyToBytes(settings.data.vapidPublicKey),
        }));
      const json = sub.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error('subscription');
      await subscribe.mutateAsync({ endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth });
      setPushOn(true);
      toast.success(t('pushOn'));
    } catch {
      toast.error(t('pushFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function disablePush() {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration('/sw.js');
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await unsubscribe.mutateAsync({ endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      setPushOn(false);
    } finally {
      setBusy(false);
    }
  }

  function open(n: NonNullable<typeof list.data>['items'][number]) {
    if (!n.readAt) markRead.mutate({ id: n.id });
    if (!n.groupId) return;
    router.push(notificationPath(n.type, n.groupId, n.entityId));
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        {(list.data?.unread ?? 0) > 0 && (
          <Button variant="outline" size="sm" onClick={() => markRead.mutate({})}>
            <Check className="mr-2 h-4 w-4" />
            {t('markAllRead')}
          </Button>
        )}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('settings')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">{t('which')}</p>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={settings.data?.enabled ?? true}
              disabled={!settings.data || setEnabled.isPending}
              onChange={(e) => setEnabled.mutate({ enabled: e.target.checked })}
            />
            {t('enabled')}
          </label>
          {pushSupported ? (
            pushOn ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={disablePush}>
                <BellOff className="mr-2 h-4 w-4" />
                {t('pushDisable')}
              </Button>
            ) : (
              <Button size="sm" disabled={busy || !settings.data} onClick={enablePush} data-testid="push-enable">
                <BellRing className="mr-2 h-4 w-4" />
                {t('pushEnable')}
              </Button>
            )
          ) : (
            push && (
              <p className="text-xs text-muted-foreground" data-testid="push-hint">
                {push.hint === 'ios-install'
                  ? t('pushIosInstall')
                  : push.hint === 'ios-update'
                    ? t('pushIosUpdate')
                    : t('pushUnsupported')}
              </p>
            )
          )}
        </CardContent>
      </Card>

      {list.isLoading ? (
        <LoadingSpinner />
      ) : (list.data?.items ?? []).length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            <Bell className="mx-auto mb-2 h-8 w-8" />
            {t('empty')}
          </CardContent>
        </Card>
      ) : (
        <Card className="divide-y divide-border overflow-hidden py-0">
          {(list.data?.items ?? []).map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => open(n)}
              className={`flex w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 ${n.readAt ? '' : 'bg-primary/5'}`}
              data-testid="notification-entry"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent text-lg">
                {ICONS[n.type] ?? '🔔'}
              </div>
              <div className="min-w-0 flex-1">
                <p className={`text-sm ${n.readAt ? '' : 'font-semibold'}`}>{n.title}</p>
                {n.body && <p className="text-xs text-muted-foreground">{n.body}</p>}
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                {new Date(n.createdAt).toLocaleString(locale, {
                  day: '2-digit',
                  month: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </button>
          ))}
        </Card>
      )}
      <p className="text-center text-xs">
        <Link href="/dashboard" className="text-primary hover:underline">
          {t('back')}
        </Link>
      </p>
    </div>
  );
}
