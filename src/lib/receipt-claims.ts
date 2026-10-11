/**
 * What a person's picks of a receipt add up to: each picked line split equally between everyone who
 * picked it, plus tax and tip in proportion to the lines. Only an estimate until the receipt is booked.
 */
export function claimShare(args: {
  items: { id: string; totalPrice: number }[];
  claims: { receiptItemId: string; userId: string }[];
  userId: string;
  /** Tax and tip together */
  extra: number;
}): number {
  const counts = new Map<string, number>();
  for (const c of args.claims) counts.set(c.receiptItemId, (counts.get(c.receiptItemId) ?? 0) + 1);
  const mine = new Set(args.claims.filter((c) => c.userId === args.userId).map((c) => c.receiptItemId));
  const itemsSum = args.items.reduce((sum, i) => sum + i.totalPrice, 0);
  let lines = 0;
  for (const item of args.items) {
    if (mine.has(item.id)) lines += item.totalPrice / (counts.get(item.id) ?? 1);
  }
  const extra = itemsSum > 0 ? (args.extra * lines) / itemsSum : 0;
  return Math.round(lines + extra);
}

/** The picks as assignments (line -> people), for the lines someone picked. */
export function claimsToAssignments(
  claims: { receiptItemId: string; userId: string }[],
  memberIds: Set<string>,
): Record<string, Set<string>> {
  const out: Record<string, Set<string>> = {};
  for (const c of claims) {
    if (!memberIds.has(c.userId)) continue;
    (out[c.receiptItemId] ??= new Set()).add(c.userId);
  }
  return out;
}
