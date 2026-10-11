'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { trpc } from '@/lib/trpc';
import { formatCents, centsToDecimal, parseToCents, parseAmountInput, sanitizeAmountInput } from '@/lib/money';
import { calculateSplitTotals } from '@/lib/split-calculator';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LocationField, type PlaceValue } from '@/components/expenses/location-field';
import { CategorySelect } from '@/components/expenses/category-select';
import { Separator } from '@/components/ui/separator';
import { UserAvatar } from '@/components/ui/user-avatar';
import { memberChipColors } from '@/lib/avatar';
import {
  Check,
  Users,
  Pencil,
  Trash2,
  Plus,
  Image as ImageIcon,
  Scissors,
  Bookmark,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { toast } from 'sonner';
import { useOrderedCurrencies } from '@/lib/use-ordered-currencies';
import { ReceiptRatePreview } from './receipt-rate-preview';
import { ReceiptHistory, scrollToItem } from './receipt-history';
import { claimsToAssignments } from '@/lib/receipt-claims';
import { Link } from '@/i18n/navigation';

type Member = { id: string; name: string | null; image?: string | null | undefined };

type Assignments = Record<string, Set<string>>; // receiptItemId -> Set<userId>
type Counts = Record<string, Record<string, number>>; // receiptItemId -> userId -> units (absent = 1)

// A malformed OCR label must not prevent the user from reaching its correction
// selector. Keep the original label visible rather than substituting a currency.
function formatReceiptCents(amount: number, currency: string, locale: string): string {
  try {
    return formatCents(amount, currency, locale);
  } catch {
    return `${centsToDecimal(amount)} ${currency || '?'}`;
  }
}

export function ItemAssignment({
  groupId,
  receiptId,
  members,
  onComplete,
  onSaveForLater,
  expenseId,
  initial,
  currentUserId,
  onCompareChange,
  groupCurrency,
}: {
  groupId: string;
  receiptId: string;
  members: Member[];
  onComplete: () => void;
  onSaveForLater?: () => void;
  /** Set when an expense that was already created from this receipt is edited. */
  expenseId?: string;
  /** Values of that expense; the form starts from them instead of the receipt defaults. */
  initial?: {
    title: string;
    paidById: string;
    amount: number;
    place: PlaceValue;
    category?: string | null;
    /** Amount the card was charged (group currency cents), if it was entered */
    charged?: number | null;
  };
  /** The logged-in user: pays by default when nothing was saved yet. */
  currentUserId?: string | undefined;
  /** Currency the group settles in; a receipt in another currency can take the amount the card was charged. */
  groupCurrency?: string | undefined;
  /** Told when the receipt is shown next to the recognized values, so the page can widen. */
  onCompareChange?: (on: boolean) => void;
}) {
  const locale = useLocale();
  const t = useTranslations('expenses.receipt');
  const currencyOptions = useOrderedCurrencies(groupId, groupCurrency);
  const receiptData = trpc.receipts.getReceiptItems.useQuery({ receiptId });
  const history = trpc.receipts.history.useQuery({ receiptId });
  // What the group picked themselves ("everyone picks their own lines"), refreshed while that runs
  const claims = trpc.receipts.getClaims.useQuery(
    { receiptId },
    { enabled: !expenseId, refetchInterval: (q) => (q.state.data?.requestedAt ? 5000 : false) },
  );
  const utils = trpc.useUtils();
  const refreshItems = () =>
    Promise.all([
      utils.receipts.getReceiptItems.invalidate({ receiptId }),
      utils.receipts.history.invalidate({ receiptId }),
    ]);

  const [assignments, setAssignments] = useState<Assignments>({});
  const [counts, setCounts] = useState<Counts>({});
  const countOf = (itemId: string, userId: string) => counts[itemId]?.[userId] ?? 1;
  const countsFrom = (list: { id: string; assignments?: { userId: string; shareOfItem?: number }[] }[]) => {
    const out: Counts = {};
    for (const item of list) {
      for (const a of item.assignments ?? []) {
        if ((a.shareOfItem ?? 1) > 1) out[item.id] = { ...(out[item.id] ?? {}), [a.userId]: a.shareOfItem! };
      }
    }
    return out;
  };
  const weightsFor = (itemId: string, userIds: Set<string>) => Array.from(userIds).map((u) => countOf(itemId, u));
  const [title, setTitle] = useState('');
  const [place, setPlace] = useState<PlaceValue>({ placeName: '', latitude: null, longitude: null });
  const tExp = useTranslations('expenses');
  // Receipts are mostly restaurant bills: the first preset category ("Essen") unless changed.
  const [category, setCategory] = useState<string>(
    () => initial?.category ?? (tExp.raw('new.categoryPresets') as string[])[0] ?? '',
  );
  const [paidById, setPaidById] = useState('');
  const [tipOverride, setTipOverride] = useState<string>('');
  // What was paid in total (with tip): the tip is whatever the items and tax leave over.
  const [paidTotalStr, setPaidTotalStr] = useState<string>('');
  const [showImage, setShowImage] = useState(false);
  const [flashItem, setFlashItem] = useState<string | null>(null);
  // Paid by card in a foreign currency: what the bank actually charged replaces the reference rate.
  const [useCharged, setUseCharged] = useState(!!initial?.charged);
  const [chargedStr, setChargedStr] = useState(initial?.charged ? centsToDecimal(initial.charged) : '');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const lastTouchDist = useRef<number | null>(null);
  const imageContainerRef = useRef<HTMLDivElement>(null);
  const [editingItem, setEditingItem] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<{ name: string; quantity: string; totalPrice: string }>({
    name: '',
    quantity: '',
    totalPrice: '',
  });
  const [addingItem, setAddingItem] = useState(false);
  const [newItem, setNewItem] = useState({ name: '', quantity: '1', totalPrice: '' });
  const [splittingItem, setSplittingItem] = useState<string | null>(null);
  const [splitQuantity, setSplitQuantity] = useState('');

  const [useLatestRate, setUseLatestRate] = useState(false);
  const conversionPreview = trpc.receipts.getConversionPreview.useQuery(
    { groupId, receiptId, useLatestRate },
    {
      enabled: !!receiptData.data?.receipt.extractedData,
      staleTime: 0,
      refetchInterval: 60000,
    },
  );
  const correctCurrency = trpc.receipts.correctCurrency.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.receipts.getReceiptItems.invalidate({ receiptId }),
        utils.receipts.getConversionPreview.invalidate({ receiptId }),
      ]);
    },
    onError: (e) => toast.error(e.message),
  });
  const createExpense = trpc.receipts.assignItemsAndCreateExpense.useMutation({
    onSuccess: onComplete,
    onError: (e) => {
      toast.error(e.message);
      utils.receipts.getConversionPreview.invalidate({ receiptId });
    },
  });
  const updateItem = trpc.receipts.updateItem.useMutation({
    onSuccess: () => {
      setEditingItem(null);
      refreshItems();
    },
    onError: (e) => toast.error(e.message),
  });
  const deleteItem = trpc.receipts.deleteItem.useMutation({
    onSuccess: () => refreshItems(),
    onError: (e) => toast.error(e.message),
  });
  const addItem = trpc.receipts.addItem.useMutation({
    onSuccess: () => {
      setAddingItem(false);
      setNewItem({ name: '', quantity: '1', totalPrice: '' });
      refreshItems();
    },
    onError: (e) => toast.error(e.message),
  });
  const splitItem = trpc.receipts.splitItem.useMutation({
    onSuccess: () => refreshItems(),
    onError: (e) => toast.error(e.message),
  });
  const saveForLater = trpc.receipts.saveForLater.useMutation({
    onSuccess: () => onSaveForLater?.(),
    onError: (e) => toast.error(e.message),
  });

  // Toggle the image. Zoom/pan reset on every toggle (fresh view when
  // opening, cleanup when hiding), and the visibility flip is a functional
  // update so rapid successive clicks can't act on a stale captured value.
  function setCompare(on: boolean) {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setShowImage(on);
    onCompareChange?.(on);
  }
  function toggleImage() {
    setCompare(!showImage);
  }

  // Wheel zoom — must be non-passive to call preventDefault
  useEffect(() => {
    const el = imageContainerRef.current;
    if (!el || !showImage) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      setZoom((z) => Math.min(Math.max(z * factor, 1), 5));
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [showImage]);

  // Restore saved state (paidById, assignments) when receipt data loads.
  // Runs on every data change but only sets state when server data has values
  // and local state hasn't been set yet. This handles the case where the first
  // render gets cached data (without paidById) and the refetch brings fresh data.
  const hasRestoredRef = useRef(false);

  useEffect(() => {
    if (!receiptData.data || hasRestoredRef.current) return;
    const data = receiptData.data;

    if (initial) {
      // Editing an existing expense: start from what was saved, not from the receipt defaults.
      setTitle(initial.title);
      setPaidById(initial.paidById);
      setPlace(initial.place);
      const restoredAssignments: Assignments = {};
      for (const item of data.items) {
        if (item.assignments && item.assignments.length > 0) {
          restoredAssignments[item.id] = new Set(item.assignments.map((a: { userId: string }) => a.userId));
        }
      }
      setAssignments(restoredAssignments);
      setCounts(countsFrom(data.items));
      // The saved total may contain a tip that differs from the receipt: keep it as an override.
      const ex = data.receipt.extractedData;
      if (ex) {
        const assignedSum = data.items.reduce(
          (sum: number, item: { id: string; totalPrice: number }) =>
            sum + (restoredAssignments[item.id] ? item.totalPrice : 0),
          0,
        );
        const savedTip = initial.amount - assignedSum - ex.tax;
        if (savedTip >= 0 && savedTip !== ex.tip) setTipOverride(centsToDecimal(savedTip));
      }
      hasRestoredRef.current = true;
      return;
    }

    if (data.receipt.extractedData?.merchantName && !title) {
      setTitle(data.receipt.extractedData.merchantName);
    }

    const hasSavedPaidBy = !!data.receipt.paidById;
    const hasSavedAssignments = data.items.some(
      (item: { assignments?: unknown[] }) => item.assignments && item.assignments.length > 0,
    );

    if (hasSavedPaidBy || hasSavedAssignments) {
      if (hasSavedPaidBy) {
        setPaidById(data.receipt.paidById!);
      }
      const restored: Assignments = {};
      for (const item of data.items) {
        if (item.assignments && item.assignments.length > 0) {
          restored[item.id] = new Set(item.assignments.map((a: { userId: string }) => a.userId));
        }
      }
      if (Object.keys(restored).length > 0) {
        setAssignments(restored);
        setCounts(countsFrom(data.items));
      }
      hasRestoredRef.current = true;
    }
  }, [receiptData.data, title, initial]);

  useEffect(() => {
    if (!flashItem) return;
    const timer = setTimeout(() => setFlashItem(null), 2000);
    return () => clearTimeout(timer);
  }, [flashItem]);

  // Nothing saved yet: the logged-in member paid.
  useEffect(() => {
    if (!receiptData.data || initial || receiptData.data.receipt.paidById) return;
    if (currentUserId && members.some((m) => m.id === currentUserId)) {
      setPaidById((prev) => prev || currentUserId);
    }
  }, [receiptData.data, initial, currentUserId, members]);

  // On a wide screen the receipt opens next to the recognized values; a link to a line
  // (#item-…, e.g. from the history) scrolls to it once the lines are there.
  const openedRef = useRef(false);
  useEffect(() => {
    if (!receiptData.data || openedRef.current) return;
    openedRef.current = true;
    if (receiptData.data.receipt.imagePath && window.matchMedia('(min-width: 768px)').matches) setCompare(true);
    const hash = window.location.hash;
    if (hash.startsWith('#item-')) {
      const itemId = hash.slice('#item-'.length);
      setTimeout(() => {
        scrollToItem(itemId);
        setFlashItem(itemId);
      }, 300);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once when the receipt has loaded
  }, [receiptData.data]);

  const { receipt, items } = receiptData.data ?? { receipt: null, items: [] };
  const extracted = receipt?.extractedData ?? null;
  const hasDigits = (value: string) => /\d/.test(value);
  const paidTotalCents = hasDigits(paidTotalStr) ? parseAmountInput(paidTotalStr) : null;
  const baseCents = items.reduce((sum, item) => sum + item.totalPrice, 0) + (extracted?.tax ?? 0);
  // The paid total wins over a typed tip; a total below items plus tax means no tip
  const tipInputCents: number | undefined =
    paidTotalCents !== null
      ? Math.max(0, paidTotalCents - baseCents)
      : hasDigits(tipOverride)
        ? parseAmountInput(tipOverride)
        : undefined;
  const paidTotalTooLow = paidTotalCents !== null && paidTotalCents < baseCents;
  const tip = extracted && tipInputCents !== undefined ? tipInputCents : (extracted?.tip ?? 0);

  // Note (Finding #29): toggleAssignment and assignAllToEveryone are intentionally
  // duplicated from split/page.tsx. This component uses Record<string, Set<string>>
  // (id-based) while split/page uses Record<number, Set<number>> (index-based).
  // The different key types make a shared abstraction more complex than the duplication.
  // Tapping a person adds them; on a line with several units each further tap adds one unit
  // (2 of 3 coffees), and tapping at the line's quantity removes the person again.
  function toggleAssignment(itemId: string, userId: string) {
    const quantity = Math.max(1, items.find((it) => it.id === itemId)?.quantity ?? 1);
    const isAssigned = assignments[itemId]?.has(userId) ?? false;
    const current = countOf(itemId, userId);
    if (isAssigned && current < quantity) {
      setCounts((prev) => ({ ...prev, [itemId]: { ...(prev[itemId] ?? {}), [userId]: current + 1 } }));
      return;
    }
    setCounts((prev) => {
      const forItem = { ...(prev[itemId] ?? {}) };
      delete forItem[userId];
      return { ...prev, [itemId]: forItem };
    });
    setAssignments((prev) => {
      const next = { ...prev };
      const set = new Set(next[itemId] ?? []);
      if (isAssigned) {
        set.delete(userId);
      } else {
        set.add(userId);
      }
      next[itemId] = set;
      return next;
    });
  }

  function assignAllToEveryone() {
    setCounts({});
    const next: Assignments = {};
    for (const item of items) {
      next[item.id] = new Set(members.map((m) => m.id));
    }
    setAssignments(next);
  }

  function startEditing(item: { id: string; name: string; quantity: number; totalPrice: number }) {
    setEditingItem(item.id);
    setEditValues({
      name: item.name,
      quantity: String(item.quantity),
      totalPrice: centsToDecimal(item.totalPrice),
    });
  }

  function saveEdit(itemId: string) {
    const trimmedName = editValues.name.trim();
    if (!trimmedName) {
      toast.error(t('validationNameRequired'));
      return;
    }
    const totalPrice = parseToCents(editValues.totalPrice);
    if (totalPrice <= 0) {
      toast.error(t('validationPricePositive'));
      return;
    }
    const quantity = parseInt(editValues.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      toast.error(t('validationQtyPositive'));
      return;
    }
    updateItem.mutate({
      itemId,
      name: trimmedName,
      quantity,
      totalPrice,
      unitPrice: Math.round(totalPrice / quantity),
    });
  }

  function handleAddItem() {
    const totalPrice = parseToCents(newItem.totalPrice);
    const quantity = parseInt(newItem.quantity) || 1;
    if (!newItem.name.trim() || totalPrice <= 0 || quantity < 1) return;
    addItem.mutate({
      receiptId,
      name: newItem.name.trim(),
      quantity,
      unitPrice: Math.round(totalPrice / quantity),
      totalPrice,
    });
  }

  // Calculate per-person totals using shared calculateSplitTotals (Finding #30).
  // Memoized to avoid recomputation on every render (Finding #36).
  const perPersonTotals = useMemo(() => {
    // Build member-id -> index mapping for calculateSplitTotals
    const memberIdToIndex = new Map<string, number>();
    members.forEach((m, i) => memberIdToIndex.set(m.id, i));

    const assignmentList = Object.entries(assignments)
      .filter(([, userIds]) => userIds.size > 0)
      .map(([receiptItemId, userIds]) => {
        const itemIdx = items.findIndex((it) => it.id === receiptItemId);
        const known = Array.from(userIds).filter((uid) => memberIdToIndex.has(uid));
        return {
          itemIndex: itemIdx,
          personIndices: known.map((uid) => memberIdToIndex.get(uid)!),
          weights: known.map((uid) => counts[receiptItemId]?.[uid] ?? 1),
        };
      })
      .filter((a) => a.itemIndex >= 0 && a.personIndices.length > 0);

    const results = calculateSplitTotals({
      items,
      assignments: assignmentList,
      tax: extracted?.tax ?? 0,
      tip,
      peopleCount: members.length,
    });

    // Map back from person indices to member IDs
    const totals = new Map<string, number>();
    for (const r of results) {
      const member = members[r.personIndex];
      if (member) totals.set(member.id, r.total);
    }
    return totals;
  }, [items, assignments, counts, members, extracted, tip]);
  const assignedItemCount = Object.values(assignments).filter((s) => s.size > 0).length;
  const allAssigned = items.length > 0 && assignedItemCount === items.length;

  if (receiptData.isLoading) {
    return <p className="text-muted-foreground">{t('loadingItems')}</p>;
  }
  if (!receiptData.data) {
    return <p className="text-destructive">{t('noReceiptData')}</p>;
  }
  if (!extracted) {
    return <p className="text-destructive">{t('noExtractedData')}</p>;
  }

  // After early returns, these are guaranteed non-null
  const safeReceipt = receipt!;
  const safeExtracted = extracted;
  const previewMatchesCurrency =
    conversionPreview.data?.currency.toUpperCase() === safeExtracted.currency.toUpperCase();
  const previewReady =
    previewMatchesCurrency && !conversionPreview.isFetching && !correctCurrency.isPending && !conversionPreview.isError;
  const euroQuote = previewReady ? conversionPreview.data?.euro : null;
  const groupQuote = previewReady ? conversionPreview.data?.groupRate : null;
  const itemsSum = items.reduce((sum, item) => sum + item.totalPrice, 0);
  const currentTotal = itemsSum + safeExtracted.tax + tip;
  // Printed total if there is one, else the printed subtotal, against what the lines add up to
  const sumGap =
    safeExtracted.total > 0
      ? safeExtracted.total - (itemsSum + safeExtracted.tax + safeExtracted.tip)
      : safeExtracted.subtotal - itemsSum;
  // Lines someone changed by hand after the scan
  const changedItems = new Set(
    (history.data ?? []).flatMap((h) => {
      const m = h.metadata as { action?: string; itemId?: string; changes?: { itemId: string }[] };
      if (h.type !== 'RECEIPT_ITEMS_CHANGED') return [];
      if (m.action === 'assign') return [];
      return m.itemId ? [m.itemId] : [];
    }),
  );
  const de = locale.startsWith('de');
  const settleCurrency = (groupQuote?.to ?? groupCurrency ?? '').toUpperCase();
  const foreignReceipt = !!settleCurrency && settleCurrency !== safeExtracted.currency.toUpperCase();
  const charged = useCharged && foreignReceipt ? parseAmountInput(chargedStr) : 0;
  const chargedOk = charged > 0 && currentTotal > 0;
  // Rate used to show amounts in the group currency: the card's if entered, else the reference rate
  const chargedRate = chargedOk ? charged / currentTotal : null;
  const shownRate = chargedRate ?? (foreignReceipt ? (groupQuote?.rate ?? null) : null);
  const rateReady = chargedOk || (previewReady && !!groupQuote);
  const formatRate = (rate: number) => rate.toLocaleString(locale, { maximumSignificantDigits: 4 });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!paidById || !allAssigned || !rateReady) return;

    createExpense.mutate({
      useLatestRate,
      ...(groupQuote ? { expectedConversion: groupQuote } : {}),
      ...(chargedOk ? { chargedAmount: charged } : {}),
      groupId,
      receiptId,
      ...(expenseId ? { expenseId } : {}),
      title,
      paidById,
      category: category.trim(),
      ...(place.placeName.trim() ? { placeName: place.placeName.trim() } : {}),
      ...(place.latitude !== null && place.longitude !== null
        ? { latitude: place.latitude, longitude: place.longitude }
        : {}),
      tipOverride: tipInputCents,
      assignments: Object.entries(assignments)
        .filter(([, userIds]) => userIds.size > 0)
        .map(([receiptItemId, userIds]) => ({
          receiptItemId,
          userIds: Array.from(userIds),
          weights: weightsFor(receiptItemId, userIds),
        })),
    });
  }

  function handleSaveForLater() {
    saveForLater.mutate({
      groupId,
      receiptId,
      paidById: paidById || null,
      assignments: Object.entries(assignments)
        .filter(([, userIds]) => userIds.size > 0)
        .map(([receiptItemId, userIds]) => ({
          receiptItemId,
          userIds: Array.from(userIds),
          weights: weightsFor(receiptItemId, userIds),
        })),
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={showImage ? 'md:grid md:grid-cols-2 md:items-start md:gap-6' : ''}
      data-testid="item-assignment-form"
    >
      {/* The receipt next to (wide screen) or above (phone, stays while scrolling) the recognized values */}
      {showImage && safeReceipt.imagePath && (
        <div className="sticky top-0 z-20 mb-4 bg-background pb-2 md:top-4 md:mb-0" data-testid="receipt-compare">
          <Card>
            <CardContent className="p-0 overflow-hidden rounded-lg">
              <div
                ref={imageContainerRef}
                className="relative h-[38vh] overflow-hidden rounded-t-lg bg-muted/30 md:h-[calc(100vh-9rem)]"
                style={{
                  cursor: isDragging ? 'grabbing' : 'grab',
                  touchAction: 'none',
                  userSelect: 'none',
                }}
                onMouseDown={(e) => {
                  setIsDragging(true);
                  dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
                }}
                onMouseMove={(e) => {
                  if (!isDragging || !dragStart.current) return;
                  setPan({
                    x: dragStart.current.panX + e.clientX - dragStart.current.x,
                    y: dragStart.current.panY + e.clientY - dragStart.current.y,
                  });
                }}
                onMouseUp={() => {
                  setIsDragging(false);
                  dragStart.current = null;
                }}
                onMouseLeave={() => {
                  setIsDragging(false);
                  dragStart.current = null;
                }}
                onDoubleClick={() => {
                  setZoom(1);
                  setPan({ x: 0, y: 0 });
                }}
                onTouchStart={(e) => {
                  if (e.touches.length === 2) {
                    const touch0 = e.touches[0];
                    const touch1 = e.touches[1];
                    if (!touch0 || !touch1) return;
                    const dx = touch0.clientX - touch1.clientX;
                    const dy = touch0.clientY - touch1.clientY;
                    lastTouchDist.current = Math.sqrt(dx * dx + dy * dy);
                  } else {
                    const touch0 = e.touches[0];
                    if (!touch0) return;
                    dragStart.current = { x: touch0.clientX, y: touch0.clientY, panX: pan.x, panY: pan.y };
                  }
                }}
                onTouchMove={(e) => {
                  if (e.touches.length === 2 && lastTouchDist.current !== null) {
                    const touch0 = e.touches[0];
                    const touch1 = e.touches[1];
                    if (!touch0 || !touch1) return;
                    const dx = touch0.clientX - touch1.clientX;
                    const dy = touch0.clientY - touch1.clientY;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    const factor = dist / lastTouchDist.current;
                    setZoom((z) => Math.min(Math.max(z * factor, 1), 5));
                    lastTouchDist.current = dist;
                  } else if (e.touches.length === 1 && dragStart.current) {
                    const touch0 = e.touches[0];
                    if (!touch0) return;
                    setPan({
                      x: dragStart.current.panX + touch0.clientX - dragStart.current.x,
                      y: dragStart.current.panY + touch0.clientY - dragStart.current.y,
                    });
                  }
                }}
                onTouchEnd={() => {
                  lastTouchDist.current = null;
                  dragStart.current = null;
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- user-uploaded
                      receipt photo with unknown natural dimensions, rendered inside a
                      pinch-zoom/pan viewport; next/image would need either server-side
                      dimension probing or a fill+aspect-ratio layout change, out of scope
                      here */}
                <img
                  src={`/api/uploads/${safeReceipt.imagePath}`}
                  alt={t('receiptImageAlt')}
                  draggable={false}
                  className="h-full w-full object-contain pointer-events-none"
                  style={{
                    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                    transformOrigin: 'center center',
                    transition: isDragging ? 'none' : 'transform 0.05s ease-out',
                  }}
                />
              </div>
              <div className="flex items-center justify-between gap-2 border-t px-3 py-1.5 text-xs text-muted-foreground">
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    aria-label={t('zoomOut')}
                    onClick={() => setZoom((z) => Math.max(z / 1.25, 1))}
                  >
                    <ZoomOut className="h-3.5 w-3.5" />
                  </Button>
                  <span className="w-10 text-center">{Math.round(zoom * 100)}%</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    aria-label={t('zoomIn')}
                    onClick={() => setZoom((z) => Math.min(z * 1.25, 5))}
                  >
                    <ZoomIn className="h-3.5 w-3.5" />
                  </Button>
                  {zoom > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => {
                        setZoom(1);
                        setPan({ x: 0, y: 0 });
                      }}
                    >
                      {t('resetView')}
                    </Button>
                  )}
                </div>
                {safeReceipt.aiProvider && (
                  <span className="truncate">{t('recognizedBy', { provider: safeReceipt.aiProvider })}</span>
                )}
                <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={toggleImage}>
                  {t('hideImage')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <div className="min-w-0 space-y-4">
        {safeReceipt.imagePath && !showImage && (
          <Button type="button" variant="outline" size="sm" onClick={toggleImage} data-testid="compare-receipt-btn">
            <ImageIcon className="mr-2 h-4 w-4" />
            {t('compareReceipt')}
          </Button>
        )}

        {/* Receipt summary */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{t('receiptSummary')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div className="space-y-2 pb-2">
              <Label htmlFor="receipt-currency">{de ? 'Belegwährung korrigieren' : 'Correct receipt currency'}</Label>
              <select
                id="receipt-currency"
                className="w-full rounded-md border bg-background p-2"
                value={safeExtracted.currency.toUpperCase()}
                disabled={correctCurrency.isPending || createExpense.isPending}
                // Only a label changes and it can be changed back, so no confirmation is needed
                onChange={(e) => correctCurrency.mutate({ receiptId, currency: e.target.value })}
              >
                {!currencyOptions.some((c) => c.code === safeExtracted.currency.toUpperCase()) && (
                  <option value={safeExtracted.currency.toUpperCase()}>{safeExtracted.currency}</option>
                )}
                {currencyOptions.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code} — {c.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {de
                  ? 'Ändert nur die Währung, nicht die Beträge. Danach wird die Euro-Vorschau neu berechnet.'
                  : 'Changes the label, not the amounts. Euro preview is recalculated afterwards.'}
              </p>
            </div>
            {safeExtracted.merchantName && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('merchant')}</span>
                <span>{safeExtracted.merchantName}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('subtotal')}</span>
              <span>{formatReceiptCents(safeExtracted.subtotal, safeExtracted.currency, locale)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('tax')}</span>
              <span>{formatReceiptCents(safeExtracted.tax, safeExtracted.currency, locale)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('tip')}</span>
              <span>{formatReceiptCents(tip, safeExtracted.currency, locale)}</span>
            </div>
            <Separator />
            <div className="flex justify-between font-semibold">
              <span>{t('total')}</span>
              <span>{formatReceiptCents(currentTotal, safeExtracted.currency, locale)}</span>
            </div>
            {/* Recognized lines against the printed sums: a gap means a line was misread or missed */}
            <div className="space-y-0.5 rounded-md bg-muted/40 p-2 text-xs" data-testid="receipt-check">
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('checkItemsSum', { count: items.length })}</span>
                <span>{formatReceiptCents(itemsSum, safeExtracted.currency, locale)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('checkSubtotal')}</span>
                <span>{formatReceiptCents(safeExtracted.subtotal, safeExtracted.currency, locale)}</span>
              </div>
              {safeExtracted.total > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('checkTotal')}</span>
                  <span>{formatReceiptCents(safeExtracted.total, safeExtracted.currency, locale)}</span>
                </div>
              )}
              {sumGap === 0 ? (
                <p className="pt-1 font-medium text-emerald-600 dark:text-emerald-400">{t('checkOk')}</p>
              ) : (
                <p className="pt-1 font-medium text-amber-600 dark:text-amber-400">
                  {t('checkGap', { amount: formatReceiptCents(sumGap, safeExtracted.currency, locale) })}
                </p>
              )}
            </div>
            <ReceiptRatePreview
              amount={currentTotal}
              quote={euroQuote}
              locale={locale}
              loading={conversionPreview.isFetching || correctCurrency.isPending}
            />
            {groupQuote && groupQuote.to !== 'EUR' && (
              <p className="text-xs text-muted-foreground">
                {de ? 'Gruppenkurs' : 'Group rate'}: 1 {groupQuote.from} = {groupQuote.rate} {groupQuote.to} ·{' '}
                {groupQuote.source} · {groupQuote.rateDate}
                {groupQuote.source === 'ExchangeRate-API' && (
                  <>
                    {' '}
                    ·{' '}
                    <a
                      href="https://www.exchangerate-api.com"
                      className="underline"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Rates By Exchange Rate API
                    </a>
                  </>
                )}
              </p>
            )}
            {foreignReceipt && (
              <div className="mt-2 space-y-2 rounded-md border border-dashed p-3" data-testid="card-charge">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    checked={useCharged}
                    onChange={(e) => setUseCharged(e.target.checked)}
                    data-testid="card-charge-toggle"
                  />
                  💳 {t('cardChargeToggle')}
                </label>
                {useCharged && (
                  <>
                    <div className="flex items-center gap-2">
                      <Input
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        placeholder="0,00"
                        value={chargedStr}
                        onChange={(e) => setChargedStr(sanitizeAmountInput(e.target.value))}
                        className="w-32"
                        data-testid="card-charge-input"
                      />
                      <span className="text-sm">{settleCurrency}</span>
                      <span className="text-xs text-muted-foreground">
                        {t('cardChargeFor', {
                          amount: formatReceiptCents(currentTotal, safeExtracted.currency, locale),
                        })}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">{t('cardChargeExplain')}</p>
                    {chargedRate !== null && (
                      <p className="text-xs">
                        {t('cardChargeRate', {
                          from: safeExtracted.currency.toUpperCase(),
                          rate: formatRate(chargedRate),
                          to: settleCurrency,
                        })}
                        {groupQuote && groupQuote.rate > 0 && (
                          <span className="text-muted-foreground">
                            {' '}
                            {t('cardChargeVsReference', {
                              rate: formatRate(groupQuote.rate),
                              diff: `${chargedRate >= groupQuote.rate ? '+' : ''}${(
                                (chargedRate / groupQuote.rate - 1) *
                                100
                              ).toLocaleString(locale, { maximumFractionDigits: 1 })} %`,
                            })}
                          </span>
                        )}
                      </p>
                    )}
                  </>
                )}
              </div>
            )}
            {safeExtracted.date && !chargedOk && (
              <label className="flex items-start gap-2 pt-2 text-xs">
                <input
                  type="checkbox"
                  checked={useLatestRate}
                  onChange={(e) => setUseLatestRate(e.target.checked)}
                  disabled={createExpense.isPending || correctCurrency.isPending}
                />
                <span>
                  {de
                    ? `Aktuellen Kurs ausdrücklich als Schätzung statt des historischen Kurses vom ${safeExtracted.date.slice(0, 10)} verwenden (gedruckte Belegkurse bleiben bevorzugt).`
                    : `Explicitly use the latest rate as an estimate instead of the historical rate for ${safeExtracted.date.slice(0, 10)} (printed receipt rates still take priority).`}
                </span>
              </label>
            )}
            {!chargedOk && !conversionPreview.isFetching && (!groupQuote || conversionPreview.isError) && (
              <p className="text-xs text-destructive">
                {de
                  ? 'Speichern erst mit gültiger Kursvorschau möglich.'
                  : 'Saving requires a valid conversion preview.'}
              </p>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => conversionPreview.refetch()}
              disabled={conversionPreview.isFetching || correctCurrency.isPending}
            >
              {de ? 'Kurs erneut laden' : 'Retry rate lookup'}
            </Button>
            {safeExtracted.alternateTotals
              .filter((alternateTotal) => alternateTotal.currency !== safeExtracted.currency)
              .map((alternateTotal) => (
                <div key={alternateTotal.currency} className="flex justify-between font-semibold text-primary">
                  <span>
                    {t('total')} ({alternateTotal.currency})
                  </span>
                  <span>{formatReceiptCents(alternateTotal.total, alternateTotal.currency, locale)}</span>
                </div>
              ))}
          </CardContent>
        </Card>

        {/* Expense details */}
        <Card>
          <CardContent className="space-y-3 pt-4">
            <div className="space-y-2">
              <Label htmlFor="title">{t('expenseTitle')}</Label>
              <Input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('expenseTitlePlaceholder')}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="category">{tExp('new.category')}</Label>
              <CategorySelect value={category} onChange={setCategory} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="location">{tExp('new.location')}</Label>
              <LocationField
                value={place}
                onChange={setPlace}
                category={category}
                groupId={groupId}
                suggestion={[safeExtracted.merchantName, safeExtracted.merchantAddress].filter(Boolean).join(', ')}
                autoPick={!!safeExtracted.merchantAddress}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="paidBy">{t('paidBy')}</Label>
              <select
                id="paidBy"
                value={paidById}
                onChange={(e) => setPaidById(e.target.value)}
                required
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
                data-testid="paid-by-select"
              >
                <option value="">{t('selectMember')}</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name ?? t('unnamed')}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="tip">{t('tipOverride')}</Label>
              <Input
                id="tip"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                placeholder={t('tipDetected', {
                  amount: formatReceiptCents(safeExtracted.tip, safeExtracted.currency, locale),
                })}
                value={paidTotalCents !== null ? centsToDecimal(tip) : tipOverride}
                disabled={paidTotalCents !== null}
                onChange={(e) => setTipOverride(sanitizeAmountInput(e.target.value))}
                data-testid="tip-input"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="paid-total">{t('paidTotal')}</Label>
              <Input
                id="paid-total"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                placeholder={formatReceiptCents(baseCents + safeExtracted.tip, safeExtracted.currency, locale)}
                value={paidTotalStr}
                onChange={(e) => setPaidTotalStr(sanitizeAmountInput(e.target.value))}
                data-testid="paid-total-input"
              />
              <p className="text-xs text-muted-foreground" data-testid="paid-total-hint">
                {paidTotalTooLow
                  ? t('paidTotalTooLow', { amount: formatReceiptCents(baseCents, safeExtracted.currency, locale) })
                  : paidTotalCents !== null
                    ? t('tipFromTotal', { amount: formatReceiptCents(tip, safeExtracted.currency, locale) })
                    : t('paidTotalHint')}
              </p>
            </div>
          </CardContent>
        </Card>

        {!expenseId && claims.data && (claims.data.requestedAt || claims.data.claims.length > 0) && (
          <Card className="border-primary/40" data-testid="claim-status">
            <CardContent className="space-y-2 py-3 text-sm">
              <p>
                {claims.data.claims.length === 0
                  ? t('claimNone')
                  : t('claimStatus', {
                      people: new Set(claims.data.claims.map((c) => c.userId)).size,
                      items: new Set(claims.data.claims.map((c) => c.receiptItemId)).size,
                      total: items.length,
                    })}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={claims.data.claims.length === 0}
                  onClick={() => {
                    const picked = claimsToAssignments(claims.data!.claims, new Set(members.map((m) => m.id)));
                    setAssignments((prev) => ({ ...prev, ...picked.assignments }));
                    setCounts((prev) => {
                      const next = { ...prev };
                      for (const itemId of Object.keys(picked.assignments)) delete next[itemId];
                      return { ...next, ...picked.counts };
                    });
                    toast.success(t('claimsApplied'));
                  }}
                  data-testid="apply-claims-btn"
                >
                  <Check className="mr-2 h-4 w-4" />
                  {t('applyClaims')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  nativeButton={false}
                  render={<Link href={`/groups/${groupId}/receipts/${receiptId}/claim`} />}
                >
                  {t('pickOwn')}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Quick actions */}
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={assignAllToEveryone} data-testid="split-all-btn">
            <Users className="mr-2 h-4 w-4" />
            {t('splitAllEqually')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setAddingItem(true)}
            data-testid="add-item-btn"
          >
            <Plus className="mr-2 h-4 w-4" />
            {t('addItem')}
          </Button>
        </div>

        {/* Add new item form */}
        {addingItem && (
          <Card className="border-primary/50" data-testid="add-item-form">
            <CardContent className="py-3">
              <div
                className="space-y-2"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && !addItem.isPending) {
                    e.preventDefault();
                    handleAddItem();
                  }
                }}
              >
                <div className="flex gap-2">
                  <Input
                    placeholder={t('itemNamePlaceholder')}
                    value={newItem.name}
                    onChange={(e) => setNewItem((p) => ({ ...p, name: e.target.value }))}
                    className="flex-1"
                  />
                  <Input
                    type="number"
                    placeholder={t('qtyPlaceholder')}
                    value={newItem.quantity}
                    onChange={(e) => setNewItem((p) => ({ ...p, quantity: e.target.value }))}
                    className="w-16"
                    min="1"
                  />
                  <Input
                    type="number"
                    step="0.01"
                    placeholder={t('pricePlaceholder')}
                    value={newItem.totalPrice}
                    onChange={(e) => setNewItem((p) => ({ ...p, totalPrice: e.target.value }))}
                    className="w-24"
                  />
                </div>
                <div className="flex gap-2">
                  <Button type="button" size="sm" disabled={addItem.isPending} onClick={handleAddItem}>
                    {addItem.isPending ? t('adding') : t('add')}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setAddingItem(false)}>
                    {t('cancel')}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Item assignment */}
        <div className="space-y-2">
          <Label>{t('assignItems', { assigned: assignedItemCount, total: items.length })}</Label>
          {items.map((item) => {
            const assigned = assignments[item.id] ?? new Set();
            const isEditing = editingItem === item.id;

            return (
              <Card
                key={item.id}
                id={`item-${item.id}`}
                className={`scroll-mt-[45vh] transition-shadow md:scroll-mt-4 ${assigned.size === 0 ? 'border-amber-300' : ''} ${
                  flashItem === item.id ? 'ring-2 ring-primary' : ''
                }`}
                data-testid={`item-card-${item.id}`}
              >
                <CardContent className="py-3">
                  {isEditing ? (
                    <div className="mb-2 space-y-2">
                      <div className="flex gap-2">
                        <Input
                          value={editValues.name}
                          onChange={(e) => setEditValues((p) => ({ ...p, name: e.target.value }))}
                          className="flex-1"
                          placeholder={t('itemNamePlaceholder')}
                        />
                        <Input
                          type="number"
                          value={editValues.quantity}
                          onChange={(e) => setEditValues((p) => ({ ...p, quantity: e.target.value }))}
                          className="w-16"
                          placeholder={t('qtyPlaceholder')}
                          min="1"
                        />
                        <Input
                          type="number"
                          step="0.01"
                          value={editValues.totalPrice}
                          onChange={(e) => setEditValues((p) => ({ ...p, totalPrice: e.target.value }))}
                          className="w-24"
                          placeholder={t('pricePlaceholder')}
                        />
                      </div>
                      <div className="flex gap-1">
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => saveEdit(item.id)}
                          disabled={updateItem.isPending}
                        >
                          {t('save')}
                        </Button>
                        <Button type="button" variant="ghost" size="sm" onClick={() => setEditingItem(null)}>
                          {t('cancel')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="mb-2 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{item.name}</span>
                        {item.quantity > 1 && <span className="text-xs text-muted-foreground">x{item.quantity}</span>}
                        {changedItems.has(item.id) && (
                          <span
                            className="rounded bg-amber-100 px-1 text-[10px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                            title={t('changedHint')}
                          >
                            {t('changedBadge')}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => startEditing(item)}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (confirm(t('removeConfirm', { name: item.name }))) {
                              deleteItem.mutate({ itemId: item.id });
                            }
                          }}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                        {item.quantity > 1 && (
                          <button
                            type="button"
                            onClick={() => {
                              setSplittingItem(item.id);
                              setSplitQuantity('1');
                            }}
                            className="text-muted-foreground hover:text-foreground"
                            title={t('split')}
                            aria-label={t('splitAriaLabel', { name: item.name })}
                            data-testid={`split-btn-${item.id}`}
                          >
                            <Scissors className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                      <span className="text-right font-semibold">
                        {formatReceiptCents(item.totalPrice, safeExtracted.currency, locale)}
                        {shownRate !== null && (
                          <span
                            className="block text-xs font-normal text-muted-foreground"
                            data-testid={`item-group-amount-${item.id}`}
                          >
                            {chargedRate !== null ? '= ' : '≈ '}
                            {formatReceiptCents(Math.round(item.totalPrice * shownRate), settleCurrency, locale)}
                          </span>
                        )}
                      </span>
                    </div>
                  )}
                  {!isEditing &&
                    splittingItem === item.id &&
                    (() => {
                      const parsed = Number(splitQuantity);
                      const validQty = Number.isSafeInteger(parsed) && parsed >= 1 && parsed < item.quantity;
                      return (
                        <div className="mb-2 flex items-center gap-2" data-testid="split-form">
                          <span className="text-xs text-muted-foreground">{t('splitOff')}</span>
                          <Input
                            type="number"
                            min={1}
                            max={item.quantity - 1}
                            value={splitQuantity}
                            onChange={(e) => setSplitQuantity(e.target.value)}
                            className="w-16 h-7 text-xs"
                            data-testid="split-qty-input"
                          />
                          <span className="text-xs text-muted-foreground">
                            {t('splitOfTotal', { total: item.quantity })}
                          </span>
                          <Button
                            type="button"
                            size="sm"
                            className="h-7 text-xs"
                            disabled={splitItem.isPending || !validQty}
                            data-testid="split-submit"
                            onClick={() => {
                              if (!validQty) return;
                              splitItem.mutate({ itemId: item.id, splitQuantity: parsed });
                              setSplittingItem(null);
                            }}
                          >
                            {t('split')}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => setSplittingItem(null)}
                          >
                            {t('cancel')}
                          </Button>
                        </div>
                      );
                    })()}
                  <div className="flex flex-wrap gap-1.5">
                    {members.map((m) => {
                      const isAssigned = assigned.has(m.id);
                      const units = isAssigned ? countOf(item.id, m.id) : 0;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => toggleAssignment(item.id, m.id)}
                          title={item.quantity > 1 ? t('tapToCount') : undefined}
                          data-testid={`member-toggle-${m.id}`}
                          className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs transition-colors ${
                            isAssigned ? '' : 'bg-muted text-muted-foreground hover:bg-muted/80'
                          }`}
                          {...(isAssigned ? { style: memberChipColors(m.image, m.id) } : {})}
                        >
                          <UserAvatar image={m.image} id={m.id} name={m.name} className="h-4 w-4" />
                          {m.name?.split(' ')[0] ?? '?'}
                          {isAssigned &&
                            (units > 1 ? (
                              <span className="font-semibold">×{units}</span>
                            ) : (
                              <Check className="h-3 w-3" />
                            ))}
                        </button>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Per-person summary */}
        {perPersonTotals.size > 0 && (
          <Card data-testid="per-person-totals">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{t('perPersonTotals')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {members.map((m) => {
                const total = perPersonTotals.get(m.id);
                if (!total) return null;
                return (
                  <div key={m.id} className="flex justify-between text-sm">
                    <span>{m.name ?? t('unnamed')}</span>
                    <span className="font-medium">
                      {formatReceiptCents(total, safeExtracted.currency, locale)}
                      {shownRate !== null && (
                        <span className={chargedRate !== null ? 'ml-2' : 'ml-2 font-normal text-muted-foreground'}>
                          {chargedRate !== null ? '= ' : '≈ '}
                          {formatReceiptCents(Math.round(total * shownRate), settleCurrency, locale)}
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}
              {chargedRate !== null && (
                <p className="pt-1 text-xs text-muted-foreground">
                  {t('cardChargeShared', { amount: formatReceiptCents(charged, settleCurrency, locale) })}
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {createExpense.error && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{createExpense.error.message}</div>
        )}

        <Button
          type="submit"
          className="w-full"
          disabled={createExpense.isPending || !allAssigned || !paidById || !rateReady}
          data-testid="create-expense-btn"
        >
          {createExpense.isPending
            ? expenseId
              ? t('updatingExpense')
              : t('creatingExpense')
            : !allAssigned
              ? t('assignAllItems', { remaining: items.length - assignedItemCount })
              : expenseId
                ? t('saveChanges')
                : t('createExpense')}
        </Button>

        {onSaveForLater && !expenseId && (
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={handleSaveForLater}
            disabled={saveForLater.isPending}
            data-testid="save-for-later-btn"
          >
            <Bookmark className="mr-2 h-4 w-4" />
            {saveForLater.isPending ? t('saving') : t('saveForLater')}
          </Button>
        )}

        <ReceiptHistory
          entries={history.data ?? []}
          members={members}
          currency={safeExtracted.currency}
          existingItemIds={new Set(items.map((i) => i.id))}
          onShowItem={(itemId) => {
            scrollToItem(itemId);
            setFlashItem(itemId);
          }}
        />
      </div>
    </form>
  );
}
