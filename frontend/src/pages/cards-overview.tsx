import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { addMonths, isBefore, isSameMonth, parseISO, startOfMonth } from 'date-fns'
import { ArrowLeft, CalendarDays, ChevronLeft, ChevronRight, CreditCard, Pencil, Plus, ReceiptText, Repeat2 } from 'lucide-react'
import { accounts as accountsApi, categories as categoriesApi, categoryGroups as categoryGroupsApi, recurring as recurringApi, transactions as transactionsApi } from '@/lib/api'
import { getAccountName } from '@/lib/account-utils'
import { formatCurrency } from '@/lib/format'
import { useDisplayLocale, useDateLocale } from '@/hooks/use-display-locale'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { useAuth } from '@/contexts/auth-context'
import { useWorkspace } from '@/contexts/workspace-context'
import { useCollectionFilter } from '@/contexts/collection-filter-context'
import { AccountIcon } from '@/components/account-icon'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { TransactionDialog } from '@/components/transaction-dialog'
import { TransferDialog } from '@/components/transfer-dialog'
import { useCreateTransaction } from '@/hooks/use-create-transaction'
import { invalidateFinancialQueries } from '@/lib/invalidate-queries'
import { extractApiError } from '@/lib/api-errors'
import { billCycleForMonth, billCycleFromKnownDates } from '@/lib/credit-card-cycle'
import { toast } from 'sonner'
import type { Account, AccountSummary, CreditCardBill, RecurringTransaction } from '@/types'

type CardSnapshot = {
  account: Account
  amount: number | null
  amountPrimary: number | null
  bill: CreditCardBill | null
  dueDate: string | null
  source: 'bank' | 'manual' | 'estimate' | 'unavailable'
}

type CycleEstimate = {
  summary?: AccountSummary
  dueDate?: string
}

const MONTHLY_FACTOR: Record<RecurringTransaction['frequency'], number> = {
  weekly: 52 / 12,
  biweekly: 26 / 12,
  monthly: 1,
  quarterly: 1 / 3,
  semiannual: 1 / 6,
  yearly: 1 / 12,
}

function amountInPrimary(account: Account, amount: number | null, primaryCurrency: string) {
  if (amount == null) return null
  if (account.currency === primaryCurrency) return amount
  const nativeReference = account.open_bill_total
  const primaryReference = account.open_bill_total_primary
  if (nativeReference && primaryReference != null) return amount * (primaryReference / nativeReference)
  return null
}

function snapshotForMonth(
  account: Account,
  bills: CreditCardBill[],
  month: Date,
  currentMonth: Date,
  primaryCurrency: string,
  estimate?: CycleEstimate,
): CardSnapshot {
  const matchingBills = bills
    .filter((bill) => isSameMonth(parseISO(bill.due_date), month))
    .sort((a, b) => Number(b.source === 'bank') - Number(a.source === 'bank') || b.due_date.localeCompare(a.due_date))
  const bill = matchingBills[0] ?? null

  if (bill) {
    return {
      account,
      amount: Number(bill.total_amount),
      amountPrimary: amountInPrimary(account, Number(bill.total_amount), primaryCurrency),
      bill,
      dueDate: bill.due_date,
      source: bill.source,
    }
  }

  if (!isBefore(month, currentMonth) && estimate?.summary) {
    const amount = Number(estimate.summary.projected_expenses ?? estimate.summary.monthly_expenses ?? 0)
    return {
      account,
      amount,
      amountPrimary: estimate.summary.projected_expenses_primary ?? estimate.summary.monthly_expenses_primary ?? amountInPrimary(account, amount, primaryCurrency),
      bill: null,
      dueDate: estimate.dueDate ?? account.next_due_date,
      source: 'estimate',
    }
  }

  if (isSameMonth(month, currentMonth)) {
    const amount = account.open_bill_total != null
      ? Number(account.open_bill_total)
      : Number(account.current_balance || 0)
    return {
      account,
      amount,
      amountPrimary: account.open_bill_total_primary ?? account.balance_primary ?? null,
      bill: null,
      dueDate: account.next_due_date,
      source: 'estimate',
    }
  }

  return { account, amount: null, amountPrimary: null, bill: null, dueDate: account.next_due_date, source: 'unavailable' }
}

function dueLabel(snapshot: CardSnapshot, locale: string) {
  const dueDate = snapshot.dueDate
  if (!dueDate) return 'Vencimento não informado'
  return `Vence em ${new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short' }).format(parseISO(dueDate))}`
}

export default function CardsOverviewPage() {
  const locale = useDisplayLocale()
  const dateLocale = useDateLocale()
  const { mask } = usePrivacyMode()
  const { user } = useAuth()
  const { activeAccountIds } = useCollectionFilter()
  const { canWrite } = useWorkspace()
  const queryClient = useQueryClient()
  const primaryCurrency = user?.preferences?.currency_display ?? 'BRL'
  const currentMonth = startOfMonth(new Date())
  const [month, setMonth] = useState(currentMonth)
  const [purchaseCard, setPurchaseCard] = useState<Account | null>(null)
  const [paymentSnapshot, setPaymentSnapshot] = useState<CardSnapshot | null>(null)
  const [billSnapshot, setBillSnapshot] = useState<CardSnapshot | null>(null)
  const [billForm, setBillForm] = useState({ closing_date: '', due_date: '', total_amount: '', status: 'open' as 'open' | 'paid' })
  const createTransaction = useCreateTransaction({ onDone: () => setPurchaseCard(null) })

  const { data: accountList, isLoading: accountsLoading } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => accountsApi.list(),
  })
  const { data: recurringList, isLoading: recurringLoading } = useQuery({
    queryKey: ['recurring'],
    queryFn: recurringApi.list,
  })
  const { data: categoryList } = useQuery({ queryKey: ['categories'], queryFn: categoriesApi.list })
  const { data: categoryGroupList } = useQuery({ queryKey: ['categoryGroups'], queryFn: categoryGroupsApi.list })

  const paymentMutation = useMutation({
    mutationFn: transactionsApi.createTransfer,
    onSuccess: () => {
      invalidateFinancialQueries(queryClient)
      setPaymentSnapshot(null)
      toast.success('Pagamento de fatura registrado')
    },
    onError: (error: unknown) => toast.error(extractApiError(error)),
  })
  const billMutation = useMutation({
    mutationFn: ({ accountId, body }: { accountId: string; body: Parameters<typeof accountsApi.saveBill>[1] }) => accountsApi.saveBill(accountId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['accounts'] })
      setBillSnapshot(null)
      toast.success('Fatura ajustada')
    },
    onError: (error: unknown) => toast.error(extractApiError(error)),
  })

  const openBillEditor = (snapshot: CardSnapshot) => {
    setBillSnapshot(snapshot)
    setBillForm({
      closing_date: snapshot.bill?.closing_date ?? '',
      due_date: snapshot.bill?.due_date ?? snapshot.account.next_due_date ?? '',
      total_amount: snapshot.amount == null ? '' : String(Math.abs(snapshot.amount)),
      status: snapshot.bill?.status ?? 'open',
    })
  }

  const cards = useMemo(() => (accountList ?? []).filter((account) =>
    account.type === 'credit_card'
    && !account.is_closed
    && (!activeAccountIds || activeAccountIds.includes(account.id)),
  ), [accountList, activeAccountIds])

  const billQueries = useQueries({
    queries: cards.map((card) => ({
      queryKey: ['accounts', card.id, 'bills'],
      queryFn: () => accountsApi.bills(card.id),
      staleTime: 1000 * 60 * 5,
    })),
  })

  const estimateCycles = useMemo(() => cards.map((card, index) => {
    const bills = billQueries[index]?.data ?? []
    const hasOfficialValue = bills.some((bill) => isSameMonth(parseISO(bill.due_date), month))
    if (hasOfficialValue || isBefore(month, currentMonth)) return null
    return billCycleForMonth(month, card.statement_close_day, card.payment_due_day)
      ?? billCycleFromKnownDates(month, bills, card.next_close_date, card.next_due_date)
  }), [cards, billQueries, month, currentMonth])

  const estimateQueries = useQueries({
    queries: cards.map((card, index) => {
      const cycle = estimateCycles[index]
      const hasPreviousBills = (billQueries[index]?.data?.length ?? 0) > 0
      return {
        queryKey: ['accounts', card.id, 'summary', cycle?.start, cycle?.end, { unbilled_only: hasPreviousBills, card_overview_estimate: true }],
        queryFn: () => accountsApi.summary(card.id, cycle!.start, cycle!.end, undefined, hasPreviousBills || undefined),
        enabled: !!cycle,
        staleTime: 1000 * 60 * 5,
      }
    }),
  })

  const snapshots = useMemo(() => cards.map((card, index) =>
    snapshotForMonth(card, billQueries[index]?.data ?? [], month, currentMonth, primaryCurrency, {
      summary: estimateQueries[index]?.data,
      dueDate: estimateCycles[index]?.dueDate,
    }),
  ), [cards, billQueries, estimateCycles, estimateQueries, month, currentMonth, primaryCurrency])

  const cardIds = useMemo(() => new Set(cards.map((card) => card.id)), [cards])
  const cardRecurring = useMemo(() => (recurringList ?? [])
    .filter((item) => item.is_active && item.type === 'debit' && item.account_id && cardIds.has(item.account_id))
    .sort((a, b) => Math.abs(b.amount * MONTHLY_FACTOR[b.frequency]) - Math.abs(a.amount * MONTHLY_FACTOR[a.frequency])),
  [recurringList, cardIds])

  const totalBills = snapshots.reduce((total, item) => {
    if (item.amount == null) return total
    if (item.account.currency === primaryCurrency) return total + item.amount
    return total + (item.amountPrimary ?? 0)
  }, 0)
  const recurringMonthly = cardRecurring.reduce((total, item) => {
    const monthly = Math.abs(item.amount) * MONTHLY_FACTOR[item.frequency]
    return total + (item.currency === primaryCurrency ? monthly : (item.amount_primary ?? 0) * MONTHLY_FACTOR[item.frequency])
  }, 0)
  const availableCredit = cards.reduce((total, card) => {
    if (card.available_credit == null) return total
    if (card.currency === primaryCurrency) return total + Number(card.available_credit)
    if (card.balance_primary != null && card.current_balance) {
      return total + Number(card.available_credit) * (card.balance_primary / card.current_balance)
    }
    return total
  }, 0)
  const missingConversions = snapshots.some((item) => item.amount != null && item.account.currency !== primaryCurrency && item.amountPrimary == null)
  const isLoading = accountsLoading || recurringLoading || billQueries.some((query) => query.isLoading) || estimateQueries.some((query) => query.isLoading)

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <Button asChild variant="ghost" size="sm" className="-ml-2 h-8 w-fit text-muted-foreground">
            <Link to="/accounts"><ArrowLeft size={15} /> Contas</Link>
          </Button>
          <h1 className="text-2xl font-semibold tracking-tight">Cartões</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Faturas, limites e compromissos recorrentes em uma única leitura mensal.
          </p>
        </div>
        <div className="flex items-center rounded-lg border border-border bg-card p-1" aria-label="Selecionar mês">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setMonth((value) => addMonths(value, -1))} aria-label="Mês anterior">
            <ChevronLeft size={16} />
          </Button>
          <div className="min-w-32 px-3 text-center text-sm font-medium capitalize tabular-nums">
            {new Intl.DateTimeFormat(dateLocale, { month: 'long', year: 'numeric' }).format(month)}
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setMonth((value) => addMonths(value, 1))} aria-label="Próximo mês">
            <ChevronRight size={16} />
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-4" aria-label="Carregando cartões">
          <Skeleton className="h-48 rounded-2xl" />
          <Skeleton className="h-72 rounded-2xl" />
        </div>
      ) : cards.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-card px-6 py-16 text-center">
          <CreditCard className="mx-auto mb-4 text-muted-foreground" size={30} />
          <h2 className="text-lg font-semibold">Nenhum cartão encontrado</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            Conecte um banco ou cadastre uma conta do tipo cartão de crédito para acompanhar as faturas aqui.
          </p>
          <Button asChild className="mt-5"><Link to="/accounts">Ir para contas</Link></Button>
        </div>
      ) : (
        <>
          <section className="overflow-hidden rounded-2xl bg-slate-950 text-white shadow-[0_18px_45px_-24px_rgba(15,23,42,0.75)] dark:bg-indigo-950">
            <div className="grid gap-8 px-5 py-6 sm:px-7 lg:grid-cols-[1.4fr_1fr] lg:items-end lg:px-8 lg:py-8">
              <div>
                <div className="mb-5 flex items-center gap-2 text-sm text-indigo-200">
                  <CalendarDays size={16} />
                  <span className="capitalize">Faturas de {new Intl.DateTimeFormat(dateLocale, { month: 'long' }).format(month)}</span>
                </div>
                <p className="text-sm text-slate-300">Total consolidado</p>
                <p className="mt-1 text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl">
                  {mask(formatCurrency(totalBills, primaryCurrency, locale))}
                </p>
                {missingConversions && (
                  <p className="mt-3 max-w-xl text-xs text-amber-200">
                    Alguns cartões em outra moeda não entraram no total porque ainda não há uma cotação disponível.
                  </p>
                )}
              </div>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-5 border-t border-white/15 pt-5 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
                <div>
                  <dt className="text-xs text-slate-300">Limite disponível</dt>
                  <dd className="mt-1 text-lg font-semibold tabular-nums">{mask(formatCurrency(availableCredit, primaryCurrency, locale))}</dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-300">Recorrentes/mês</dt>
                  <dd className="mt-1 text-lg font-semibold tabular-nums">{mask(formatCurrency(recurringMonthly, primaryCurrency, locale))}</dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-300">Cartões</dt>
                  <dd className="mt-1 text-lg font-semibold tabular-nums">{cards.length}</dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-300">Com valor bancário</dt>
                  <dd className="mt-1 text-lg font-semibold tabular-nums">{snapshots.filter((item) => item.source === 'bank').length}</dd>
                </div>
              </dl>
            </div>
          </section>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(280px,0.8fr)]">
            <section className="overflow-hidden rounded-2xl border border-border bg-card">
              <div className="flex items-center justify-between border-b border-border px-5 py-4 sm:px-6">
                <div>
                  <h2 className="font-semibold">Faturas por cartão</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">Banco primeiro; enquanto a fatura não chega, usamos as compras do ciclo.</p>
                </div>
                <span className="text-xs text-muted-foreground tabular-nums">{cards.length} {cards.length === 1 ? 'cartão' : 'cartões'}</span>
              </div>
              <div className="divide-y divide-border">
                {snapshots.map((snapshot) => {
                  const card = snapshot.account
                  const value = snapshot.amount == null ? 'Sem valor' : mask(formatCurrency(snapshot.amount, card.currency, locale))
                  const limit = card.credit_limit == null ? null : Number(card.credit_limit)
                  const used = snapshot.amount ?? 0
                  const ratio = limit && limit > 0 ? Math.min(100, Math.max(0, used / limit * 100)) : null
                  return (
                    <div key={card.id} className="group px-5 py-5 transition-colors hover:bg-muted/45 sm:px-6">
                      <div className="flex items-start gap-3">
                        <AccountIcon account={card} size="lg" />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                            <Link to={`/accounts/${card.id}`} className="min-w-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                              <h3 className="truncate text-sm font-semibold">{getAccountName(card)}</h3>
                              <p className="mt-0.5 text-xs text-muted-foreground">{dueLabel(snapshot, dateLocale)}</p>
                            </Link>
                            <div className="text-right">
                              <p className="font-semibold tabular-nums">{value}</p>
                              <Badge variant="secondary" className={snapshot.source === 'bank' ? 'mt-1 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : snapshot.source === 'manual' ? 'mt-1 bg-blue-500/10 text-blue-700 dark:text-blue-300' : snapshot.source === 'estimate' ? 'mt-1 bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'mt-1'}>
                                {snapshot.source === 'bank' ? 'Informado pelo banco' : snapshot.source === 'manual' ? `Ajuste manual · ${snapshot.bill?.status === 'paid' ? 'Paga' : 'Aberta'}` : snapshot.source === 'estimate' ? 'Estimativa pelas compras' : 'Aguardando dados'}
                              </Badge>
                            </div>
                          </div>
                          {ratio != null && (
                            <div className="mt-4">
                              <div className="mb-1.5 flex justify-between text-[11px] text-muted-foreground">
                                <span>{Math.round(ratio)}% do limite</span>
                                <span className="tabular-nums">{mask(formatCurrency(limit, card.currency, locale))}</span>
                              </div>
                              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                                <div className={`h-full rounded-full ${ratio >= 80 ? 'bg-rose-500' : ratio >= 60 ? 'bg-amber-500' : 'bg-primary'}`} style={{ width: `${ratio}%` }} />
                              </div>
                            </div>
                          )}
                          {canWrite && (
                            <div className="mt-4 flex flex-wrap gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 gap-1.5"
                                onClick={() => {
                                  createTransaction.resetForm({ account_id: card.id, type: 'debit', currency: card.currency })
                                  setPurchaseCard(card)
                                }}
                              >
                                <Plus size={14} /> Adicionar compra
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 gap-1.5"
                                onClick={() => setPaymentSnapshot(snapshot)}
                                disabled={!snapshot.amount || snapshot.amount <= 0}
                              >
                                <ReceiptText size={14} /> Pagar fatura
                              </Button>
                              <Button variant="ghost" size="sm" className="h-8 gap-1.5" onClick={() => openBillEditor(snapshot)}>
                                <Pencil size={14} /> Ajustar fatura
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>

            <section className="overflow-hidden rounded-2xl border border-border bg-card">
              <div className="flex items-start justify-between border-b border-border px-5 py-4">
                <div>
                  <h2 className="font-semibold">Compromissos recorrentes</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">Média mensal associada aos cartões.</p>
                </div>
                <Repeat2 size={18} className="mt-0.5 text-muted-foreground" />
              </div>
              {cardRecurring.length > 0 ? (
                <div className="divide-y divide-border">
                  {cardRecurring.slice(0, 6).map((item) => {
                    const monthly = Math.abs(item.amount) * MONTHLY_FACTOR[item.frequency]
                    const card = cards.find((candidate) => candidate.id === item.account_id)
                    return (
                      <div key={item.id} className="px-5 py-3.5">
                        <div className="flex items-baseline justify-between gap-3">
                          <p className="truncate text-sm font-medium">{item.description}</p>
                          <p className="shrink-0 text-sm font-semibold tabular-nums">{mask(formatCurrency(monthly, item.currency, locale))}</p>
                        </div>
                        <p className="mt-1 truncate text-xs text-muted-foreground">{card ? getAccountName(card) : 'Cartão'} · média mensal</p>
                      </div>
                    )
                  })}
                  <Button asChild variant="ghost" className="h-11 w-full rounded-none text-sm"><Link to="/recurring">Ver todas as recorrências</Link></Button>
                </div>
              ) : (
                <div className="px-5 py-10 text-center">
                  <p className="text-sm font-medium">Nenhuma recorrência vinculada</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">Cadastre assinaturas e pagamentos repetidos indicando o cartão usado.</p>
                  <Button asChild variant="outline" size="sm" className="mt-4"><Link to="/recurring">Gerenciar recorrências</Link></Button>
                </div>
              )}
            </section>
          </div>
        </>
      )}

      <TransactionDialog
        open={!!purchaseCard}
        onClose={() => setPurchaseCard(null)}
        transaction={null}
        categories={categoryList ?? []}
        categoryGroups={categoryGroupList ?? []}
        accounts={accountList ?? []}
        onSave={createTransaction.create}
        loading={createTransaction.mutation.isPending}
        error={null}
        duplicateDraft={createTransaction.duplicateDraft}
        formResetKey={createTransaction.formResetKey}
        defaultAccountId={purchaseCard?.id}
      />

      <TransferDialog
        open={!!paymentSnapshot}
        onClose={() => setPaymentSnapshot(null)}
        accounts={(accountList ?? []).filter((account) => !account.is_closed && (account.type !== 'credit_card' || account.id === paymentSnapshot?.account.id))}
        onSave={(data) => paymentMutation.mutate(data)}
        loading={paymentMutation.isPending}
        defaultFromAccountId={(accountList ?? []).find((account) => !account.is_closed && account.type !== 'credit_card')?.id}
        defaultToAccountId={paymentSnapshot?.account.id}
        defaultAmount={paymentSnapshot?.amount ?? undefined}
        defaultDescription={paymentSnapshot ? `Pagamento de fatura - ${getAccountName(paymentSnapshot.account)}` : undefined}
        lockToAccount
      />

      <Dialog open={!!billSnapshot} onOpenChange={(open) => !open && setBillSnapshot(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ajustar fatura{billSnapshot ? ` · ${getAccountName(billSnapshot.account)}` : ''}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">Informe os dados oficiais deste ciclo. Se o banco enviar a fatura depois, o valor bancário terá prioridade.</p>
          <div className="grid gap-4 py-2 sm:grid-cols-2">
            <div className="space-y-2"><Label htmlFor="bill-closing">Fechamento</Label><Input id="bill-closing" type="date" value={billForm.closing_date} onChange={(event) => setBillForm((value) => ({ ...value, closing_date: event.target.value }))} /></div>
            <div className="space-y-2"><Label htmlFor="bill-due">Vencimento</Label><Input id="bill-due" type="date" value={billForm.due_date} onChange={(event) => setBillForm((value) => ({ ...value, due_date: event.target.value }))} /></div>
            <div className="space-y-2"><Label htmlFor="bill-total">Valor da fatura</Label><Input id="bill-total" type="number" min="0.01" step="0.01" value={billForm.total_amount} onChange={(event) => setBillForm((value) => ({ ...value, total_amount: event.target.value }))} /></div>
            <div className="space-y-2"><Label htmlFor="bill-status">Situação</Label><select id="bill-status" className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm" value={billForm.status} onChange={(event) => setBillForm((value) => ({ ...value, status: event.target.value as 'open' | 'paid' }))}><option value="open">Aberta</option><option value="paid">Paga</option></select></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBillSnapshot(null)}>Cancelar</Button>
            <Button disabled={!billForm.closing_date || !billForm.due_date || !Number(billForm.total_amount) || billMutation.isPending} onClick={() => billSnapshot && billMutation.mutate({ accountId: billSnapshot.account.id, body: { ...billForm, total_amount: Number(billForm.total_amount) } })}>{billMutation.isPending ? 'Salvando…' : 'Salvar ajuste'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
