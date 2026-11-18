import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQueries, useQuery } from '@tanstack/react-query'
import { format } from 'date-fns'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react'

import { accounts as accountsApi, dashboard as dashboardApi, recurring as recurringApi } from '@/lib/api'
import { getAccountName } from '@/lib/account-utils'
import { formatCurrency } from '@/lib/format'
import { currentMonth, monthLabel, monthRange, shiftMonth } from '@/lib/month-utils'
import {
  billSourceOf,
  billTotalOf,
  monthFromParam,
  recurringTotals,
  sortOccurrences,
  type BillSource,
  type RecurringTotals,
} from '@/lib/month-view'
import { formatDayMonth } from '@/hooks/use-credit-card-timeline'
import { useDisplayLocale, useDateLocale } from '@/hooks/use-display-locale'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { useAuth } from '@/contexts/auth-context'
import { useWorkspace } from '@/contexts/workspace-context'
import { useCollectionFilter } from '@/contexts/collection-filter-context'
import { AccountIcon } from '@/components/account-icon'
import { BillSourceChip, MonthBillDialog } from '@/components/month-bill-dialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import type { Account, AccountSummary, CreditCardTimelineItem, DashboardSummary, RecurringMonthOccurrence } from '@/types'

type BillRowData = {
  card: Account
  item: CreditCardTimelineItem | null
  source: BillSource | null
  /** In the card's currency; null while an estimate's summary loads. */
  total: number | null
  /** The same total in the primary currency; null without a rate. */
  totalPrimary: number | null
  summaryLoading: boolean
}

export default function MonthPage() {
  const { t, i18n } = useTranslation()
  const locale = useDisplayLocale()
  const dateLocale = useDateLocale()
  const { mask } = usePrivacyMode()
  const { user } = useAuth()
  const { hasModule } = useWorkspace()
  const { activeAccountIds, activeWalletIds } = useCollectionFilter()
  const primaryCurrency = user?.preferences?.currency_display ?? 'USD'
  const uiLanguage = i18n.resolvedLanguage ?? i18n.language
  const today = format(new Date(), 'yyyy-MM-dd')
  const thisMonth = currentMonth()

  // The month lives in the URL: shareable, and it survives a reload.
  const [searchParams, setSearchParams] = useSearchParams()
  const month = monthFromParam(searchParams.get('month'), thisMonth)
  useEffect(() => {
    if (searchParams.get('month') === month) return
    const params = new URLSearchParams(searchParams)
    params.set('month', month)
    setSearchParams(params, { replace: true })
  }, [month, searchParams, setSearchParams])
  const goToMonth = (next: string) => {
    const params = new URLSearchParams(searchParams)
    params.set('month', next)
    setSearchParams(params)
  }

  const title = monthLabel(month, uiLanguage).replace(/^\p{L}/u, (c) => c.toUpperCase())
  const { from: monthFrom, to: monthTo } = monthRange(month)
  // A collection holding only wallets has no accounts to report on.
  const noAccounts = activeAccountIds !== null && activeAccountIds.length === 0
  const showCards = hasModule('accounts')
  const showRecurring = hasModule('recurring')
  const money = (value: number, currency = primaryCurrency) => mask(formatCurrency(value, currency, locale))

  const summaryQuery = useQuery({
    queryKey: ['dashboard', 'summary', month, activeAccountIds, activeWalletIds],
    queryFn: () => dashboardApi.summary(monthFrom, undefined, activeAccountIds ?? undefined, activeWalletIds ?? undefined),
  })
  const recurringQuery = useQuery({
    queryKey: ['recurring', 'month-status', month, activeAccountIds],
    queryFn: () => recurringApi.monthStatus(month, activeAccountIds ?? undefined),
    enabled: showRecurring && !noAccounts,
  })
  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: () => accountsApi.list(),
  })

  const cards = useMemo(() => (accountsQuery.data ?? []).filter((account) =>
    account.type === 'credit_card'
    && !account.is_closed
    && (!activeAccountIds || activeAccountIds.includes(account.id)),
  ), [accountsQuery.data, activeAccountIds])
  const timelineQuery = useQuery({
    queryKey: ['credit-card-timeline', cards.map((card) => card.id), monthFrom, monthTo],
    queryFn: () => accountsApi.creditCardTimeline(cards.map((card) => card.id), monthFrom, monthTo),
    enabled: showCards && cards.length > 0,
    staleTime: 1000 * 60 * 5,
  })
  const itemByCard = useMemo(() => new Map((timelineQuery.data ?? []).map((timeline) => [
    timeline.account_id,
    timeline.items.find((item) => item.due_month === month) ?? null,
  ])), [timelineQuery.data, month])

  // An estimated bill totals what its cycle summary projects, exactly as the
  // card page does; the query key is the card page's, so they share it.
  const estimates = cards.flatMap((card) => {
    const item = itemByCard.get(card.id)
    return item?.cycle_key && billSourceOf(item, today) === 'estimate'
      ? [{ card, cycleKey: item.cycle_key }]
      : []
  })
  const summaryQueries = useQueries({
    queries: estimates.map(({ card, cycleKey }) => ({
      queryKey: ['accounts', card.id, 'summary', { cycle_key: cycleKey }],
      queryFn: () => accountsApi.summary(card.id, undefined, undefined, cycleKey),
    })),
  })
  const summaryByCard = new Map<string, { data: AccountSummary | undefined; isLoading: boolean }>(
    estimates.map(({ card }, index) => [card.id, summaryQueries[index]]),
  )

  const billRows: BillRowData[] = cards.map((card) => {
    const item = itemByCard.get(card.id) ?? null
    if (!item?.cycle_key) {
      return { card, item, source: null, total: null, totalPrimary: null, summaryLoading: false }
    }
    const source = billSourceOf(item, today)
    const summary = summaryByCard.get(card.id)
    const total = billTotalOf(item, summary?.data, today)
    const totalPrimary = total == null
      ? null
      : card.currency === primaryCurrency
        ? total
        : source === 'estimate'
          ? summary?.data?.projected_expenses_primary ?? null
          : item.primary_amount != null ? Number(item.primary_amount) : null
    return { card, item, source, total, totalPrimary, summaryLoading: !!summary?.isLoading }
  })
  const billsTotal = billRows.reduce((sum, row) => sum + (row.totalPrimary ?? 0), 0)
  const billsMissingConversion = billRows.some((row) => row.total != null && row.totalPrimary == null)
  const billsSettling = billRows.some((row) => row.summaryLoading)
  const [openBill, setOpenBill] = useState<{ card: Account; item: CreditCardTimelineItem & { cycle_key: string } } | null>(null)

  const accountNames = useMemo(
    () => new Map((accountsQuery.data ?? []).map((account) => [account.id, getAccountName(account)])),
    [accountsQuery.data],
  )

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight" aria-live="polite">{title}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{t('month.subtitle')}</p>
        </div>
        <nav className="flex items-center gap-2" aria-label={t('month.navigation')}>
          {month !== thisMonth && (
            <Button variant="outline" size="sm" className="h-10" onClick={() => goToMonth(thisMonth)}>
              {t('month.current')}
            </Button>
          )}
          <div className="flex items-center gap-0.5 rounded-lg border border-border bg-card p-1">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => goToMonth(shiftMonth(month, -1))} aria-label={t('month.previous')}>
              <ChevronLeft size={16} />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => goToMonth(shiftMonth(month, 1))} aria-label={t('month.next')}>
              <ChevronRight size={16} />
            </Button>
          </div>
        </nav>
      </div>

      <ResultsSection
        summary={summaryQuery.data}
        loading={summaryQuery.isLoading}
        error={summaryQuery.isError}
        onRetry={() => void summaryQuery.refetch()}
        money={money}
      />

      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        {showCards && (
          <section aria-labelledby="month-bills-title" className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
            <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-4 sm:px-5">
              <div>
                <h2 id="month-bills-title" className="font-semibold">{t('month.bills.title')}</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">{t('month.bills.hint')}</p>
              </div>
              {billRows.some((row) => row.total != null) && (
                <div className="text-right">
                  <p className="text-xs text-muted-foreground">{t('month.bills.total')}</p>
                  {billsSettling ? (
                    <Skeleton className="ml-auto mt-1 h-6 w-24" />
                  ) : (
                    <p className="text-lg font-semibold tabular-nums">{money(billsTotal)}</p>
                  )}
                </div>
              )}
            </div>
            {accountsQuery.isLoading || timelineQuery.isLoading ? (
              <div className="space-y-3 p-4 sm:p-5" aria-busy="true" aria-label={t('common.loading')}>
                <Skeleton className="h-14 rounded-lg" />
                <Skeleton className="h-14 rounded-lg" />
              </div>
            ) : accountsQuery.isError || timelineQuery.isError ? (
              <SectionError
                message={t('month.bills.error')}
                onRetry={() => void (accountsQuery.isError ? accountsQuery.refetch() : timelineQuery.refetch())}
              />
            ) : cards.length === 0 ? (
              <div className="px-5 py-10 text-center">
                <p className="text-sm font-medium">{t('month.bills.empty')}</p>
                <p className="mx-auto mt-1 max-w-sm text-xs leading-5 text-muted-foreground">{t('month.bills.emptyHint')}</p>
                <Button asChild variant="outline" size="sm" className="mt-4"><Link to="/cards">{t('month.bills.goToCards')}</Link></Button>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {billRows.map((row) => (
                  <li key={row.card.id}>
                    <BillRow
                      row={row}
                      today={today}
                      dateLocale={dateLocale}
                      money={money}
                      onOpen={(item) => setOpenBill({ card: row.card, item })}
                    />
                  </li>
                ))}
              </ul>
            )}
            {billsMissingConversion && (
              <p className="border-t border-border px-4 py-3 text-xs text-amber-700 dark:text-amber-400 sm:px-5">
                {t('month.bills.missingConversion')}
              </p>
            )}
          </section>
        )}

        {showRecurring && (
          <RecurringSection
            occurrences={noAccounts ? [] : recurringQuery.data}
            loading={!noAccounts && recurringQuery.isLoading}
            error={recurringQuery.isError}
            onRetry={() => void recurringQuery.refetch()}
            accountNames={accountNames}
            dateLocale={dateLocale}
            money={money}
          />
        )}
      </div>

      <MonthBillDialog bill={openBill} primaryCurrency={primaryCurrency} onClose={() => setOpenBill(null)} />
    </div>
  )
}

function SectionError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation()
  return (
    <div role="alert" className="px-5 py-8 text-center">
      <p className="text-sm font-medium">{message}</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>{t('common.retry')}</Button>
    </div>
  )
}

type Money = (value: number, currency?: string) => string

function ResultsSection({ summary, loading, error, onRetry, money }: {
  summary: DashboardSummary | undefined
  loading: boolean
  error: boolean
  onRetry: () => void
  money: Money
}) {
  const { t } = useTranslation()
  const currency = summary?.primary_currency
  const income = Number(summary?.monthly_income_primary ?? summary?.monthly_income ?? 0)
  const expenses = Number(summary?.monthly_expenses_primary ?? summary?.monthly_expenses ?? 0)
  const projectedIncome = Number(summary?.projected_income_primary ?? summary?.projected_income ?? income)
  const projectedExpenses = Number(summary?.projected_expenses_primary ?? summary?.projected_expenses ?? expenses)
  const lines = [
    { key: 'income', realized: income, projected: projectedIncome, tone: 'text-emerald-700 dark:text-emerald-400' },
    { key: 'expenses', realized: expenses, projected: projectedExpenses, tone: 'text-rose-600 dark:text-rose-400' },
    {
      key: 'net',
      realized: income - expenses,
      projected: projectedIncome - projectedExpenses,
      tone: income - expenses < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground',
    },
  ] as const

  return (
    <section aria-labelledby="month-results-title" className="rounded-xl border border-border bg-card shadow-sm">
      <div className="border-b border-border px-4 py-4 sm:px-5">
        <h2 id="month-results-title" className="font-semibold">{t('month.results.title')}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('month.results.hint')}</p>
      </div>
      {error ? (
        <SectionError message={t('month.results.error')} onRetry={onRetry} />
      ) : (
        <dl className="grid divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          {lines.map((line) => {
            const pending = line.projected - line.realized
            return (
              <div key={line.key} className="px-4 py-4 sm:px-5">
                <dt className="text-sm text-muted-foreground">{t(`month.results.${line.key}`)}</dt>
                {loading ? (
                  <dd><Skeleton className="mt-1 h-8 w-32" /></dd>
                ) : (
                  <dd>
                    <p className={cn('mt-0.5 text-2xl font-semibold tracking-tight tabular-nums', line.tone)}>
                      {money(line.realized, currency)}
                    </p>
                    <p className="text-xs text-muted-foreground">{t('month.results.realized')}</p>
                    {Math.abs(pending) > 0.005 && (
                      <p className="mt-2 text-xs tabular-nums">
                        <span className="text-violet-700 dark:text-violet-300">
                          {t('month.results.pending', { amount: `${pending > 0 ? '+' : ''}${money(pending, currency)}` })}
                        </span>
                        <span className="text-muted-foreground"> · {t('month.results.projected', { amount: money(line.projected, currency) })}</span>
                      </p>
                    )}
                  </dd>
                )}
              </div>
            )
          })}
        </dl>
      )}
      {summary?.fx_fallback && (
        <p className="flex items-start gap-1.5 border-t border-border px-4 py-3 text-xs text-amber-700 dark:text-amber-400 sm:px-5">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          {t('month.results.fxFallback')}
        </p>
      )}
    </section>
  )
}

function BillRow({ row, today, dateLocale, money, onOpen }: {
  row: BillRowData
  today: string
  dateLocale: string
  money: Money
  onOpen: (item: CreditCardTimelineItem & { cycle_key: string }) => void
}) {
  const { t } = useTranslation()
  const { card, item, source, total } = row
  const name = getAccountName(card)
  const due = item?.due_date
    ? item.due_date < today
      ? t('accounts.billHeader.wasDue', { date: formatDayMonth(item.due_date, dateLocale) })
      : t('accounts.billHeader.due', { date: formatDayMonth(item.due_date, dateLocale) })
    : null
  const body = (
    <>
      <AccountIcon account={card} size="md" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{name}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {item?.cycle_key
            ? due ?? t('month.bills.noDue')
            : item?.unavailable_reason === 'past_statement_missing' && card.connection_id
              ? t('accounts.billSlot.bankMissing')
              : item?.unavailable_reason === 'missing_close_config' || item?.unavailable_reason === 'missing_due_config'
                ? t('month.bills.missingConfig')
                : t('accounts.billSlot.noStatement')}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {source == null ? (
          <span className="text-sm text-muted-foreground">—</span>
        ) : total == null ? (
          <Skeleton className="h-5 w-20" />
        ) : (
          <span className="text-sm font-semibold tabular-nums">{money(total, card.currency)}</span>
        )}
        {source && <BillSourceChip source={source} />}
      </div>
    </>
  )
  if (!item?.cycle_key || !source) {
    return <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">{body}</div>
  }
  const openable = { ...item, cycle_key: item.cycle_key }
  return (
    <button
      type="button"
      onClick={() => onOpen(openable)}
      aria-label={t('month.bills.open', { name })}
      className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-5"
    >
      {body}
      <ChevronRight size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  )
}

const STATUS_CHIP: Record<RecurringMonthOccurrence['status'], string> = {
  paid: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  pending: 'bg-foreground/5 text-foreground',
  overdue: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
}

function RecurringSection({ occurrences, loading, error, onRetry, accountNames, dateLocale, money }: {
  occurrences: RecurringMonthOccurrence[] | undefined
  loading: boolean
  error: boolean
  onRetry: () => void
  accountNames: Map<string, string>
  dateLocale: string
  money: Money
}) {
  const { t } = useTranslation()
  const sorted = useMemo(() => sortOccurrences(occurrences ?? []), [occurrences])
  const outflow = recurringTotals(sorted, 'debit')
  const inflow = recurringTotals(sorted, 'credit')
  const hasOutflow = sorted.some((item) => item.type === 'debit')
  const hasInflow = sorted.some((item) => item.type === 'credit')

  return (
    <section aria-labelledby="month-recurring-title" className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-4 sm:px-5">
        <div>
          <h2 id="month-recurring-title" className="font-semibold">{t('month.recurring.title')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('month.recurring.hint')}</p>
        </div>
        <Button asChild variant="ghost" size="sm" className="shrink-0"><Link to="/recurring">{t('month.recurring.manage')}</Link></Button>
      </div>
      {loading ? (
        <div className="space-y-3 p-4 sm:p-5" aria-busy="true" aria-label={t('common.loading')}>
          <Skeleton className="h-16 rounded-lg" />
          <Skeleton className="h-12 rounded-lg" />
          <Skeleton className="h-12 rounded-lg" />
        </div>
      ) : error ? (
        <SectionError message={t('month.recurring.error')} onRetry={onRetry} />
      ) : sorted.length === 0 ? (
        <div className="px-5 py-10 text-center">
          <p className="text-sm font-medium">{t('month.recurring.empty')}</p>
          <p className="mx-auto mt-1 max-w-sm text-xs leading-5 text-muted-foreground">{t('month.recurring.emptyHint')}</p>
        </div>
      ) : (
        <>
          {hasOutflow && <RecurringTotalsLine totals={outflow} type="debit" money={money} />}
          {hasInflow && <RecurringTotalsLine totals={inflow} type="credit" money={money} />}
          <ul className="divide-y divide-border">
            {sorted.map((item) => {
              const paid = item.status === 'paid'
              const amount = paid ? item.paid_amount ?? item.expected_amount : item.expected_amount
              const differs = paid && item.paid_amount != null && Math.abs(item.paid_amount - item.expected_amount) > 0.005
              const date = formatDayMonth(item.date, dateLocale)
              const when = paid
                ? t(item.type === 'credit' ? 'month.recurring.receivedOn' : 'month.recurring.paidOn', { date })
                : t('month.recurring.expectedOn', { date })
              const statusKey = paid && item.type === 'credit' ? 'received' : item.status
              const account = item.account_id ? accountNames.get(item.account_id) : null
              return (
                <li
                  key={`${item.recurring_id}:${item.date}:${item.transaction_id ?? ''}`}
                  className={cn('flex items-start justify-between gap-3 px-4 py-3 sm:px-5', item.status === 'overdue' && 'bg-amber-500/[0.06]')}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{item.description}</p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {account ? `${account} · ${when}` : when}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className={cn('text-sm font-semibold tabular-nums', item.type === 'credit' && 'text-emerald-700 dark:text-emerald-400')}>
                      {item.type === 'credit' ? '+' : ''}{money(amount, item.currency)}
                    </span>
                    <span className="flex items-center gap-1.5">
                      {differs && (
                        <span className="text-[11px] text-muted-foreground tabular-nums">
                          {t('month.recurring.expectedAmount', { amount: money(item.expected_amount, item.currency) })}
                        </span>
                      )}
                      <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold leading-tight', STATUS_CHIP[item.status])}>
                        {t(`month.recurring.status.${statusKey}`)}
                      </span>
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>
        </>
      )}
      {(outflow.missingConversion || inflow.missingConversion) && (
        <p className="border-t border-border px-4 py-3 text-xs text-amber-700 dark:text-amber-400 sm:px-5">
          {t('month.recurring.missingConversion')}
        </p>
      )}
    </section>
  )
}

function RecurringTotalsLine({ totals, type, money }: { totals: RecurringTotals; type: 'debit' | 'credit'; money: Money }) {
  const { t } = useTranslation()
  const outflow = type === 'debit'
  return (
    <div className="border-b border-border px-4 py-3 sm:px-5">
      <p className="mb-2 text-xs font-medium text-muted-foreground">
        {t(outflow ? 'month.recurring.outflow' : 'month.recurring.inflow')}
      </p>
      <dl className="grid grid-cols-3 gap-3">
        <div>
          <dt className="text-xs text-muted-foreground">{t('month.recurring.expected')}</dt>
          <dd className="mt-0.5 text-sm font-semibold tabular-nums">{money(totals.expected)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t(outflow ? 'month.recurring.paid' : 'month.recurring.received')}</dt>
          <dd className="mt-0.5 text-sm font-semibold tabular-nums">{money(totals.paid)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('month.recurring.pending')}</dt>
          <dd className="mt-0.5 text-sm font-semibold tabular-nums">{money(totals.pending)}</dd>
          {totals.overdueCount > 0 && (
            <dd className="mt-0.5 flex items-center gap-1 text-[11px] font-medium text-amber-800 dark:text-amber-300">
              <AlertTriangle size={12} aria-hidden="true" />
              {t('month.recurring.overdueCount', { count: totals.overdueCount })}
            </dd>
          )}
        </div>
      </dl>
    </div>
  )
}
