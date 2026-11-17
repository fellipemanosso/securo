import { useState, useMemo } from 'react'
import { accountCardLabel, getAccountName } from '@/lib/account-utils'
import { useParams, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useDisplayLocale, useDateLocale } from '@/hooks/use-display-locale'
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { format, addDays, addMonths, endOfMonth, parseISO, startOfMonth, subMonths } from 'date-fns'
import { accounts, dashboard, transactions, categories as categoriesApi, categoryGroups as categoryGroupsApi } from '@/lib/api'
import { localDateString } from '@/lib/date-utils'
import { applyTransactionToBalance, excludeMaterializedProjections, mergeRunningBalances, runningBalanceChartFrom, transactionAmountForBalance } from '@/lib/account-detail-utils'
import { invalidateFinancialQueries } from '@/lib/invalidate-queries'
import { shouldShowPendingBadge } from '@/lib/transaction-status'
import { isTransferTransaction } from '@/lib/transaction-transfer'
import { toast } from 'sonner'
import type { Account, CreditCardTimelineItem, ProjectedTransaction, Transaction } from '@/types'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { ArrowLeft, ArrowLeftRight, CalendarClock, Check, ChevronLeft, ChevronRight, Clock, EyeClosed, HelpCircle, Loader2, Paperclip, Pencil, Plus, X } from 'lucide-react'
import { MobileTransactionRow } from '@/components/mobile-transaction-row'
import { AccountCardsControl } from '@/components/account-cards-control'
import { transactionDescription } from '@/lib/transaction-description'
import { CategoryIcon } from '@/components/category-icon'
import { CategorySplitBadge, TransactionCategoryIcon } from '@/components/category-lines-display'
import { isSplitByCategory, projectedSplitSource } from '@/lib/category-lines'
import { ProjectedTransactionBadge } from '@/components/projected-transaction-badge'
import { TransactionDialog, type TransactionSavePayload } from '@/components/transaction-dialog'
import { extractApiError } from '@/lib/api-errors'
import { TransferDialog } from '@/components/transfer-dialog'
import { DatePickerInput } from '@/components/ui/date-picker-input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { useIsMobile } from '@/hooks/use-mobile'
import { useAuth } from '@/contexts/auth-context'
import { useWorkspace } from '@/contexts/workspace-context'
import { useCreateTransaction } from '@/hooks/use-create-transaction'
import { resolveDateFnsLocale } from '@/lib/date-fns-locale'
import { formatCompactCurrency, formatCurrency } from '@/lib/format'
import { LoanScheduleCard } from '@/components/loan-schedule-card'
import {
  AreaChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'

// Rows per "Show more" on a non-credit-card account. Balances come from the
// server, so they hold whatever has been loaded (#1202).
const TRANSACTIONS_PAGE_SIZE = 100
// The API's cap on one page; a credit-card cycle is fetched in full.
const CYCLE_PAGE_SIZE = 500

function defaultFrom() {
  const now = new Date()
  return localDateString(new Date(now.getFullYear(), now.getMonth(), 1))
}

function defaultTo() {
  const now = new Date()
  return localDateString(new Date(now.getFullYear(), now.getMonth() + 1, 0))
}


function formatDateStr(dateStr: string, locale = 'pt-BR') {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString(locale)
}

function formatFriendlyDate(dateStr: string, dateLocale: string) {
  // Compact friendly weekday+day+month — words follow the UI language, field
  // order follows the regional date setting (e.g. "Thu, Apr 16" vs "Thu, 16 Apr").
  return new Date(dateStr + 'T00:00:00').toLocaleDateString(dateLocale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
}

function daysUntil(dateStr: string): number {
  const target = new Date(dateStr + 'T00:00:00')
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
}

/** Label a window that belongs to no bill and is not the open cycle, which is
 * what a hand-edited date range produces. Naming it after a bill month would
 * claim it is a statement it is not, so it says what it actually is. The year
 * only shows up when the range crosses one, to keep the header narrow. */
function cycleRangeLabel(from: string, to: string, i18nLanguage: string): string {
  const dfLocale = resolveDateFnsLocale(i18nLanguage)
  const pattern = from.slice(0, 4) === to.slice(0, 4) ? 'dd MMM' : "dd MMM ''yy"
  const at = (d: string) => format(parseISO(d + 'T00:00:00'), pattern, { locale: dfLocale })
  return `${at(from)} - ${at(to)}`
}

function utilizationColor(pct: number): string {
  if (pct >= 90) return 'bg-rose-500'
  if (pct >= 70) return 'bg-amber-400'
  if (pct >= 30) return 'bg-blue-500'
  return 'bg-emerald-500'
}

type TxWithBalance = Transaction & { runningBalance: number }

export default function AccountDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { t, i18n } = useTranslation()
  const { mask, privacyMode, MASK } = usePrivacyMode()
  const { user } = useAuth()
  const { canWrite } = useWorkspace()
  const userCurrency = user?.preferences?.currency_display ?? 'USD'
  const locale = useDisplayLocale()
  const dateLocale = useDateLocale()
  const isMobile = useIsMobile()
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingTx, setEditingTx] = useState<Transaction | null>(null)
  const [renamingPrincipalCard, setRenamingPrincipalCard] = useState(false)
  const [principalCardName, setPrincipalCardName] = useState('')
  const [transferDialogOpen, setTransferDialogOpen] = useState(false)
  const {
    mutation: createMutation,
    create: createTransaction,
    duplicateDraft,
    setDuplicateDraft,
    formResetKey,
    resetForm,
  } = useCreateTransaction({ onDone: () => setDialogOpen(false) })
  const openCreateDialog = () => {
    setEditingTx(null)
    resetForm(null)
    setDialogOpen(true)
  }
  const [filterFrom, setFilterFrom] = useState(defaultFrom)
  const [filterTo, setFilterTo] = useState(defaultTo)
  const [showPrimary, setShowPrimary] = useState(false)
  const [filterTouched, setFilterTouched] = useState(false)
  const [activeCycleKey, setActiveCycleKey] = useState<string | null>(null)
  const handleFilterFromChange = (v: string) => {
    setFilterTouched(true)
    setActiveCycleKey(null)
    setFilterFrom(v)
  }
  const handleFilterToChange = (v: string) => {
    setFilterTouched(true)
    setActiveCycleKey(null)
    setFilterTo(v)
  }
  const { data: account, isLoading: accountLoading } = useQuery({
    queryKey: ['accounts', id],
    queryFn: () => accounts.get(id!),
    enabled: !!id,
  })
  const isCreditCard = account?.type === 'credit_card'

  // Cards on a credit-card account (physical + virtual). A hidden card's
  // purchases drop out of every statement view of this page; the overview
  // page deliberately ignores that so it keeps matching the bank's bill.
  const { data: cards = [] } = useQuery({
    queryKey: ['accounts', id, 'cards'],
    queryFn: () => accounts.cards(id!),
    enabled: !!id && isCreditCard,
  })
  const hiddenCardLast4 = cards.filter(c => c.is_hidden).map(c => c.last4)
  const cardUpdateMutation = useMutation({
    mutationFn: ({ last4, payload }: { last4: string; payload: { alias?: string | null; is_hidden?: boolean } }) =>
      accounts.updateCard(id!, last4, payload),
    onSuccess: () => {
      // Hiding is a property of the card: every list and total changes.
      queryClient.invalidateQueries()
    },
    onError: (err) => toast.error(extractApiError(err, t('accountCards.updateError'))),
  })

  const timelineFrom = format(startOfMonth(subMonths(new Date(), 24)), 'yyyy-MM-dd')
  const timelineTo = format(endOfMonth(addMonths(new Date(), 12)), 'yyyy-MM-dd')
  const { data: timelineData } = useQuery({
    queryKey: ['credit-card-timeline', id, timelineFrom, timelineTo],
    queryFn: () => accounts.creditCardTimeline([id!], timelineFrom, timelineTo),
    enabled: !!id && isCreditCard,
  })
  const timelineItems = timelineData?.[0]?.items.filter(
    (item): item is CreditCardTimelineItem & { cycle_key: string; start: string; end: string } =>
      !!item.cycle_key && !!item.start && !!item.end,
  ) ?? []
  const activeCycle = timelineItems.find((item) => item.cycle_key === activeCycleKey) ?? null
  const activeBill = activeCycle?.kind === 'statement' && activeCycle.record_id && activeCycle.due_date
    ? {
        id: activeCycle.record_id,
        due_date: activeCycle.due_date,
        closing_date: activeCycle.closing_date,
        source: activeCycle.source,
        total_amount: activeCycle.amount,
      }
    : null

  const [cycleSource, setCycleSource] = useState<{
    account: typeof account
    timelineData: typeof timelineData
  } | null>(null)
  if (
    !cycleSource
    || cycleSource.account !== account
    || cycleSource.timelineData !== timelineData
  ) {
    setCycleSource({ account, timelineData })
    if (account?.type === 'credit_card' && !filterTouched) {
      const defaultKey = timelineData?.[0]?.default_key
      const selected = timelineItems.find((item) => item.cycle_key === defaultKey)
      if (selected) {
        setActiveCycleKey(selected.cycle_key)
        setFilterFrom(selected.start)
        setFilterTo(selected.end)
      }
    }
  }

  // The neighbouring statement in the canonical timeline. From a hand-picked
  // range, that is the first statement starting after it (or the last one
  // starting before it), so navigation never lands on a bare date window
  // while the card has statements to show.
  const neighbourCycle = (direction: -1 | 1) => {
    if (activeCycle) {
      const index = timelineItems.findIndex((item) => item.cycle_key === activeCycle.cycle_key)
      return timelineItems[index + direction] ?? null
    }
    return direction === 1
      ? timelineItems.find((item) => item.start > filterFrom) ?? null
      : timelineItems.filter((item) => item.start < filterFrom).at(-1) ?? null
  }
  const hasTimeline = timelineItems.length > 0

  const shiftCycleBy = (direction: -1 | 1) => {
    const next = neighbourCycle(direction)
    if (next) {
      setFilterTouched(true)
      setActiveCycleKey(next.cycle_key)
      setFilterFrom(next.start)
      setFilterTo(next.end)
      return
    }
    if (hasTimeline) return
    // A card without a cycle has no statements: step the window by a month.
    setActiveCycleKey(null)
    setFilterTouched(true)
    setFilterFrom(format(addMonths(parseISO(filterFrom + 'T00:00:00'), direction), 'yyyy-MM-dd'))
    setFilterTo(format(addMonths(parseISO(filterTo + 'T00:00:00'), direction), 'yyyy-MM-dd'))
  }

  const { data: accountsList } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => accounts.list(),
  })

  // Switching cycles keeps the current account's numbers on screen until the
  // next cycle arrives, instead of collapsing the page into a skeleton.
  const { data: summary, isLoading: summaryLoading, isPlaceholderData: summarySwitching } = useQuery({
    queryKey: activeCycleKey
      ? ['accounts', id, 'summary', { cycle_key: activeCycleKey }]
      : ['accounts', id, 'summary', filterFrom, filterTo],
    queryFn: () => accounts.summary(
      id!,
      activeCycleKey ? undefined : filterFrom || undefined,
      activeCycleKey ? undefined : filterTo || undefined,
      activeCycleKey ?? undefined,
    ),
    enabled: !!id,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === id ? previous : undefined,
  })

  const activeCycleIndex = activeCycle
    ? timelineItems.findIndex((item) => item.cycle_key === activeCycle.cycle_key)
    : -1
  const previousCycle = activeCycleIndex > 0 ? timelineItems[activeCycleIndex - 1] : null
  const { data: previousCycleSummary } = useQuery({
    queryKey: ['accounts', id, 'summary', { cycle_key: previousCycle?.cycle_key }],
    queryFn: () => accounts.summary(id!, undefined, undefined, previousCycle!.cycle_key),
    enabled: !!id && !!previousCycle,
  })

  const timelineCount = isMobile ? 4 : 6
  const timelineEnd = activeCycleIndex >= 0 ? activeCycleIndex + 1 : timelineItems.length
  const timelineCycles = timelineItems.slice(
    Math.max(0, timelineEnd - timelineCount),
    timelineEnd,
  )

  // A canonical cycle is fetched in full; manual date ranges keep using the
  // generic transaction filters and never acquire statement semantics.
  const { data: cycleTxData, isLoading: cycleTxLoading, isPlaceholderData: cycleTxSwitching } = useQuery({
    queryKey: ['transactions', {
      account_id: id,
      cycle_key: activeCycleKey,
      from: activeCycleKey ? undefined : filterFrom,
      to: activeCycleKey ? undefined : filterTo,
      include_opening_balance: true,
    }],
    queryFn: async () => {
      const params = {
        account_id: id,
        cycle_key: activeCycleKey ?? undefined,
        from: activeCycleKey ? undefined : filterFrom || undefined,
        to: activeCycleKey ? undefined : filterTo || undefined,
        limit: CYCLE_PAGE_SIZE,
        include_opening_balance: true,
      }
      const first = await transactions.list({ ...params, page: 1 })
      const items = [...first.items]
      for (let page = 2; items.length < first.total; page++) {
        const next = await transactions.list({ ...params, page })
        if (next.items.length === 0) break
        items.push(...next.items)
      }
      return { ...first, items }
    },
    enabled: !!id && account?.type === 'credit_card',
    placeholderData: (previous, previousQuery) =>
      (previousQuery?.queryKey[1] as { account_id?: string } | undefined)?.account_id === id
        ? previous
        : undefined,
  })

  // Any other account pages through the period newest first. Each row
  // carries the balance right after it, which the server walks over the
  // whole range, so a page's balances don't depend on the pages before or
  // after it being loaded (#1202).
  const ledger = useInfiniteQuery({
    queryKey: ['transactions', { account_id: id, from: filterFrom, to: filterTo, limit: TRANSACTIONS_PAGE_SIZE, include_opening_balance: true, include_running_balance: true }],
    queryFn: ({ pageParam }) => transactions.list({
      account_id: id,
      from: filterFrom || undefined,
      to: filterTo || undefined,
      page: pageParam,
      limit: TRANSACTIONS_PAGE_SIZE,
      include_opening_balance: true,
      include_running_balance: true,
    }),
    initialPageParam: 1,
    getNextPageParam: (lastPage, pages) => {
      const loaded = pages.reduce((count, page) => count + page.items.length, 0)
      return loaded < lastPage.total && lastPage.items.length > 0 ? pages.length + 1 : undefined
    },
    enabled: !!id && !!account && account.type !== 'credit_card',
  })
  const ledgerItems = useMemo(
    () => ledger.data?.pages.flatMap((page) => page.items),
    [ledger.data],
  )
  const ledgerTotal = ledger.data?.pages.at(-1)?.total ?? 0

  // The chart spans the whole period whichever pages the list has loaded,
  // so its balances come from the server as well (#1202). A range longer than
  // the endpoint allows charts its latest part; the list still covers it all.
  const chartFrom = runningBalanceChartFrom(filterFrom, filterTo)
  const { data: runningBalanceSeries, isLoading: runningBalanceLoading } = useQuery({
    queryKey: ['accounts', id, 'running-balance', chartFrom, filterTo],
    queryFn: () => accounts.runningBalance(id!, chartFrom || undefined, filterTo || undefined),
    enabled: !!id && !!account && account.type !== 'credit_card',
  })

  // Non-materialized recurring projections are forecast rows. They are kept
  // separate from real transactions so pending and future commitments never
  // alter the current balance.
  const { data: projectedTxData } = useQuery({
    queryKey: ['dashboard', 'projected-transactions', { account_id: id, from: filterFrom, to: filterTo }],
    queryFn: () => dashboard.projectedTransactions({ account_id: id!, from: filterFrom, to: filterTo }),
    enabled: !!id && account?.type !== 'credit_card',
  })

  const { data: categoriesList } = useQuery({
    queryKey: ['categories'],
    queryFn: categoriesApi.list,
  })

  const { data: categoryGroupsList } = useQuery({
    queryKey: ['categoryGroups'],
    queryFn: categoryGroupsApi.list,
  })

  const updateMutation = useMutation({
    mutationFn: ({ id: txId, ...data }: TransactionSavePayload & { id: string }) =>
      transactions.update(txId, data),
    onSuccess: () => {
      invalidateFinancialQueries(queryClient)
      setDialogOpen(false)
      setEditingTx(null)
      toast.success(t('accounts.updated'))
    },
    onError: (error) => {
      toast.error(extractApiError(error))
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (txId: string) => transactions.delete(txId),
    onSuccess: () => {
      invalidateFinancialQueries(queryClient)
      setDialogOpen(false)
      setEditingTx(null)
      toast.success(t('transactions.deleted'))
    },
    onError: (error) => {
      toast.error(extractApiError(error))
    },
  })

  const unlinkTransferMutation = useMutation({
    mutationFn: (pairId: string) => transactions.unlinkTransfer(pairId),
    onSuccess: () => {
      invalidateFinancialQueries(queryClient)
      setDialogOpen(false)
      setEditingTx(null)
      toast.success(t('transactions.unlinkTransferSuccess'))
    },
    onError: (error) => {
      toast.error(extractApiError(error))
    },
  })

  const reopenMutation = useMutation({
    mutationFn: () => accounts.reopen(id!),
    onSuccess: () => {
      invalidateFinancialQueries(queryClient)
      toast.success(t('accounts.accountReopened'))
    },
    onError: () => toast.error(t('common.error')),
  })

  const [ccSettingsOpen, setCcSettingsOpen] = useState(false)
  const ccSettingsMutation = useMutation({
    mutationFn: (data: { credit_limit?: number | null; statement_close_day?: number | null; payment_due_day?: number | null }) =>
      accounts.update(id!, data),
    onSuccess: () => {
      invalidateFinancialQueries(queryClient)
      setCcSettingsOpen(false)
      toast.success(t('accounts.updated'))
    },
    onError: (error) => toast.error(extractApiError(error)),
  })
  const principalCardNameMutation = useMutation({
    mutationFn: (displayName: string) =>
      accounts.update(id!, { display_name: displayName.trim() || null }),
    onSuccess: (updated) => {
      queryClient.setQueryData<Account>(['accounts', id], updated)
      queryClient.setQueryData<Account[]>(['accounts'], (current) =>
        current?.map((item) => item.id === updated.id ? updated : item),
      )
      setRenamingPrincipalCard(false)
      toast.success(t('accounts.updated'))
    },
    onError: (error) => toast.error(extractApiError(error)),
  })

  const startPrincipalCardRename = () => {
    setPrincipalCardName(account?.display_name ?? '')
    setRenamingPrincipalCard(true)
  }

  const transferMutation = useMutation({
    mutationFn: (data: {
      from_account_id: string
      to_account_id: string
      amount: number
      date: string
      description: string
      notes?: string
      destination_amount?: number
    }) => transactions.createTransfer(data),
    onSuccess: () => {
      invalidateFinancialQueries(queryClient)
      setTransferDialogOpen(false)
      toast.success(t('transactions.transferCreated'))
    },
    onError: (error) => {
      toast.error(extractApiError(error))
    },
  })

  // Whether to use primary currency amounts (for foreign-currency accounts with toggle, or domestic accounts with foreign txs)
  const isForeignCurrency = account ? account.currency !== userCurrency : false
  // No real FX rate: the summary leaves the *_primary fields unset, so stay on
  // the account's own currency instead of labelling native amounts as converted.
  const fxFallback = summary?.fx_fallback === true
  const primaryShown = showPrimary && !fxFallback
  const usePrimary = !isForeignCurrency || primaryShown
  const displayCurrency = (isForeignCurrency && !primaryShown) ? (account?.currency || userCurrency) : userCurrency
  const txLoading = isCreditCard ? cycleTxLoading : ledger.isLoading
  const chartLoading = isCreditCard ? cycleTxLoading : runningBalanceLoading
  const cycleSwitching = isCreditCard && (summarySwitching || cycleTxSwitching)
  const cycleSectionClass = `transition-opacity duration-200 ${cycleSwitching ? 'opacity-50' : ''}`

  // Pseudo-transaction rows for non-materialized recurring projections.
  // Virtual: rendered with a "Previsão" badge, non-clickable, and merged
  // into displayRows where running balances are computed for them. The
  // projections endpoint already drops materialized occurrences; checking
  // the loaded rows as well covers a list fresher than the projections.
  const projectedRows = useMemo((): Transaction[] => {
    if (!projectedTxData) return []
    const unmaterialized = excludeMaterializedProjections(
      projectedTxData,
      ledgerItems ?? [],
    )
    return unmaterialized.map((p: ProjectedTransaction): Transaction => ({
      id: `projected-${p.recurring_id}-${p.date}`,
      user_id: '',
      account_id: id ?? null,
      category_id: p.category_id,
      category: p.category_name || p.category_icon || p.category_color
        ? {
            id: p.category_id ?? '',
            user_id: '',
            group_id: null,
            name: p.category_name ?? '',
            icon: p.category_icon ?? '',
            color: p.category_color ?? '',
            is_system: false,
            is_hidden: false,
            treat_as_transfer: p.category_treat_as_transfer,
            is_ignored: false,
          }
        : null,
      external_id: null,
      description: p.description,
      original_description: null,
      amount: p.amount,
      currency: p.currency,
      date: p.date,
      type: p.type,
      source: 'projected',
      status: 'posted',
      payee: null,
      payee_id: null,
      payee_name: null,
      notes: null,
      transfer_pair_id: null,
      amount_primary: p.amount_primary,
      fx_rate_used: null,
      fx_fallback: false,
      installment_series_id: null,
      installment_number: null,
      total_installments: null,
      installment_total_amount: null,
      installment_purchase_date: null,
      bill_id: null,
      effective_bill_date: null,
      recurring_transaction_id: p.recurring_id,
      splits: [],
      is_ignored: false,
      virtual: true,
      ...projectedSplitSource(p),
    }))
  }, [projectedTxData, ledgerItems, id])

  // Balance at the start of the period, which projections dated before the
  // first real row of the range start from. For CC accounts this is not used
  // (cycle total starts from 0).
  const openingBalance = usePrimary
    ? (summary?.opening_balance_primary ?? summary?.opening_balance ?? 0)
    : (summary?.opening_balance ?? 0)

  // Chart data:
  // - Non-CC: the server's end-of-day balance (pending rows included), with
  //   recurring projections added on top as a running forecast.
  // - CC: cumulative charges within the current cycle, starting at 0
  //   (answers "how much have I spent this cycle", ignores bill payments/transfers)
  const chartData = useMemo(() => {
    if (isCreditCard) {
      if (!cycleTxData?.items) return []
      const byDay = new Map<string, number>()
      for (const tx of cycleTxData.items) {
        if (tx.type !== 'debit') continue
        if (tx.source === 'opening_balance') continue
        if (tx.transfer_pair_id) continue
        const amt = transactionAmountForBalance(tx, usePrimary, displayCurrency)
        if (amt == null) continue
        byDay.set(tx.date, (byDay.get(tx.date) ?? 0) + amt)
      }
      // Chart span: when a real bill is active, derive the range from the
      // actual debit dates so charges Pluggy bucketed outside our nominal
      // [prev_due+1, this_due] window (e.g. a 03/02 charge rolled into the
      // March bill) still show up. Otherwise use the cycle-math range.
      let rangeStart: string | null = null
      let rangeEnd: string | null = null
      if (activeBill) {
        const dates = Array.from(byDay.keys()).sort()
        if (dates.length === 0) return []
        rangeStart = dates[0]
        rangeEnd = activeBill.due_date < dates[dates.length - 1] ? dates[dates.length - 1] : activeBill.due_date
      } else if (filterFrom && filterTo) {
        rangeStart = filterFrom
        rangeEnd = filterTo
      }
      if (!rangeStart || !rangeEnd) return []
      const series: { label: string; date: string; balance: number }[] = []
      // Synthetic zero baseline (day before cycle start) so the line always
      // anchors at 0 even when the cycle's first day already has charges.
      const startDate = parseISO(rangeStart + 'T00:00:00')
      const baseline = new Date(startDate.getTime() - 86400000)
      const baselineKey = format(baseline, 'yyyy-MM-dd')
      series.push({ label: formatDateStr(baselineKey, dateLocale), date: baselineKey, balance: 0 })
      const cur = new Date(startDate)
      const end = new Date(rangeEnd + 'T00:00:00')
      let running = 0
      while (cur <= end) {
        const key = format(cur, 'yyyy-MM-dd')
        running += byDay.get(key) ?? 0
        series.push({ label: formatDateStr(key, dateLocale), date: key, balance: running })
        cur.setDate(cur.getDate() + 1)
      }
      return series
    }
    if (!runningBalanceSeries) return []
    const projectedByDay = new Map<string, number>()
    for (const tx of projectedRows) {
      const previous = projectedByDay.get(tx.date) ?? 0
      projectedByDay.set(tx.date, applyTransactionToBalance(previous, tx, usePrimary, displayCurrency))
    }
    let projected = 0
    return runningBalanceSeries.map((point) => {
      projected += projectedByDay.get(point.date) ?? 0
      const balance = usePrimary ? (point.balance_primary ?? point.balance) : point.balance
      return { label: formatDateStr(point.date, dateLocale), date: point.date, balance: balance + projected }
    })
  }, [isCreditCard, cycleTxData, runningBalanceSeries, projectedRows, filterFrom, filterTo, dateLocale, usePrimary, displayCurrency, activeBill])

  const ccRunningTotal = useMemo((): TxWithBalance[] => {
    if (!isCreditCard || !cycleTxData?.items) return []
    const ascending = [...cycleTxData.items].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    )
    let running = 0
    const withBalance = ascending.map((tx) => {
      if (!tx.is_ignored && tx.source !== 'opening_balance' && !tx.transfer_pair_id) {
        const amt = transactionAmountForBalance(tx, usePrimary, displayCurrency)
        if (amt == null) return { ...tx, runningBalance: running }
        if (tx.type === 'debit') running += amt
        else if (tx.type === 'credit') running -= amt
      }
      return { ...tx, runningBalance: running }
    })
    return withBalance.reverse()
  }, [cycleTxData, isCreditCard, usePrimary, displayCurrency])

  // Merged list: real transactions, pending rows, and virtual recurring
  // projections. The newest row is the forecast at the end of the range,
  // even before the older pages are loaded (#1202).
  const displayRows = useMemo((): TxWithBalance[] => {
    if (isCreditCard) return ccRunningTotal
    if (!ledgerItems || summary === undefined) return []
    return mergeRunningBalances(ledgerItems, projectedRows, {
      openingBalance,
      hasMore: ledger.hasNextPage,
      usePrimary,
      displayCurrency,
    })
  }, [ledgerItems, ledger.hasNextPage, projectedRows, isCreditCard, summary, usePrimary, displayCurrency, openingBalance, ccRunningTotal])

  const totalBalance = (usePrimary ? summary?.current_balance_primary : undefined) ?? summary?.current_balance ?? 0
  const projectedBalance = displayRows.length > 0 ? displayRows[0].runningBalance : openingBalance

  const actualIncome = (usePrimary ? summary?.monthly_income_primary : undefined) ?? summary?.monthly_income ?? 0
  const actualExpenses = (usePrimary ? summary?.monthly_expenses_primary : undefined) ?? summary?.monthly_expenses ?? 0
  const projectedIncome = (usePrimary ? summary?.projected_income_primary : undefined) ?? summary?.projected_income ?? actualIncome
  const projectedExpenses = (usePrimary ? summary?.projected_expenses_primary : undefined) ?? summary?.projected_expenses ?? actualExpenses
  const hasProjectedIncome = Math.abs(projectedIncome - actualIncome) > 0.005
  const hasProjectedExpenses = Math.abs(projectedExpenses - actualExpenses) > 0.005

  const defaultCycle = timelineItems.find(
    (item) => item.cycle_key === timelineData?.[0]?.default_key,
  )
  const resolvedDefaultRange = account?.type === 'credit_card' && defaultCycle
    ? { start: defaultCycle.start, end: defaultCycle.end }
    : { start: defaultFrom(), end: defaultTo() }
  const hasFilters = filterFrom !== resolvedDefaultRange.start || filterTo !== resolvedDefaultRange.end

  // The mobile transaction view is intentionally grouped by day so the date
  // remains visible without spending a full column on every row.
  const groupedByDate = useMemo(() => {
    const groups: { date: string; label: string; items: TxWithBalance[] }[] = []
    let current: { date: string; label: string; items: TxWithBalance[] } | null = null
    for (const tx of displayRows) {
      if (!current || current.date !== tx.date) {
        current = {
          date: tx.date,
          label: new Date(tx.date + 'T00:00:00').toLocaleDateString(dateLocale, {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          }),
          items: [],
        }
        groups.push(current)
      }
      current.items.push(tx)
    }
    return groups
  }, [displayRows, dateLocale])

  const isLoading = accountLoading || summaryLoading

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32" />
        <Skeleton className="h-64" />
      </div>
    )
  }

  if (!account) {
    return <p className="text-muted-foreground">{t('accounts.notFound')}</p>
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-6 space-y-4">
        {/* Breadcrumb */}
        <Link
          to={isCreditCard ? '/cards' : '/accounts'}
          className="inline-flex items-center text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5 mr-1" />
          {isCreditCard ? t('nav.cards') : t('accounts.backToAccounts')}
        </Link>

        {/* Title row */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            {renamingPrincipalCard ? (
              <form
                className="flex max-w-md items-center gap-1.5"
                onSubmit={(event) => {
                  event.preventDefault()
                  principalCardNameMutation.mutate(principalCardName)
                }}
              >
                <Input
                  autoFocus
                  aria-label={t('accounts.displayName')}
                  value={principalCardName}
                  onChange={(event) => setPrincipalCardName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setRenamingPrincipalCard(false)
                  }}
                  placeholder={account.name}
                  className="h-9 text-lg font-semibold sm:text-xl"
                />
                <Button
                  type="submit"
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 shrink-0"
                  aria-label={t('accountCards.save')}
                  disabled={principalCardNameMutation.isPending}
                >
                  <Check size={16} />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 shrink-0"
                  aria-label={t('accountCards.cancel')}
                  onClick={() => setRenamingPrincipalCard(false)}
                  disabled={principalCardNameMutation.isPending}
                >
                  <X size={16} />
                </Button>
              </form>
            ) : (
              <div className="flex min-w-0 items-center gap-2">
                <h1 className="truncate text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                  {getAccountName(account)}
                </h1>
                {isCreditCard && canWrite && (
                  <Button
                    type="button"
                    aria-label={t('accounts.displayName')}
                    variant="ghost"
                    size="sm"
                    className="h-8 shrink-0 gap-1.5 text-muted-foreground"
                    onClick={startPrincipalCardRename}
                  >
                    <Pencil size={14} />
                    <span className="hidden sm:inline">{t('accounts.displayName')}</span>
                  </Button>
                )}
              </div>
            )}
            <div className="flex items-center gap-2 mt-1 overflow-hidden">
              <span className="text-xs font-medium text-muted-foreground">
                {t(`accounts.type${account.type.split('_').map(s => s[0].toUpperCase() + s.slice(1)).join('')}`, account.type)}
              </span>
              {isCreditCard && account.next_due_date && (() => {
                const d = daysUntil(account.next_due_date)
                if (d > 7) return null
                const cfg = d < 0
                  ? { bg: 'bg-rose-100 dark:bg-rose-500/20', text: 'text-rose-700 dark:text-rose-400', label: t('accounts.overdue') }
                  : d === 0
                    ? { bg: 'bg-rose-100 dark:bg-rose-500/20', text: 'text-rose-700 dark:text-rose-400', label: t('accounts.dueToday') }
                    : d <= 3
                      ? { bg: 'bg-rose-100 dark:bg-rose-500/20', text: 'text-rose-700 dark:text-rose-400', label: t('accounts.dueIn', { count: d }) }
                      : { bg: 'bg-amber-100 dark:bg-amber-500/20', text: 'text-amber-700 dark:text-amber-400', label: t('accounts.dueIn', { count: d }) }
                return (
                  <>
                    <span className="text-muted-foreground text-xs">·</span>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold ${cfg.bg} ${cfg.text}`}>
                      {cfg.label}
                    </span>
                  </>
                )
              })()}
              {isCreditCard && canWrite && (!account.statement_close_day || !account.payment_due_day) && (
                <>
                  <span className="text-muted-foreground text-xs">·</span>
                  <button
                    type="button"
                    onClick={() => setCcSettingsOpen(true)}
                    title={t('accounts.cycleMissingHint')}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 hover:bg-amber-200 dark:hover:bg-amber-500/30 transition-colors cursor-pointer"
                  >
                    <HelpCircle className="h-3 w-3" />
                    {t('accounts.cycleMissing')}
                  </button>
                </>
              )}
            </div>
          </div>
          {!account.is_closed && canWrite && (
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setTransferDialogOpen(true)}
              >
                <ArrowLeftRight className="h-4 w-4 mr-1" />
                {t('transactions.transfer')}
              </Button>
              <Button size="sm" onClick={openCreateDialog}>
                <Plus className="h-4 w-4 mr-1" />
                <span className="sm:hidden">{t('common.add')}</span>
                <span className="hidden sm:inline">{t('transactions.addManual')}</span>
              </Button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          {isCreditCard ? (
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="h-8 w-8 flex items-center justify-center rounded-lg border border-border bg-card text-muted-foreground hover:border-border hover:text-foreground transition-all disabled:opacity-40 disabled:pointer-events-none"
                onClick={() => shiftCycleBy(-1)}
                disabled={hasTimeline && !neighbourCycle(-1)}
                title={t('accounts.previousCycle')}
              >
                <ChevronLeft size={16} />
              </button>
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-busy={cycleSwitching}
                    className="inline-flex items-center justify-center gap-2 min-w-[140px] border border-border rounded-lg px-3 py-1.5 text-sm bg-card text-foreground hover:bg-muted/50 transition-all cursor-pointer capitalize"
                  >
                    {cycleSwitching && <Loader2 size={14} className="animate-spin text-muted-foreground" aria-hidden="true" />}
                    {activeCycle?.due_date
                      ? format(parseISO(activeCycle.due_date + 'T00:00:00'), 'MMM yyyy', {
                          locale: resolveDateFnsLocale(i18n.resolvedLanguage ?? i18n.language),
                        })
                      : cycleRangeLabel(filterFrom, filterTo, i18n.resolvedLanguage ?? i18n.language)}
                  </button>
                </PopoverTrigger>
                <PopoverContent align="center" className="w-auto p-3 space-y-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">{t('transactions.from')}</Label>
                    <DatePickerInput
                      value={filterFrom}
                      onChange={handleFilterFromChange}
                      placeholder={t('transactions.from')}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">{t('transactions.to')}</Label>
                    <DatePickerInput
                      value={filterTo}
                      onChange={handleFilterToChange}
                      placeholder={t('transactions.to')}
                    />
                  </div>
                </PopoverContent>
              </Popover>
              <button
                type="button"
                className="h-8 w-8 flex items-center justify-center rounded-lg border border-border bg-card text-muted-foreground hover:border-border hover:text-foreground transition-all disabled:opacity-40 disabled:pointer-events-none"
                onClick={() => shiftCycleBy(1)}
                disabled={hasTimeline && !neighbourCycle(1)}
                title={t('accounts.nextCycle')}
              >
                <ChevronRight size={16} />
              </button>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <label className="text-sm text-muted-foreground hidden md:inline">{t('transactions.from')}</label>
                <DatePickerInput
                  value={filterFrom}
                  onChange={handleFilterFromChange}
                  placeholder={t('transactions.from')}
                />
              </div>
              <div className="flex items-center gap-2">
                <label className="text-sm text-muted-foreground hidden md:inline">{t('transactions.to')}</label>
                <DatePickerInput
                  value={filterTo}
                  onChange={handleFilterToChange}
                  placeholder={t('transactions.to')}
                />
              </div>
            </>
          )}
          {hasFilters && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground min-h-[44px] min-w-[44px] px-3 shrink-0"
              onClick={() => {
                setFilterTouched(false)
                if (account?.type === 'credit_card' && defaultCycle) {
                  setActiveCycleKey(defaultCycle.cycle_key)
                  setFilterFrom(defaultCycle.start)
                  setFilterTo(defaultCycle.end)
                } else {
                  setActiveCycleKey(null)
                  setFilterFrom(defaultFrom())
                  setFilterTo(defaultTo())
                }
              }}
            >
              <X className="h-3.5 w-3.5 sm:mr-1" />
              <span className="hidden sm:inline">{t('transactions.clearFilters')}</span>
            </Button>
          )}
          {isForeignCurrency && (
            <div className="ml-auto inline-flex rounded-lg border border-border bg-muted p-0.5 text-xs font-medium">
              <button
                onClick={() => setShowPrimary(false)}
                className={`px-3 py-1.5 rounded-md transition-colors ${!primaryShown ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {account.currency}
              </button>
              <button
                onClick={() => setShowPrimary(true)}
                disabled={fxFallback}
                title={fxFallback ? t('transactions.fxFallbackBanner') : undefined}
                className={`px-3 py-1.5 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${primaryShown ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {userCurrency}
              </button>
            </div>
          )}
        </div>
        {isCreditCard && cards.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <AccountCardsControl
              cards={cards}
              canWrite={canWrite}
              onToggleHidden={(card) => cardUpdateMutation.mutate({ last4: card.last4, payload: { is_hidden: !card.is_hidden } })}
              onRename={(card, alias) => cardUpdateMutation.mutate({ last4: card.last4, payload: { alias } })}
            />
            {hiddenCardLast4.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {t('accountCards.hiddenNotice', { count: hiddenCardLast4.length })}
                {canWrite && (
                  <button
                    type="button"
                    className="ml-2 font-medium text-primary hover:underline"
                    onClick={() => hiddenCardLast4.forEach(last4 => cardUpdateMutation.mutate({ last4, payload: { is_hidden: false } }))}
                  >
                    {t('accountCards.showAll')}
                  </button>
                )}
              </p>
            )}
          </div>
        )}
      </div>

      {account.is_closed && (
        <div className="flex items-center justify-between rounded-lg border border-border bg-muted px-4 py-3 mb-6">
          <span className="text-sm text-muted-foreground">{t('accounts.closedBanner')}</span>
          {canWrite && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => reopenMutation.mutate()}
              disabled={reopenMutation.isPending}
            >
              {t('accounts.reopen')}
            </Button>
          )}
        </div>
      )}

      {/* Bill timeline (last 6 cycles) — only for CC with cycle metadata */}
      {isCreditCard && timelineCycles.length > 0 && (() => {
        const dfLocale = resolveDateFnsLocale(i18n.resolvedLanguage ?? i18n.language)
        const totals = timelineCycles.map((item) => ({
          ...item,
          total: Number(item.amount ?? 0),
          loading: false,
        }))
        const max = Math.max(1, ...totals.map(c => c.total))
        return (
          <div className="bg-card rounded-xl border border-border shadow-sm p-3 sm:p-4 mb-6">
            <div className="flex items-end gap-2 sm:gap-3 overflow-x-auto pb-1">
              {totals.map((c, i) => {
                const isCurrent = c.start === filterFrom && c.end === filterTo
                const heightPct = c.total > 0 ? Math.max(8, (c.total / max) * 100) : 4
                const label = c.due_date
                  ? format(parseISO(c.due_date + 'T00:00:00'), 'MMM yyyy', { locale: dfLocale })
                  : c.due_month
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => {
                      setFilterTouched(true)
                      setActiveCycleKey(c.cycle_key)
                      setFilterFrom(c.start)
                      setFilterTo(c.end)
                    }}
                    className={`group flex-1 min-w-[60px] flex flex-col items-center gap-1.5 px-1 py-2 rounded-lg transition-colors ${isCurrent ? 'bg-rose-50 dark:bg-rose-500/10' : 'hover:bg-muted/50'}`}
                  >
                    <div className="h-12 w-full flex items-end justify-center">
                      {c.loading ? (
                        <div className="w-6 h-3 rounded-sm bg-muted animate-pulse" />
                      ) : (
                        <div
                          className={`w-6 rounded-sm transition-colors ${isCurrent ? 'bg-rose-500' : c.total > 0 ? 'bg-rose-300 dark:bg-rose-500/40 group-hover:bg-rose-400' : 'bg-muted-foreground/20'}`}
                          style={{ height: `${heightPct}%` }}
                        />
                      )}
                    </div>
                    <p className={`text-[10px] sm:text-xs font-medium capitalize ${isCurrent ? 'text-rose-700 dark:text-rose-400' : 'text-muted-foreground'}`}>
                      {label}
                    </p>
                    <p className={`text-[10px] sm:text-xs font-semibold tabular-nums ${isCurrent ? 'text-foreground' : 'text-muted-foreground'}`}>
                      {c.loading ? '—' : mask(formatCurrency(c.total, account.currency, locale))}
                    </p>
                  </button>
                )
              })}
            </div>
          </div>
        )
      })()}

      {/* Compact stat bar */}
      {isCreditCard ? (() => {
        // Closed bank Statements keep the bank's amount. Open cycles use the
        // summary resolved through the same canonical cycle key.
        const closedBankTotal = !primaryShown
          && activeCycle?.kind === 'statement'
          && activeCycle.source === 'bank'
          && activeCycle.closing_date
          && activeCycle.closing_date < format(new Date(), 'yyyy-MM-dd')
          && activeCycle.amount != null
          ? Number(activeCycle.amount)
          : null
        const billTotal = closedBankTotal ?? (primaryShown ? summary?.projected_expenses_primary : undefined) ?? summary?.projected_expenses ?? summary?.monthly_expenses ?? 0
        const isDefaultCycle = activeCycleKey === timelineData?.[0]?.default_key
        const cycleDueDate = activeCycle?.due_date ?? null
        const dueIn = cycleDueDate ? daysUntil(cycleDueDate) : null
        // Show the countdown whenever the due date is upcoming (future or today),
        // OR when the default bill is overdue (urgent, needs paying). Hide for
        // past bills the user can't act on.
        const dueSubtitle = (() => {
          if (dueIn == null) return null
          if (dueIn > 0) return t('accounts.dueIn', { count: dueIn })
          if (dueIn === 0) return t('accounts.dueToday')
          if (isDefaultCycle) return t('accounts.overdueDays', { count: Math.abs(dueIn) })
          return null
        })()
        const dueSubtitleClass =
          dueIn != null && dueIn < 0 ? 'text-rose-500'
          : dueIn != null && dueIn <= 3 ? 'text-rose-500'
          : dueIn != null && dueIn <= 7 ? 'text-amber-600'
          : 'text-muted-foreground'
        // Compare against the previous canonical timeline item. Its amount is
        // stable for a Statement; unavailable periods fall back to the scoped
        // summary when one exists.
        const prevTotal = Number(
          previousCycle?.amount
          ?? previousCycleSummary?.monthly_expenses
          ?? 0,
        )
        const showComparison = !!previousCycle && prevTotal > 0
        const deltaPct = showComparison ? ((billTotal - prevTotal) / prevTotal) * 100 : null
        const prevCycleLabel = previousCycle?.due_date
          ? format(parseISO(previousCycle.due_date + 'T00:00:00'), 'MMM yyyy', {
              locale: resolveDateFnsLocale(i18n.resolvedLanguage ?? i18n.language),
            })
          : previousCycle?.due_month ?? null
        return (
          <div className={`grid grid-cols-3 gap-2 sm:gap-4 mb-6 ${cycleSectionClass}`} aria-busy={cycleSwitching}>
            <div className="bg-card rounded-xl border border-border shadow-sm p-3 sm:p-4 overflow-hidden">
              <p className="text-[10px] sm:text-xs font-medium text-muted-foreground mb-1 flex items-center gap-1 truncate">
                <span className="truncate">{t('accounts.cycleBillTotal')}</span>
                <span className={`inline-flex shrink-0 items-center rounded px-1 py-0 text-[8px] sm:text-[9px] font-bold uppercase tracking-wide ${activeBill ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'bg-amber-500/10 text-amber-700 dark:text-amber-400'}`}>
                  {activeBill
                    ? t('accounts.billConfidence.confirmed')
                    : t('accounts.billConfidence.estimated')}
                </span>
              </p>
              <p className="text-[length:clamp(0.7rem,3.5vw,1.25rem)] sm:text-2xl font-bold tabular-nums text-foreground">
                {mask(formatCurrency(billTotal, displayCurrency, locale))}
              </p>
              {deltaPct != null && prevCycleLabel && (
                <p className={`text-[10px] sm:text-xs font-medium mt-0.5 tabular-nums ${deltaPct > 0 ? 'text-rose-500' : 'text-emerald-600'}`}>
                  {deltaPct > 0 ? '+' : ''}{deltaPct.toFixed(0)}% <span className="text-muted-foreground font-normal">vs {prevCycleLabel}</span>
                </p>
              )}
              {activeBill?.closing_date && (
                <p className="text-[10px] text-muted-foreground mt-0.5 truncate">
                  {t('accounts.billConfidence.closedOn', {
                    date: format(parseISO(activeBill.closing_date + 'T00:00:00'), 'P', {
                      locale: resolveDateFnsLocale(i18n.resolvedLanguage ?? i18n.language),
                    }),
                  })}
                </p>
              )}
            </div>
            <div className="bg-card rounded-xl border border-border shadow-sm p-3 sm:p-4 overflow-hidden">
              <p className="text-[10px] sm:text-xs font-medium text-muted-foreground mb-1 flex items-center gap-1 truncate">
                {t('accounts.availableCredit')}
                <span className="inline-flex items-center px-1 py-0 rounded text-[8px] sm:text-[9px] font-bold uppercase tracking-wide bg-muted text-muted-foreground shrink-0">
                  {t('accounts.currentTag')}
                </span>
              </p>
              <p className="text-[length:clamp(0.7rem,3.5vw,1.25rem)] sm:text-2xl font-bold tabular-nums text-emerald-600">
                {account.available_credit != null
                  ? mask(formatCurrency(Number(account.available_credit), account.currency, locale))
                  : '—'}
              </p>
            </div>
            <div className="bg-card rounded-xl border border-border shadow-sm p-3 sm:p-4 overflow-hidden">
              <p className="text-[10px] sm:text-xs font-medium text-muted-foreground mb-1 truncate">
                {t('accounts.dueDate')}
              </p>
              <p className="text-[length:clamp(0.7rem,3.5vw,1.25rem)] sm:text-2xl font-bold tabular-nums text-foreground">
                {cycleDueDate ? formatFriendlyDate(cycleDueDate, dateLocale) : '—'}
              </p>
              {dueSubtitle && (
                <p className={`text-[10px] sm:text-xs font-medium mt-0.5 ${dueSubtitleClass}`}>
                  {dueSubtitle}
                </p>
              )}
            </div>
          </div>
        )
      })() : (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-4 mb-6">
          <div className="bg-card rounded-xl border border-border shadow-sm p-3 sm:p-4 overflow-hidden">
            <p className="text-[10px] sm:text-xs font-medium text-muted-foreground mb-1 truncate">
              {t('accounts.currentBalance')}
            </p>
            <p className={`text-[length:clamp(0.7rem,3.5vw,1.25rem)] sm:text-2xl font-bold tabular-nums ${(summary?.current_balance ?? 0) < 0 ? 'text-rose-500' : 'text-emerald-600'}`}>
              {mask(formatCurrency(totalBalance, displayCurrency, locale))}
            </p>
          </div>
          <div className="bg-card rounded-xl border border-border shadow-sm p-3 sm:p-4 overflow-hidden">
            <p className="text-[10px] sm:text-xs font-medium text-muted-foreground mb-1 truncate">
              {t('accounts.projectedBalance', 'Projected balance')}
            </p>
            <p className={`text-[length:clamp(0.7rem,3.5vw,1.25rem)] sm:text-2xl font-bold tabular-nums ${projectedBalance < 0 ? 'text-rose-500' : 'text-emerald-600'}`}>
              {mask(formatCurrency(projectedBalance, displayCurrency, locale))}
            </p>
            {/* Naming the gap keeps the two cards from reading as a
                contradiction: the forecast is the current balance plus the
                money that has not settled yet. Same "label: value" shape as
                the projected income/expense sub-lines beside it. */}
            {Math.abs(projectedBalance - totalBalance) > 0.005 && (
              <p className="text-[10px] sm:text-xs text-muted-foreground truncate">
                {t('accounts.notSettled')}: {mask(formatCurrency(Math.abs(projectedBalance - totalBalance), displayCurrency, locale))}
              </p>
            )}
          </div>
          <div className="bg-card rounded-xl border border-border shadow-sm p-3 sm:p-4 overflow-hidden">
            <p className="text-[10px] sm:text-xs font-medium text-muted-foreground mb-1 truncate">
              {t('accounts.income')}
            </p>
            <p className="text-[length:clamp(0.7rem,3.5vw,1.25rem)] sm:text-2xl font-bold tabular-nums text-emerald-600">
              {mask(formatCurrency(actualIncome, displayCurrency, locale))}
            </p>
            {hasProjectedIncome && (
              <p className="text-[10px] sm:text-xs text-muted-foreground truncate">
                {t('accounts.projectedIncome')}: {mask(formatCurrency(projectedIncome, displayCurrency, locale))}
              </p>
            )}
          </div>
          <div className="bg-card rounded-xl border border-border shadow-sm p-3 sm:p-4 overflow-hidden">
            <p className="text-[10px] sm:text-xs font-medium text-muted-foreground mb-1 truncate">
              {t('accounts.expenses')}
            </p>
            <p className="text-[length:clamp(0.7rem,3.5vw,1.25rem)] sm:text-2xl font-bold tabular-nums text-rose-500">
              {mask(formatCurrency(actualExpenses, displayCurrency, locale))}
            </p>
            {hasProjectedExpenses && (
              <p className="text-[10px] sm:text-xs text-muted-foreground truncate">
                {t('accounts.projectedExpenses')}: {mask(formatCurrency(projectedExpenses, displayCurrency, locale))}
              </p>
            )}
          </div>
        </div>
      )}

      {isCreditCard && (() => {
        const limit = account.credit_limit != null ? Number(account.credit_limit) : null
        // Cycle-bound utilization: how much of the limit was charged in the cycle
        // currently being viewed. For the current cycle this matches the "current
        // open balance" since nothing has been paid yet; for past cycles it shows
        // that month's burn rate against the (current) limit.
        const closedBankBill = !primaryShown && activeBill?.source === 'bank' && activeBill.closing_date
          && activeBill.closing_date < format(new Date(), 'yyyy-MM-dd')
          ? Number(activeBill.total_amount)
          : null
        const cycleBillTotal = closedBankBill ?? (primaryShown ? summary?.projected_expenses_primary : undefined) ?? summary?.projected_expenses ?? summary?.monthly_expenses ?? 0
        const utilized = limit != null ? cycleBillTotal : null
        const rawPct = limit != null && limit > 0 && utilized != null ? (utilized / limit) * 100 : null
        const pct = rawPct != null ? Math.min(100, rawPct) : null
        return (
          <div className={`bg-card rounded-xl border border-border shadow-sm p-4 sm:p-5 mb-6 ${cycleSectionClass}`} aria-busy={cycleSwitching}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                {account.card_brand && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-foreground/5 text-foreground text-[10px] sm:text-xs font-bold tracking-wide uppercase">
                    {account.card_brand}
                  </span>
                )}
                {account.card_level && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 text-[10px] sm:text-xs font-bold tracking-wide uppercase">
                    {account.card_level}
                  </span>
                )}
                {!account.card_brand && !account.card_level && (
                  <p className="text-[10px] sm:text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {t('accounts.typeCreditCard')}
                  </p>
                )}
              </div>
              {canWrite && (
                <button
                  type="button"
                  onClick={() => setCcSettingsOpen(true)}
                  className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  title={t('common.edit')}
                >
                  <Pencil size={13} />
                </button>
              )}
            </div>
            {limit != null && pct != null && rawPct != null && (
              <>
                <div className="flex items-baseline justify-between mb-2">
                  <p className="text-[10px] sm:text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {t('accounts.utilization')}
                  </p>
                  <p className={`text-sm font-bold tabular-nums ${rawPct >= 100 ? 'text-rose-500' : 'text-foreground'}`}>{rawPct.toFixed(1)}%</p>
                </div>
                <div className="h-2 bg-muted/60 rounded-full overflow-hidden mb-2">
                  <div
                    className={`h-full rounded-full transition-all ${utilizationColor(rawPct)}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground tabular-nums mb-4">
                  {mask(formatCurrency(utilized ?? 0, account.currency, locale))}
                  {' / '}
                  {mask(formatCurrency(limit, account.currency, locale))}
                </p>
              </>
            )}
            <div className="grid grid-cols-2 gap-3 pt-3 border-t border-border">
              <div>
                <p className="text-[10px] sm:text-xs font-medium text-muted-foreground mb-0.5">
                  {t('accounts.creditLimit')}
                </p>
                <p className="text-sm sm:text-base font-semibold tabular-nums text-foreground">
                  {limit != null ? mask(formatCurrency(limit, account.currency, locale)) : '—'}
                </p>
              </div>
              <div>
                {/* Closing date. For bill-driven cycles we derive it from the
                    bill's due_date + account.statement_close_day (handles
                    dynamic close days). For cycle-math cycles, filterTo is
                    the day before the close, so close = filterTo + 1. */}
                <p className="text-[10px] sm:text-xs font-medium text-muted-foreground mb-0.5">
                  {t('accounts.statementCloseDay')}
                </p>
                <p className="text-sm sm:text-base font-semibold tabular-nums text-foreground">
                  {activeCycle?.closing_date
                    ? formatDateStr(activeCycle.closing_date, dateLocale)
                    : (filterTo
                        ? formatDateStr(format(addDays(parseISO(filterTo), 1), 'yyyy-MM-dd'), dateLocale)
                        : '—')}
                </p>
              </div>
            </div>
          </div>
        )
      })()}

      {account.type === 'loan' && (
        <LoanScheduleCard accountId={account.id} locale={locale} dateLocale={dateLocale} mask={mask} canWrite={canWrite} />
      )}

      {/* Balance / Cycle spending chart */}
      {(() => {
        const cycleEmpty = isCreditCard && chartData.length > 0 && chartData[chartData.length - 1].balance === 0
        const balances = chartData.map(d => d.balance)
        const dataMin = balances.length > 0 ? Math.min(...balances) : 0
        const dataMax = balances.length > 0 ? Math.max(...balances) : 0
        const flat = dataMin === 0 && dataMax === 0
        // The Y axis rounds its bounds outward to hundreds and the area path
        // is drawn down to that rounded floor, so the fill's gradient box
        // spans the axis domain, not the data. Deriving the zero split from
        // the data would put the colour flip at the wrong height: for a
        // series of [-680, 105] the real zero sits at 22% of the domain while
        // the data ratio says 13%. Keep both in step with the axis below.
        const domainMin = dataMin < 0 ? Math.floor(dataMin / 100) * 100 : 0
        const domainMax = dataMax === 0 ? 100 : Math.ceil(dataMax / 100) * 100
        const zeroFrac = domainMax === domainMin
          ? 1
          : Math.min(1, Math.max(0, domainMax / (domainMax - domainMin)))
        const crossesZero = dataMin < 0 && dataMax > 0
        // The line path never touches the baseline, so its gradient box is
        // the data extent rather than the domain.
        const strokeSplit = crossesZero
          ? Math.min(1, Math.max(0, dataMax / (dataMax - dataMin)))
          : 1
        const strokeSplitFrac = flat ? 1 : Math.min(1, strokeSplit + 0.01)
        const strokeSolid = dataMin >= 0 ? '#10B981' : '#F43F5E'
        const lastBalance = balances.length > 0 ? balances[balances.length - 1] : 0
        return (
      <div className={`bg-card rounded-xl border border-border shadow-sm mb-6 ${cycleSectionClass}`} aria-busy={cycleSwitching}>
        <div className="px-5 pt-5 pb-3">
          <p className="text-base font-bold text-foreground">
            {isCreditCard ? t('accounts.cycleSpending') : t('dashboard.balanceFlow')}
          </p>
        </div>
        <div className="px-1 pb-4 h-[280px]">
          {chartLoading ? (
            <Skeleton className="h-full w-full" />
          ) : cycleEmpty ? (
            <div className="h-full w-full flex flex-col items-center justify-center gap-2 text-muted-foreground">
              <Clock className="h-8 w-8 opacity-40" />
              <p className="text-sm">{t('accounts.noChargesYet')}</p>
            </div>
          ) : chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={chartData}
                margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
              >
                <defs>
                  {isCreditCard ? (
                    <linearGradient id="acctBalGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#F43F5E" stopOpacity={0.18} />
                      <stop offset="95%" stopColor="#F43F5E" stopOpacity={0.02} />
                    </linearGradient>
                  ) : (
                    <>
                      <linearGradient id="acctBalGrad" x1="0" y1="0" x2="0" y2="1">
                        {crossesZero || dataMin >= 0 ? (
                          <>
                            <stop offset="0%" stopColor="#10B981" stopOpacity={0.18} />
                            <stop offset={`${zeroFrac * 100}%`} stopColor="#10B981" stopOpacity={0.02} />
                          </>
                        ) : null}
                        {crossesZero || dataMax <= 0 ? (
                          <>
                            <stop offset={`${zeroFrac * 100}%`} stopColor="#F43F5E" stopOpacity={0.02} />
                            <stop offset="100%" stopColor="#F43F5E" stopOpacity={0.18} />
                          </>
                        ) : null}
                      </linearGradient>
                      {crossesZero && (
                        <linearGradient id="acctBalStroke" x1="0" y1="0" x2="0" y2="1">
                          <stop offset={`${strokeSplitFrac * 100}%`} stopColor="#10B981" />
                          <stop offset={`${strokeSplitFrac * 100}%`} stopColor="#F43F5E" />
                        </linearGradient>
                      )}
                    </>
                  )}
                </defs>
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                  axisLine={false}
                  tickLine={false}
                  interval="preserveStartEnd"
                  minTickGap={40}
                />
                <YAxis
                  tickFormatter={(v) => {
                    if (privacyMode) return ''
                    if (v === 0) return '0'
                    return formatCompactCurrency(v, displayCurrency, locale)
                  }}
                  tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                  axisLine={false}
                  tickLine={false}
                  width={64}
                  tickCount={5}
                  domain={[
                    (dataMin: number) => dataMin < 0 ? Math.floor(dataMin / 100) * 100 : 0,
                    (dataMax: number) => dataMax === 0 ? 100 : Math.ceil(dataMax / 100) * 100,
                  ]}
                />
                <Tooltip
                  formatter={(value) => [
                    value !== null ? (privacyMode ? MASK : formatCurrency(Number(value), displayCurrency, locale)) : '\u2014',
                    isCreditCard ? t('accounts.cycleSpending') : t('accounts.currentBalance'),
                  ]}
                  labelFormatter={(label) => label}
                  contentStyle={{
                    background: 'var(--card)',
                    color: 'var(--foreground)',
                    border: '1px solid var(--border)',
                    borderRadius: '0.75rem',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
                    fontSize: '12px',
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="balance"
                  stroke="none"
                  tooltipType="none"
                  fill={flat ? '#10B981' : 'url(#acctBalGrad)'}
                />
                <Line
                  type="monotone"
                  dataKey="balance"
                  stroke={isCreditCard ? '#F43F5E' : (crossesZero ? 'url(#acctBalStroke)' : strokeSolid)}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 3, fill: isCreditCard ? '#F43F5E' : (lastBalance >= 0 ? '#10B981' : '#F43F5E') }}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-muted-foreground text-sm text-center py-12">{t('dashboard.noData')}</p>
          )}
        </div>
      </div>
        )
      })()}

      {/* Transaction table */}
      <div className={`bg-card rounded-xl border border-border shadow-sm overflow-hidden ${cycleSectionClass}`} aria-busy={cycleSwitching}>
        <div className="px-5 py-4 border-b border-border">
          <p className="font-semibold text-foreground">{t('transactions.title')}</p>
        </div>
        <div className="p-0">
          {txLoading ? (
            <div className="p-6 space-y-3">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
            </div>
          ) : displayRows.length === 0 ? (
            <p className="p-6 text-center text-muted-foreground">{t('accounts.noTransactions')}</p>
          ) : isMobile ? (
            <div>
              {groupedByDate.map((group) => (
                <div key={group.date}>
                  <div className="bg-muted/80 px-4 py-1.5 border-b border-border">
                    <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      {group.label}
                    </span>
                  </div>
                  {group.items.map((tx) => (
                    <MobileTransactionRow
                      key={tx.id}
                      tx={tx}
                      account={account}
                      groupName={undefined}
                      selected={false}
                      selectable={false}
                      canWrite={canWrite}
                      highlighted={false}
                      locale={locale}
                      userCurrency={userCurrency}
                      onSelect={() => {}}
                      showPayee
                      localizeOpeningBalance
                      onClick={(clickedTx) => {
                        // The opening-balance row is synthetic; the desktop
                        // table makes it non-clickable and mobile must match.
                        if (clickedTx.source === 'opening_balance') return
                        if (!clickedTx.is_shared && canWrite) {
                          setEditingTx(clickedTx)
                          setDialogOpen(true)
                        }
                      }}
                    />
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="px-2 sm:px-4 py-3 text-left font-medium whitespace-nowrap">{t('transactions.date')}</th>
                    <th className="px-2 sm:px-4 py-3 text-left font-medium">{t('transactions.description')}</th>
                    <th className="px-2 sm:px-4 py-3 text-left font-medium hidden md:table-cell">{t('transactions.category')}</th>
                    <th className="px-2 sm:px-4 py-3 text-right font-medium whitespace-nowrap">{t('transactions.amount')}</th>
                    <th className="px-2 sm:px-4 py-3 text-right font-medium hidden sm:table-cell whitespace-nowrap">{t('accounts.runningBalance')}</th>
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map((tx) => {
                    const isOpening = tx.source === 'opening_balance'
                    const isTransfer = isTransferTransaction(tx)
                    const isIgnored = tx.is_ignored
                    const isVirtual = tx.virtual === true
                    return (
                      <tr
                        key={tx.id}
                        className={`border-b last:border-0 transition-colors ${isOpening ? 'bg-muted/60' : (canWrite && !isVirtual) ? 'hover:bg-muted cursor-pointer' : ''} ${isVirtual ? 'opacity-80' : ''}`}
                        onClick={() => {
                          if (!isOpening && !isVirtual && canWrite) {
                            setEditingTx(tx)
                            setDialogOpen(true)
                          }
                        }}
                      >
                        <td className="px-3 sm:px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                          {formatDateStr(tx.date, dateLocale)}
                        </td>
                        <td className="px-3 sm:px-4 py-3 w-full max-w-0">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="font-semibold text-foreground text-sm truncate">{transactionDescription(tx.description, tx.source, t)}</span>
                            <div className="flex items-center gap-1 shrink-0">
                            {isTransfer && (
                              <span className="ml-2 inline-flex items-center gap-1 text-xs text-blue-600 font-normal bg-blue-50 border border-blue-200 rounded px-1.5 py-0.5">
                                <ArrowLeftRight className="h-3 w-3" />
                                {t('transactions.transfer')}
                                <span title={t('transactions.transferTooltip')}><HelpCircle className="h-3 w-3 text-blue-400" /></span>
                              </span>
                            )}
                            {isIgnored && (
                              <span className="ml-2 inline-flex items-center gap-1 text-xs text-gray-600 font-normal bg-gray-100 border border-gray-200 rounded px-1.5 py-0.5">
                                <EyeClosed className="h-3 w-3" />
                                {t('transactions.ignored')}
                                <span title={t('transactions.ignoreTransferHint')}><HelpCircle className="h-3 w-3 text-blue-400" /></span>
                              </span>
                            )}
                            {isVirtual && (
                              <ProjectedTransactionBadge />
                            )}
                            {tx.recurring_transaction_id != null && !isVirtual && (
                              <span
                                className="text-[10px] font-semibold uppercase tracking-wide text-primary bg-primary/5 border border-primary/10 px-1.5 py-0.5 rounded-full shrink-0"
                                title={t('transactions.recurringLinkedTooltip')}
                              >
                                {t('transactions.recurringBadge')}
                              </span>
                            )}
                            {tx.installment_number != null && tx.total_installments != null && (
                              <span
                                className="ml-2 inline-flex items-center text-[10px] font-bold tabular-nums text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-500/20 border border-amber-200 dark:border-amber-500/30 px-1.5 py-0.5 rounded-full"
                                title={tx.installment_total_amount != null
                                  ? t('transactions.installmentTooltip', { count: tx.total_installments, total: tx.installment_total_amount })
                                  : undefined}
                              >
                                {tx.installment_number}/{tx.total_installments}
                              </span>
                            )}
                            {shouldShowPendingBadge(tx) && (
                              <span
                                title={t('transactions.pending')}
                                className="shrink-0 inline-flex items-center justify-center rounded-full border border-amber-200 bg-amber-50 p-0.5 dark:border-amber-500/30 dark:bg-amber-500/10"
                              >
                                <Clock size={12} className="text-amber-500" role="img" aria-label={t('transactions.pending')} />
                              </span>
                            )}
                            {tx.effective_bill_date && (
                              <span
                                className="ml-2 inline-flex items-center gap-1 text-xs text-violet-600 dark:text-violet-400 font-normal bg-violet-50 dark:bg-violet-500/10 border border-violet-200 dark:border-violet-500/30 rounded px-1.5 py-0.5"
                                title={t('transactions.billOverrideTooltip', 'Movida para a fatura com vencimento em {{date}}', { date: formatDateStr(tx.effective_bill_date, dateLocale) })}
                              >
                                <CalendarClock className="h-3 w-3" />
                                {formatDateStr(tx.effective_bill_date, dateLocale)}
                              </span>
                            )}
                            {(tx.attachment_count ?? 0) > 0 && (
                              <Paperclip size={12} className="ml-2 inline text-muted-foreground" />
                            )}
                            </div>
                          </div>
                          {tx.card_last4 && cards.length > 1 && (
                            <p className="text-xs text-muted-foreground mt-0.5 truncate">
                              {accountCardLabel(cards.find(c => c.last4 === tx.card_last4) ?? { alias: null, last4: tx.card_last4 })}
                            </p>
                          )}
                          {(tx.payee_name || tx.payee) && (tx.payee_name || tx.payee) !== tx.description && (
                            <p className="text-xs text-muted-foreground mt-0.5 truncate">{tx.payee_name || tx.payee}</p>
                          )}
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell">
                          {isSplitByCategory(tx) ? (
                            <span className="flex items-center gap-1.5">
                              <TransactionCategoryIcon tx={tx} size="sm" />
                              <CategorySplitBadge tx={tx} />
                            </span>
                          ) : tx.category ? (
                            <span className="flex items-center gap-1.5">
                              <CategoryIcon icon={tx.category.icon} color={tx.category.color} size="sm" />
                              <span className="text-sm text-muted-foreground">{tx.category.name}</span>
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className={`px-2 sm:px-4 py-3 text-right text-xs sm:text-sm font-semibold tabular-nums whitespace-nowrap ${tx.is_ignored ? 'text-gray-500' : tx.type === 'credit' ? 'text-emerald-600' : 'text-rose-500'}`}>
                          {mask(`${tx.is_ignored ? ' ' : tx.type === 'credit' ? '+' : '-'}${formatCurrency(Math.abs(Number(tx.amount)), tx.currency, locale)}`)}
                          {tx.currency !== userCurrency && tx.amount_primary != null && (
                            <span className="block text-[10px] text-muted-foreground tabular-nums">
                              {mask(formatCurrency(Math.abs(tx.amount_primary), userCurrency, locale))}
                            </span>
                          )}
                        </td>
                        <td className={`px-4 py-3 text-right tabular-nums text-sm hidden sm:table-cell whitespace-nowrap ${(account.type === 'credit_card' ? tx.runningBalance > 0 : tx.runningBalance < 0) ? 'text-rose-500' : 'text-muted-foreground'}`}>
                          {mask(formatCurrency(tx.runningBalance, displayCurrency, locale))}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          {!isCreditCard && ledger.hasNextPage && (
            <button
              type="button"
              className="w-full px-4 py-2.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors border-t border-border disabled:cursor-not-allowed disabled:opacity-50"
              disabled={ledger.isFetchingNextPage}
              onClick={() => ledger.fetchNextPage()}
            >
              {ledger.isFetchingNextPage
                ? t('common.loading')
                : t('common.showMore', {
                    count: Math.min(TRANSACTIONS_PAGE_SIZE, ledgerTotal - (ledgerItems?.length ?? 0)),
                  })}
            </button>
          )}
        </div>
      </div>

      <TransactionDialog
        open={dialogOpen}
        onClose={() => {
          setDialogOpen(false)
          setEditingTx(null)
          setDuplicateDraft(null)
          createMutation.reset()
        }}
        transaction={editingTx}
        duplicateDraft={duplicateDraft}
        formResetKey={formResetKey}
        defaultAccountId={id}
        categories={categoriesList ?? []}
        categoryGroups={categoryGroupsList ?? []}
        accounts={accountsList ?? []}
        onSave={(data, recurringData, installmentData, pendingFiles, action) => {
          if (editingTx) {
            updateMutation.mutate({ id: editingTx.id, ...data })
          } else {
            createTransaction(data, recurringData, installmentData, pendingFiles, action)
          }
        }}
        onDelete={editingTx ? () => deleteMutation.mutate(editingTx.id) : undefined}
        onUnlinkTransfer={(pairId) => unlinkTransferMutation.mutate(pairId)}
        loading={createMutation.isPending || updateMutation.isPending || deleteMutation.isPending || unlinkTransferMutation.isPending}
        error={createMutation.error ? extractApiError(createMutation.error) : updateMutation.error ? extractApiError(updateMutation.error) : null}
        isSynced={editingTx?.source === 'sync'}
      />

      <TransferDialog
        open={transferDialogOpen}
        onClose={() => setTransferDialogOpen(false)}
        accounts={accountsList ?? []}
        onSave={(data) => transferMutation.mutate(data)}
        loading={transferMutation.isPending}
        defaultFromAccountId={id}
      />

      {account && (
        <CreditCardSettingsDialog
          open={ccSettingsOpen}
          onClose={() => setCcSettingsOpen(false)}
          account={account}
          onSave={(data) => ccSettingsMutation.mutate(data)}
          loading={ccSettingsMutation.isPending}
        />
      )}
    </div>
  )
}

function CreditCardSettingsDialog({
  open,
  onClose,
  account,
  onSave,
  loading,
}: {
  open: boolean
  onClose: () => void
  account: { credit_limit: number | null; statement_close_day: number | null; payment_due_day: number | null }
  onSave: (data: { credit_limit: number | null; statement_close_day: number | null; payment_due_day: number | null }) => void
  loading: boolean
}) {
  const { t } = useTranslation()
  const [creditLimit, setCreditLimit] = useState('')
  const [closeDay, setCloseDay] = useState('')
  const [dueDay, setDueDay] = useState('')

  const formKey = JSON.stringify([open, account.credit_limit, account.statement_close_day, account.payment_due_day])
  const [previousFormKey, setPreviousFormKey] = useState<string | null>(null)
  if (formKey !== previousFormKey) {
    setPreviousFormKey(formKey)
    if (open) {
      setCreditLimit(account.credit_limit != null ? String(account.credit_limit) : '')
      setCloseDay(account.statement_close_day != null ? String(account.statement_close_day) : '')
      setDueDay(account.payment_due_day != null ? String(account.payment_due_day) : '')
    }
  }

  const parseDay = (v: string): number | null => {
    const n = parseInt(v, 10)
    return Number.isFinite(n) && n >= 1 && n <= 31 ? n : null
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('accounts.typeCreditCard')}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            onSave({
              credit_limit: creditLimit !== '' ? parseFloat(creditLimit) : null,
              statement_close_day: parseDay(closeDay),
              payment_due_day: parseDay(dueDay),
            })
          }}
          className="space-y-4"
        >
          {(!account.statement_close_day || !account.payment_due_day) && (
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t('accounts.ccSettingsHint')}
            </p>
          )}
          <div className="space-y-2">
            <Label>{t('accounts.creditLimit')}</Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={creditLimit}
              onChange={(e) => setCreditLimit(e.target.value)}
              placeholder="0.00"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t('accounts.statementCloseDay')}</Label>
              <Input
                type="number"
                min="1"
                max="31"
                value={closeDay}
                onChange={(e) => setCloseDay(e.target.value)}
                placeholder={t('accounts.dayOfMonthHint')}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('accounts.paymentDueDay')}</Label>
              <Input
                type="number"
                min="1"
                max="31"
                value={dueDay}
                onChange={(e) => setDueDay(e.target.value)}
                placeholder={t('accounts.dayOfMonthHint')}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? t('common.loading') : t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
