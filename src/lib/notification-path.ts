/** Page a notification opens (without the locale): the push message and the bell use the same one. */
export function notificationPath(kind: string, groupId: string | null, entityId: string | null): string {
  if (!groupId) return '/notifications';
  if ((kind === 'CLAIM_REQUEST' || kind === 'CLAIMS_COMPLETE' || kind === 'CLAIMS_OPEN') && entityId)
    return `/groups/${groupId}/receipts/${entityId}/claim`;
  if (kind === 'SETTLEMENT' || !entityId) return `/groups/${groupId}`;
  return `/groups/${groupId}/expenses/${entityId}`;
}
