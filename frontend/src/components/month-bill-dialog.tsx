import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { format } from 'date-fns'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, CreditCard } from 'lucide-react'

import { accounts as accountsApi, categories as categoriesApi, transactions as transactionsApi } from '@/lib/api'
import { getAccountName } from '@/lib/account-utils'
import { formatCurrency } from '@/lib/format'
import { billAnalytics, billSourceOf, billTotalOf, installmentForecastRow, type BillRow, type BillSource } from '@/lib/month-view'
import { formatDayMonth, statementMonthLabel } from '@/hooks/use-credit-card-timeline'
import { useDisplayLocale, useDateLocale } from '@/hooks/use-display-locale'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { TransactionChip } from '@/components/transaction-chip'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import type { Account, CreditCardTimelineItem } from '@/types'

// Same page size Account Detail reads a cycle with, so both share one cache entry.
const CYCLE_PAGE_SIZE = 500

/** Every row of one canonical cycle, every page of it. */
async function fetchCycleTransactions(accountId: string, cycleKey: string) {
  const params = { account_id: accountId, cycle_key: cycleKey, limit: CYCLE_PAGE_SIZE, include_opening_balance: true }
  const first = await transactionsApi.list({ ...params, page: 1 })
  const items = [...first.items]
  for (let page = 2; items.length < first.total; page++) {
    const next = await transactionsApi.list({ ...params, page })
    if (next.items.length === 0) break
    items.push(...next.items)
  }
  return { ...first, items }
}

const BILL_SOURCE_CHIP: Record<BillSource, { className: string; labelKey: string }> = {
  bank: { className: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400', labelKey: 'accounts.billConfidence.bank' },
  manual: { className: 'bg-foreground/5 text-foreground', labelKey: 'accounts.billConfidence.manual' },
  estimate: { className: 'bg-violet-500/10 text-violet-700 dark:text-violet-300', labelKey: 'accounts.billConfidence.estimated' },
}

/** Whose number a bill is, in the card page's words and hues: the bank's,
 *  the user's, or Securo's estimate (the forecast violet, not a warning). */
export function BillSourceChip({ source }: { source: BillSource }) {
  const { t } = useTranslation()
  const chip = BILL_SOURCE_CHIP[source]
  return (
    <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold leading-tight', chip.className)}>
      {t(chip.labelKey)}
    </span>
  )
}

type OpenBill = { card: Account; item: CreditCardTimelineItem & { cycle_key: string } }
type BillAnalysisProps = OpenBill & { primaryCurrency: string }

/** A card's bill for the month, taken apart: its total (the card page's),
 *  what makes it up, and its categories, cards, installments and largest
 *  charges. */
export function MonthBillDialog({ bill, primaryCurrency, onClose }: {
  bill: OpenBill | null
  primaryCurrency: string
  onClose: () => void
}) {
  return (
    <Dialog open={!!bill} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto p-5 sm:max-w-2xl sm:p-6">
        {bill && <BillAnalysis card={bill.card} item={bill.item} primaryCurrency={primaryCurrency} />}
      </DialogContent>
    </Dialog>
  )
}

function BillAnalysis({ card, item, primaryCurrency }: BillAnalysisProps) {
  const { t, i18n } = useTranslation()
  const locale = useDisplayLocale()
  const dateLocale = useDateLocale()
  const { mask } = usePrivacyMode()
  const today = format(new Date(), 'yyyy-MM-dd')
  const cycleKey = item.cycle_key
  const source = billSourceOf(item, today)
  // Account Detail's default view: the card's own currency.
  const displayCurrency = card.currency
  const usePrimary = card.currency === primaryCurrency

  const summaryQuery = useQuery({
    queryKey: ['accounts', card.id, 'summary', { cycle_key: cycleKey }],
    queryFn: () => accountsApi.summary(card.id, undefined, undefined, cycleKey),
    enabled: source === 'estimate',
  })
  const txQuery = useQuery({
    queryKey: ['transactions', {
      account_id: card.id,
      cycle_key: cycleKey,
      from: undefined,
      to: undefined,
      include_opening_balance: true,
    }],
    queryFn: () => fetchCycleTransactions(card.id, cycleKey),
  })
  const forecastQuery = useQuery({
    queryKey: ['accounts', card.id, 'installment-forecasts', cycleKey],
    queryFn: () => accountsApi.installmentForecasts(card.id, cycleKey),
    enabled: item.kind !== 'statement',
  })
  const { data: cardList = [] } = useQuery({
    queryKey: ['accounts', card.id, 'cards'],
    queryFn: () => accountsApi.cards(card.id),
  })
  const { data: categoryList } = useQuery({ queryKey: ['categories'], queryFn: categoriesApi.list })

  const forecastRows = useMemo(
    () => (forecastQuery.data ?? []).map((forecast) => installmentForecastRow(forecast, card.id, categoryList)),
    [forecastQuery.data, card.id, categoryList],
  )
  const analytics = useMemo(
    () => txQuery.data ? billAnalytics(txQuery.data.items, forecastRows, usePrimary, displayCurrency) : null,
    [txQuery.data, forecastRows, usePrimary, displayCurrency],
  )
  const categoryMax = Math.max(0, ...(analytics?.byCategory.map((slice) => slice.amount) ?? []))

  const total = billTotalOf(item, summaryQuery.data, today)
  const money = (value: number) => mask(formatCurrency(value, displayCurrency, locale))
  const residual = analytics && total != null && Math.abs(total - analytics.parts.net) > 0.005
    ? total - analytics.parts.net
    : 0
  const failed = txQuery.isError || summaryQuery.isError || forecastQuery.isError
  const loading = !failed && (!analytics || total == null || (item.kind !== 'statement' && forecastQuery.isLoading))
  const aliasOf = (last4: string) => cardList.find((entry) => entry.last4 === last4)?.alias ?? null
  const billState = item.status === 'paid'
    ? 'paid'
    : item.closing_date && item.closing_date < today ? 'closed' : 'open'
  const language = i18n.resolvedLanguage ?? i18n.language

  return (
    <>
      <DialogHeader className="pr-8 text-left">
        <DialogTitle className="text-lg">
          {t('month.bill.title', { name: getAccountName(card), month: statementMonthLabel(item, language) })}
        </DialogTitle>
        <DialogDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {item.due_date && (
            <span>
              {item.due_date < today
                ? t('accounts.billHeader.wasDue', { date: formatDayMonth(item.due_date, dateLocale) })
                : t('accounts.billHeader.due', { date: formatDayMonth(item.due_date, dateLocale) })}
            </span>
          )}
          <BillSourceChip source={source} />
          <span className={cn(
            'inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold leading-tight',
            billState === 'paid' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'bg-foreground/5 text-foreground',
          )}>
            {t(`accounts.billHeader.state.${billState}`)}
          </span>
        </DialogDescription>
      </DialogHeader>

      <div>
        <p className="sr-only">{t('accounts.cycleBillTotal')}</p>
        {total == null && !failed ? (
          <Skeleton className="h-9 w-40" />
        ) : (
          <p className="text-3xl font-bold tracking-tight tabular-nums" data-testid="month-bill-total">
            {total == null ? '—' : money(total)}
          </p>
        )}
      </div>

      {failed ? (
        <div role="alert" className="rounded-lg border border-border bg-muted/40 p-4 text-sm">
          <p className="font-medium">{t('month.bill.error')}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => {
              void txQuery.refetch()
              if (summaryQuery.isError) void summaryQuery.refetch()
              if (forecastQuery.isError) void forecastQuery.refetch()
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      ) : loading || !analytics ? (
        <div className="space-y-3" aria-busy="true" aria-label={t('common.loading')}>
          <Skeleton className="h-24 rounded-lg" />
          <Skeleton className="h-40 rounded-lg" />
        </div>
      ) : (
        <div className="space-y-6">
          <section aria-labelledby="bill-composition">
            <h3 id="bill-composition" className="mb-2 text-sm font-semibold">{t('month.bill.composition')}</h3>
            <dl className="space-y-1.5 text-sm">
              <AmountLine label={t('accounts.billBreakdown.purchases')} value={money(analytics.parts.purchases)} />
              {analytics.parts.credits > 0.005 && (
                <AmountLine label={t('accounts.billBreakdown.credits')} value={money(-analytics.parts.credits)} />
              )}
              {analytics.parts.pending > 0.005 && (
                <AmountLine label={t('accounts.billBreakdown.pending')} value={money(analytics.parts.pending)} />
              )}
              {analytics.parts.installmentCount > 0 && (
                <AmountLine
                  label={t('accounts.billBreakdown.installments', { count: analytics.parts.installmentCount })}
                  value={money(analytics.parts.installments)}
                  forecast
                />
              )}
              {residual !== 0 && (
                <AmountLine label={t('accounts.billBreakdown.adjustments')} value={money(residual)} />
              )}
              <div className="flex items-baseline justify-between gap-3 border-t border-border pt-1.5 font-semibold">
                <dt>{t('month.bill.total')}</dt>
                <dd className="tabular-nums">{money(total ?? 0)}</dd>
              </div>
            </dl>
          </section>

          {analytics.byCategory.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('month.bill.noCharges')}</p>
          ) : (
            <section aria-labelledby="bill-categories">
              <h3 id="bill-categories" className="mb-2 text-sm font-semibold">{t('month.bill.byCategory')}</h3>
              <ul className="space-y-2.5">
                {analytics.byCategory.map((slice) => (
                  <li key={slice.id ?? 'none'} className="text-sm">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 truncate">{slice.name ?? t('transactions.uncategorized')}</span>
                      <span className="shrink-0 tabular-nums">{money(slice.amount)}</span>
                    </div>
                    {categoryMax > 0 && slice.amount > 0 && (
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                        <div
                          className="h-full rounded-full bg-rose-500/70"
                          style={{ width: `${(slice.amount / categoryMax) * 100}%`, ...(slice.color ? { backgroundColor: slice.color } : {}) }}
                        />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {analytics.byCard.some((slice) => slice.last4) && (
            <section aria-labelledby="bill-cards">
              <h3 id="bill-cards" className="mb-2 text-sm font-semibold">{t('month.bill.byCard')}</h3>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {analytics.byCard.map((slice) => {
                  const alias = slice.last4 ? aliasOf(slice.last4) : null
                  return (
                    <li key={slice.last4 ?? 'none'} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                      <span className="flex min-w-0 items-center gap-2">
                        <CreditCard size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                        <span className="truncate">
                          {slice.last4 ? `•••• ${slice.last4}` : t('month.bill.noCard')}
                          {alias && <span className="text-muted-foreground"> · {alias}</span>}
                        </span>
                      </span>
                      <span className="shrink-0 tabular-nums">{money(slice.amount)}</span>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}

          <section aria-labelledby="bill-installments">
            <h3 id="bill-installments" className="mb-2 text-sm font-semibold">{t('month.bill.installments')}</h3>
            {analytics.installments.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('month.bill.installmentsEmpty')}</p>
            ) : (
              <ChargeList rows={analytics.installments} money={money} showInstallment />
            )}
          </section>

          {analytics.topCharges.length > 0 && (
            <section aria-labelledby="bill-top">
              <h3 id="bill-top" className="mb-2 text-sm font-semibold">{t('month.bill.topCharges')}</h3>
              <ChargeList rows={analytics.topCharges} money={money} />
            </section>
          )}
        </div>
      )}

      <div className="flex justify-end border-t border-border pt-4">
        <Button asChild variant="outline" size="sm" className="gap-1.5">
          <Link to={`/accounts/${card.id}?cycle=${encodeURIComponent(cycleKey)}`}>
            {t('month.bill.openCard')}
            <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </>
  )
}

function AmountLine({ label, value, forecast = false }: { label: string; value: string; forecast?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={forecast ? 'text-violet-700 dark:text-violet-300' : 'text-muted-foreground'}>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  )
}

function ChargeList({ rows, money, showInstallment = false }: {
  rows: BillRow[]
  money: (value: number) => string
  showInstallment?: boolean
}) {
  const { t } = useTranslation()
  const dateLocale = useDateLocale()
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {rows.map(({ row, amount }) => (
        <li key={row.id} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
          <div className="min-w-0">
            <p className="truncate">{row.description}</p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>{formatDayMonth(row.date, dateLocale)}</span>
              {showInstallment && row.installment_number != null && row.total_installments != null && (
                <TransactionChip
                  aria-label={t('transactions.installmentNumber', { number: row.installment_number, total: row.total_installments })}
                >
                  {row.installment_number}/{row.total_installments}
                </TransactionChip>
              )}
              {row.virtual && <TransactionChip tone="forecast">{t('month.bill.forecast')}</TransactionChip>}
            </div>
          </div>
          <span className="shrink-0 tabular-nums">{money(amount)}</span>
        </li>
      ))}
    </ul>
  )
}
