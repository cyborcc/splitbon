import webpush from 'web-push';
import type { PrismaClient } from '@/generated/prisma/client';
import { formatCents } from '@/lib/money';
import { notificationPath } from '@/lib/notification-path';
import { logger } from './logger';

/**
 * What happened. Only these reach a person: an expense they are in, a changed price, a changed split
 * (their own share), a payment to them, a request to pick their own lines of a scanned receipt.
 */
export type NotifyKind =
  | 'EXPENSE_ADDED'
  | 'PRICE_CHANGED'
  | 'SHARE_CHANGED'
  | 'SETTLEMENT'
  | 'CLAIM_REQUEST'
  | 'CLAIMS_COMPLETE'
  | 'CLAIMS_OPEN';

export type NotifyItem = {
  userId: string;
  kind: NotifyKind;
  groupId: string;
  /** Expense id (settlement id, receipt id for CLAIM_REQUEST): where the notification leads */
  entityId: string;
  vars: { actor: string; title?: string; amount?: string; share?: string; from?: string; to?: string; count?: number };
};

const TEXTS: Record<'de' | 'en', Record<NotifyKind, (v: NotifyItem['vars']) => { title: string; body: string }>> = {
  de: {
    EXPENSE_ADDED: (v) => ({
      title: `${v.actor} hat „${v.title}“ gebucht`,
      body: v.share ? `${v.amount} · dein Anteil ${v.share}` : `${v.amount}`,
    }),
    PRICE_CHANGED: (v) => ({
      title: `${v.actor} hat den Preis von „${v.title}“ geändert`,
      body: `${v.from} → ${v.to}. Bitte prüfen.`,
    }),
    SHARE_CHANGED: (v) => ({
      title: `${v.actor} hat die Aufteilung von „${v.title}“ geändert`,
      body: `Dein Anteil: ${v.from} → ${v.to}`,
    }),
    SETTLEMENT: (v) => ({ title: `${v.actor} hat dir ${v.amount} bezahlt`, body: '' }),
    CLAIM_REQUEST: (v) => ({
      title: `${v.actor} bittet dich, deine Posten zu wählen`,
      body: `„${v.title}“ · tippe, um auszuwählen`,
    }),
    CLAIMS_COMPLETE: (v) => ({
      title: `Alle Posten von „${v.title}“ sind verteilt 🎉`,
      body: 'Der Beleg kann jetzt gebucht werden.',
    }),
    CLAIMS_OPEN: (v) => ({
      title: `Bei „${v.title}“ ist noch etwas offen`,
      body: `${v.count} Posten hat noch niemand gewählt. Tippe, um nachzusehen.`,
    }),
  },
  en: {
    EXPENSE_ADDED: (v) => ({
      title: `${v.actor} added “${v.title}”`,
      body: v.share ? `${v.amount} · your share ${v.share}` : `${v.amount}`,
    }),
    PRICE_CHANGED: (v) => ({
      title: `${v.actor} changed the price of “${v.title}”`,
      body: `${v.from} → ${v.to}. Please check.`,
    }),
    SHARE_CHANGED: (v) => ({
      title: `${v.actor} changed how “${v.title}” is split`,
      body: `Your share: ${v.from} → ${v.to}`,
    }),
    SETTLEMENT: (v) => ({ title: `${v.actor} paid you ${v.amount}`, body: '' }),
    CLAIM_REQUEST: (v) => ({
      title: `${v.actor} asks you to pick your items`,
      body: `“${v.title}” · tap to choose`,
    }),
    CLAIMS_COMPLETE: (v) => ({
      title: `All items of “${v.title}” are picked 🎉`,
      body: 'The receipt can be booked now.',
    }),
    CLAIMS_OPEN: (v) => ({
      title: `Something is still open on “${v.title}”`,
      body: `${v.count} ${v.count === 1 ? 'item' : 'items'} nobody picked yet. Tap to check.`,
    }),
  },
};

export function money(cents: number, currency: string): string {
  try {
    return formatCents(cents, currency, 'de');
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/**
 * Notifications for people whose own share of an expense changed (a line was handed to someone else, a
 * split was edited), including people who dropped out of it. The person who made the change is left out.
 */
export function shareChangeItems(args: {
  before: { userId: string; amount: number }[];
  after: { userId: string; amount: number }[];
  actorId: string;
  actorName: string;
  groupId: string;
  entityId: string;
  title: string;
  currency: string;
}): NotifyItem[] {
  const sum = (rows: { userId: string; amount: number }[]) => {
    const totals = new Map<string, number>();
    for (const r of rows) totals.set(r.userId, (totals.get(r.userId) ?? 0) + r.amount);
    return totals;
  };
  const before = sum(args.before);
  const after = sum(args.after);
  const items: NotifyItem[] = [];
  for (const userId of new Set([...before.keys(), ...after.keys()])) {
    if (userId === args.actorId) continue;
    const from = before.get(userId) ?? 0;
    const to = after.get(userId) ?? 0;
    if (from === to) continue;
    items.push({
      userId,
      kind: 'SHARE_CHANGED',
      groupId: args.groupId,
      entityId: args.entityId,
      vars: {
        actor: args.actorName,
        title: args.title,
        from: money(from, args.currency),
        to: money(to, args.currency),
      },
    });
  }
  return items;
}

type VapidKeys = { publicKey: string; privateKey: string };
let vapidCache: VapidKeys | null = null;

/** VAPID keys for web push: from the environment, else generated once and kept in the database. */
export async function getVapidKeys(db: Pick<PrismaClient, 'systemSetting'>): Promise<VapidKeys> {
  if (vapidCache) return vapidCache;
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  if (publicKey && privateKey) return (vapidCache = { publicKey, privateKey });

  const stored = await db.systemSetting.findUnique({ where: { key: 'vapidKeys' } });
  if (stored) {
    try {
      const parsed = JSON.parse(stored.value) as VapidKeys;
      if (parsed.publicKey && parsed.privateKey) return (vapidCache = parsed);
    } catch {
      // regenerate below
    }
  }
  const keys = webpush.generateVAPIDKeys();
  const created = { publicKey: keys.publicKey, privateKey: keys.privateKey };
  await db.systemSetting.upsert({
    where: { key: 'vapidKeys' },
    create: { key: 'vapidKeys', value: JSON.stringify(created) },
    update: { value: JSON.stringify(created) },
  });
  return (vapidCache = created);
}

type Db = Pick<PrismaClient, 'notification' | 'pushSubscription' | 'user' | 'systemSetting'>;

/**
 * Stores a notification per person (the bell) and sends it to their registered devices (push).
 * Never throws: a failed notification must not fail the booking that caused it.
 */
export async function sendNotifications(db: Db, items: NotifyItem[]): Promise<void> {
  try {
    if (items.length === 0) return;
    const users = await db.user.findMany({
      where: { id: { in: [...new Set(items.map((i) => i.userId))] }, notifyEnabled: true, suspendedAt: null },
      select: { id: true, locale: true },
    });
    const localeOf = new Map(users.map((u) => [u.id, u.locale]));
    const wanted = items.filter((i) => localeOf.has(i.userId));
    if (wanted.length === 0) return;

    const texts = wanted.map((i) => {
      const lang = localeOf.get(i.userId)?.startsWith('de') ? 'de' : 'en';
      return { item: i, locale: localeOf.get(i.userId) ?? 'en', ...TEXTS[lang][i.kind](i.vars) };
    });
    await db.notification.createMany({
      data: texts.map(({ item, title, body }) => ({
        userId: item.userId,
        type: item.kind,
        groupId: item.groupId,
        entityId: item.entityId,
        title,
        body,
      })),
    });

    const subs = await db.pushSubscription.findMany({ where: { userId: { in: wanted.map((i) => i.userId) } } });
    if (subs.length === 0) return;
    const vapid = await getVapidKeys(db);
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT?.trim() || 'mailto:admin@example.com',
      vapid.publicKey,
      vapid.privateKey,
    );
    await Promise.all(
      subs.map(async (sub) => {
        const t = texts.find((x) => x.item.userId === sub.userId);
        if (!t) return;
        const path = `/${t.locale}${notificationPath(t.item.kind, t.item.groupId, t.item.entityId)}`;
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify({ title: t.title, body: t.body, url: path }),
            { TTL: 60 * 60 * 24 },
          );
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            await db.pushSubscription.deleteMany({ where: { endpoint: sub.endpoint } });
          } else {
            logger.warn('push.failed', { status });
          }
        }
      }),
    );
  } catch (err) {
    logger.warn('notifications.failed', { error: err instanceof Error ? err.message.slice(0, 200) : 'unknown' });
  }
}
