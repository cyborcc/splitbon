'use client';

import { Suspense, use, useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Link, useRouter } from '@/i18n/navigation';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ArrowLeft, Loader2, Camera, Users, BellRing } from 'lucide-react';
import { CorrectionChat } from '@/components/receipts/correction-chat';
import { useSession } from 'next-auth/react';
import { toast } from 'sonner';
import { ItemAssignment } from '@/components/receipts/item-assignment';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { loadingMessageKeys } from '@/lib/loading-messages';

type Step = 'upload' | 'processing' | 'assign' | 'error';

/** Scan-dialog label of a model id: Swisscom and ChatGPT choices carry a prefix, the rest is the default endpoint. */
function modelLabel(id: string): string {
  if (id.startsWith('swisscom:')) return `Swisscom · ${id.slice('swisscom:'.length)}`;
  if (id.startsWith('chatgpt:')) return `ChatGPT · ${id.slice('chatgpt:'.length)}`;
  return id;
}

export default function ScanReceiptPage({ params }: { params: Promise<{ groupId: string }> }) {
  return (
    <Suspense>
      <ScanReceiptContent params={params} />
    </Suspense>
  );
}

function ScanReceiptContent({ params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useTranslations('expenses.scan');
  const tc = useTranslations('common');
  const { data: authSession } = useSession();
  const resumeReceiptId = searchParams.get('receiptId');
  // Set when an expense that was already created from this receipt is edited (items, payer, tip).
  const editExpenseId = searchParams.get('expenseId');
  const editExpense = trpc.expenses.get.useQuery({ groupId, expenseId: editExpenseId! }, { enabled: !!editExpenseId });
  const group = trpc.groups.get.useQuery({ groupId });
  const providerInfo = trpc.receipts.getScanProviderInfo.useQuery();

  const [step, setStep] = useState<Step>(resumeReceiptId ? 'assign' : 'upload');
  const [receiptId, setReceiptId] = useState<string | null>(resumeReceiptId);
  const [errorMessage, setErrorMessage] = useState('');
  const [uploading, setUploading] = useState(false);
  const [loadingMsgIdx, setLoadingMsgIdx] = useState(0);
  const [correctionBlocked, setCorrectionBlocked] = useState(false);
  const [correctionRevision, setCorrectionRevision] = useState(0);
  const [comparing, setComparing] = useState(false);
  // Model for the next scan; remembered on this device, the server default otherwise.
  const [model, setModel] = useState('');
  const models = providerInfo.data?.models ?? [];
  useEffect(() => {
    try {
      const saved = localStorage.getItem('sharetab.scanModel');
      if (saved) setModel(saved);
    } catch {}
  }, []);
  const chosenModel = models.includes(model) ? model : undefined;
  function pickModel(value: string) {
    setModel(value);
    try {
      localStorage.setItem('sharetab.scanModel', value);
    } catch {}
  }
  const utils = trpc.useUtils();

  // Rotate loading messages while processing
  useEffect(() => {
    if (step !== 'processing') return;
    setLoadingMsgIdx(Math.floor(Math.random() * loadingMessageKeys.length));
    const interval = setInterval(() => {
      setLoadingMsgIdx((i) => (i + 1) % loadingMessageKeys.length);
    }, 5000);
    return () => clearInterval(interval);
  }, [step]);

  const processReceipt = trpc.receipts.processReceipt.useMutation({
    onSuccess: () => setStep('assign'),
    onError: (err) => {
      setErrorMessage(err.message);
      setStep('error');
    },
  });

  const shareForClaiming = trpc.guest.createClaimSession.useMutation();
  // Asks the group to pick their own lines; the person asking picks theirs next
  const startClaimRequest = trpc.receipts.startClaimRequest.useMutation({
    onSuccess: ({ notified }) => {
      toast.success(t('claimRequestSent', { count: notified }));
      if (receiptId) router.push(`/groups/${groupId}/receipts/${receiptId}/claim`);
    },
    onError: (err) => toast.error(err.message),
  });
  const receiptData = trpc.receipts.getReceiptItems.useQuery(
    { receiptId: receiptId! },
    { enabled: step === 'assign' && !!receiptId },
  );

  async function handleShareForClaiming() {
    if (!receiptId || !receiptData.data) return;
    const { receipt, items } = receiptData.data;
    const extracted = receipt.extractedData;
    if (!extracted) return;

    const currentMembers = members.filter((m) => m.name);
    if (currentMembers.length < 1) return;

    const myId = authSession?.user?.id;
    const myMember = myId ? currentMembers.find((m) => m.id === myId) : undefined;
    const myName = myMember?.name ?? authSession?.user?.name ?? currentMembers[0]?.name ?? 'Unknown';

    try {
      const result = await shareForClaiming.mutateAsync({
        receiptId,
        receiptData: {
          merchantName: extracted.merchantName,
          date: extracted.date,
          subtotal: extracted.subtotal,
          tax: extracted.tax,
          tip: extracted.tip ?? 0,
          total: extracted.total ?? extracted.subtotal + extracted.tax + (extracted.tip ?? 0),
          currency: extracted.currency ?? 'USD',
        },
        items: items.map((i) => ({
          name: i.name,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
          totalPrice: i.totalPrice,
        })),
        creatorName: myName,
        paidByName: myName,
      });
      router.push(`/split/${result.shareToken}/claim`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('createSessionFailed'));
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setErrorMessage('');

    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        let message = t('uploadFailed');
        try {
          const data = await res.json();
          message = data.error ?? message;
        } catch {}
        throw new Error(message);
      }

      const data = await res.json();
      setReceiptId(data.receiptId);
      setStep('processing');
      setUploading(false);

      // Start AI processing with groupId
      processReceipt.mutate({ receiptId: data.receiptId, groupId, ...(chosenModel ? { model: chosenModel } : {}) });
    } catch (err) {
      setUploading(false);
      setErrorMessage(err instanceof Error ? err.message : t('uploadFailed'));
      setStep('error');
    }
  }

  function handleExpenseCreated() {
    router.push(editExpenseId ? `/groups/${groupId}/expenses/${editExpenseId}` : `/groups/${groupId}`);
  }

  const members =
    group.data?.members.map((m) => ({
      id: m.user.id,
      name: m.user.placeholderName ?? m.user.name ?? m.user.email,
      image: m.user.image,
    })) ?? [];

  const configuredProviderChain = providerInfo.data?.configuredProviders?.join(' -> ') ?? 'loading...';
  const activeProvider = providerInfo.data?.activeProvider ?? 'checking...';

  // Loading state for group data (Finding #22)
  if (group.isLoading) {
    return (
      <div className="mx-auto max-w-lg flex flex-col items-center gap-4 py-20">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-muted-foreground">{t('loadingGroup')}</p>
      </div>
    );
  }

  // Error state for group data (Finding #22)
  if (group.error) {
    return (
      <div className="mx-auto max-w-lg space-y-6">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            aria-label={tc('actions.back')}
            nativeButton={false}
            render={<Link href={`/groups/${groupId}`} />}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
        </div>
        <Card className="border-destructive/50">
          <CardContent className="py-6">
            <p className="text-destructive">{t('groupLoadError')}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className={`mx-auto space-y-6 ${comparing && step === 'assign' ? 'max-w-lg md:max-w-6xl' : 'max-w-lg'}`}>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" nativeButton={false} render={<Link href={`/groups/${groupId}`} />}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
      </div>

      {step === 'upload' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Camera className="h-5 w-5" />
              {t('upload')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('uploadDescription')}</p>
            <p className="text-xs text-muted-foreground">
              {t('activeProvider')} <span className="font-medium text-foreground">{activeProvider}</span>
              {' · '}
              {t('fallbackChain')} <span className="font-medium text-foreground">{configuredProviderChain}</span>
            </p>

            {models.length > 1 && (
              <div className="space-y-2">
                <Label htmlFor="scan-model">{t('model')}</Label>
                <select
                  id="scan-model"
                  value={chosenModel ?? models[0]}
                  onChange={(e) => pickModel(e.target.value)}
                  disabled={uploading}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
                  data-testid="scan-model-select"
                >
                  {models.map((m, i) => (
                    <option key={m} value={m}>
                      {i === 0 ? `${modelLabel(m)} (${t('modelDefault')})` : modelLabel(m)}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">{t('modelHint')}</p>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="receipt">{t('receiptImage')}</Label>
              <Input
                id="receipt"
                type="file"
                accept="image/jpeg,image/png,image/webp,image/heic"
                onChange={handleFileUpload}
                disabled={uploading}
                className="cursor-pointer"
                data-testid="scan-file-input"
              />
            </div>

            {uploading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('uploading')}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {step === 'processing' && (
        <Card data-testid="scan-processing">
          <CardContent className="flex flex-col items-center gap-4 py-12">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <div className="text-center space-y-2">
              <p className="font-medium">{t('processing')}</p>
              <p className="text-xs text-muted-foreground">
                {t('using')}{' '}
                <span className="font-medium text-foreground">
                  {activeProvider}
                  {chosenModel ? ` (${chosenModel})` : ''}
                </span>
                {' · '}
                {t('chain')} <span className="font-medium text-foreground">{configuredProviderChain}</span>
              </p>
              <p className="text-sm text-muted-foreground">
                {tc(loadingMessageKeys[loadingMsgIdx] ?? loadingMessageKeys[0])}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'assign' && receiptId && (
        <>
          <CorrectionChat
            key={receiptId}
            receiptId={receiptId}
            groupId={groupId}
            onBlocked={setCorrectionBlocked}
            onApplied={async () => {
              await Promise.all([
                utils.receipts.getReceiptItems.invalidate({ receiptId }),
                utils.receipts.getConversionPreview.invalidate({ receiptId }),
              ]);
              setCorrectionRevision((v) => v + 1);
            }}
          />
          <fieldset disabled={correctionBlocked} className={correctionBlocked ? 'pointer-events-none opacity-60' : ''}>
            {editExpenseId && !editExpense.data ? (
              <LoadingSpinner />
            ) : (
              <ItemAssignment
                key={`${receiptId}:${correctionRevision}:${editExpenseId ?? ''}`}
                groupId={groupId}
                receiptId={receiptId}
                members={members}
                currentUserId={authSession?.user?.id}
                groupCurrency={group.data?.currency}
                onCompareChange={setComparing}
                onComplete={handleExpenseCreated}
                onSaveForLater={() => router.push(`/groups/${groupId}`)}
                {...(editExpenseId && editExpense.data
                  ? {
                      expenseId: editExpenseId,
                      initial: {
                        title: editExpense.data.title,
                        paidById: editExpense.data.paidById,
                        amount: editExpense.data.amount,
                        category: editExpense.data.category,
                        charged:
                          (editExpense.data.receipt?.extractedData as { cardCharge?: { amount?: number } } | null)
                            ?.cardCharge?.amount ?? null,
                        place: {
                          placeName: editExpense.data.placeName ?? '',
                          latitude: editExpense.data.latitude ?? null,
                          longitude: editExpense.data.longitude ?? null,
                        },
                      },
                    }
                  : {})}
              />
            )}
          </fieldset>
          <div className="flex items-center gap-2 text-muted-foreground">
            <div className="flex-1 h-px bg-border" />
            <span className="text-xs">{t('or')}</span>
            <div className="flex-1 h-px bg-border" />
          </div>
          <Button
            className="w-full"
            onClick={() => receiptId && startClaimRequest.mutate({ receiptId })}
            disabled={
              correctionBlocked ||
              startClaimRequest.isPending ||
              !!editExpenseId ||
              !receiptData.data?.items?.length ||
              members.length < 2
            }
            data-testid="start-claim-request-btn"
          >
            <BellRing className="mr-2 h-4 w-4" />
            {startClaimRequest.isPending ? t('claimRequestSending') : t('startClaimRequest')}
          </Button>
          <p className="-mt-2 text-center text-xs text-muted-foreground">{t('startClaimRequestHint')}</p>
          <Button
            variant="outline"
            className="w-full"
            onClick={handleShareForClaiming}
            disabled={
              correctionBlocked ||
              shareForClaiming.isPending ||
              !authSession?.user?.id ||
              !receiptData.data?.receipt?.extractedData ||
              !receiptData.data?.items?.length ||
              members.length < 1
            }
            data-testid="group-share-claiming-btn"
          >
            <Users className="mr-2 h-4 w-4" />
            {shareForClaiming.isPending ? t('creatingSession') : t('shareForClaiming')}
          </Button>
        </>
      )}

      {step === 'error' && (
        <Card className="border-destructive/50">
          <CardContent className="space-y-4 py-6">
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{errorMessage}</div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep('upload')}>
                {t('retry')}
              </Button>
              {receiptId && (
                <Button
                  onClick={() => {
                    setStep('processing');
                    processReceipt.mutate({ receiptId, groupId, ...(chosenModel ? { model: chosenModel } : {}) });
                  }}
                >
                  {t('retryProcessing')}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
