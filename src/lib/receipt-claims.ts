export type Claim = { receiptItemId: string; userId: string; units?: number };

/**
 * Units of a line nobody has picked yet: a line of one is open until someone picks it (sharing it is
 * fine), a line of several until the picked units add up to its quantity.
 */
export function openUnits(quantity: number, claims: { units?: number }[]): number {
  if (claims.length === 0) return Math.max(quantity, 1);
  if (quantity <= 1) return 0;
  const picked = claims.reduce((sum, c) => sum + (c.units ?? 1), 0);
  return Math.max(quantity - picked, 0);
}

/**
 * What a person's picks of a receipt add up to: each line split between everyone who picked it in
 * proportion to their units, plus tax and tip in proportion to the lines. An estimate until booked.
 */
export function claimShare(args: {
  items: { id: string; totalPrice: number }[];
  claims: Claim[];
  userId: string;
  /** Tax and tip together */
  extra: number;
}): number {
  const unitsOnLine = new Map<string, number>();
  for (const c of args.claims)
    unitsOnLine.set(c.receiptItemId, (unitsOnLine.get(c.receiptItemId) ?? 0) + (c.units ?? 1));
  const mine = new Map(args.claims.filter((c) => c.userId === args.userId).map((c) => [c.receiptItemId, c.units ?? 1]));
  const itemsSum = args.items.reduce((sum, i) => sum + i.totalPrice, 0);
  let lines = 0;
  for (const item of args.items) {
    const units = mine.get(item.id);
    if (units) lines += (item.totalPrice * units) / (unitsOnLine.get(item.id) ?? units);
  }
  const extra = itemsSum > 0 ? (args.extra * lines) / itemsSum : 0;
  return Math.round(lines + extra);
}

/** The picks as assignments (line -> people) and units (line -> person -> units above 1). */
export function claimsToAssignments(
  claims: Claim[],
  memberIds: Set<string>,
): { assignments: Record<string, Set<string>>; counts: Record<string, Record<string, number>> } {
  const assignments: Record<string, Set<string>> = {};
  const counts: Record<string, Record<string, number>> = {};
  for (const c of claims) {
    if (!memberIds.has(c.userId)) continue;
    (assignments[c.receiptItemId] ??= new Set()).add(c.userId);
    if ((c.units ?? 1) > 1) (counts[c.receiptItemId] ??= {})[c.userId] = c.units!;
  }
  return { assignments, counts };
}
