/**
 * The arithmetic behind the Mês page: which month the URL names, where each
 * card's bill comes from and what it totals, how a bill splits into
 * categories, cards and installments, and the month's recurring totals.
 *
 * A bill's total here must be the number the card page shows for the same
 * cycle, so `billSourceOf` and `billTotalOf` follow Account Detail's
 * `billSource` and `billTotal` (account-detail.tsx) in its default view: the
 * card's own currency, no conversion toggled on.
 */
import type {
  AccountSummary,
  Category,
  CreditCardTimelineItem,
  InstallmentForecast,
  RecurringMonthOccurrence,
  Transaction,
} from '../types'
import { billContribution } from './account-detail-utils'

const MONTH_PARAM = /^\d{4}-(0[1-9]|1[0-2])$/

/** The `?month=YYYY-MM` the page was opened with, or the fallback. */
export function monthFromParam(value: string | null, fallback: string): string {
  return value && MONTH_PARAM.test(value) ? value : fallback
}

export type BillSource = 'bank' | 'manual' | 'estimate'

/** Only a statement the bank has closed, or one entered by hand, carries a
 *  settled amount; open and future statements are Securo's estimate. */
export function billSourceOf(
  item: Pick<CreditCardTimelineItem, 'kind' | 'amount' | 'source' | 'closing_date'>,
  today: string,
): BillSource {
  if (item.kind !== 'statement' || item.amount == null) return 'estimate'
  if (item.source === 'bank' && !!item.closing_date && item.closing_date < today) return 'bank'
  return item.source === 'manual' ? 'manual' : 'estimate'
}

/** The bill total in the card's currency: the statement's own amount when
 *  it is settled, otherwise the cycle summary's projected expenses. Null
 *  while an estimate's summary has not arrived. */
export function billTotalOf(
  item: Pick<CreditCardTimelineItem, 'kind' | 'amount' | 'source' | 'closing_date'>,
  summary: Pick<AccountSummary, 'projected_expenses' | 'monthly_expenses'> | undefined,
  today: string,
): number | null {
  if (billSourceOf(item, today) !== 'estimate') return Number(item.amount)
  if (!summary) return null
  return summary.projected_expenses ?? summary.monthly_expenses ?? 0
}

/** An installment the bank has not sent yet, as a virtual row of the bill,
 *  shaped like Account Detail's forecast rows so it counts the same way. */
export function installmentForecastRow(
  forecast: InstallmentForecast,
  accountId: string,
  categories: Category[] | undefined,
): Transaction {
  return {
    id: `installment-forecast-${forecast.key}`,
    user_id: '',
    account_id: accountId,
    category_id: forecast.category_id,
    category: categories?.find((category) => category.id === forecast.category_id) ?? null,
    external_id: null,
    description: forecast.description,
    original_description: null,
    amount: forecast.amount,
    currency: forecast.currency,
    date: forecast.purchase_date,
    type: forecast.type,
    source: 'projected',
    status: 'pending',
    payee: null,
    payee_id: null,
    payee_name: null,
    notes: null,
    transfer_pair_id: null,
    amount_primary: null,
    fx_rate_used: null,
    fx_fallback: false,
    installment_series_id: null,
    installment_number: forecast.installment_number,
    total_installments: forecast.total_installments,
    installment_total_amount: null,
    installment_purchase_date: forecast.purchase_date,
    card_last4: forecast.card_last4,
    bill_id: null,
    effective_bill_date: null,
    recurring_transaction_id: null,
    splits: [],
    is_ignored: false,
    virtual: true,
  }
}

export interface BillParts {
  purchases: number
  credits: number
  pending: number
  installments: number
  installmentCount: number
  /** What the listed rows add up to. */
  net: number
}

export interface CategorySlice {
  id: string | null
  name: string | null
  color: string | null
  amount: number
}

export interface CardSlice {
  last4: string | null
  amount: number
  count: number
}

export interface BillRow {
  row: Transaction
  amount: number
}

export interface BillAnalytics {
  parts: BillParts
  byCategory: CategorySlice[]
  byCard: CardSlice[]
  /** Running installments (k/N) and forecast ones, largest first. */
  installments: BillRow[]
  topCharges: BillRow[]
}

const TOP_CHARGES = 5

/** Split one bill's rows the ways the bill modal reads them. Every slice is
 *  built from `billContribution`, so categories, cards and parts all add up
 *  to `parts.net`, the same sum Account Detail's running total ends on. */
export function billAnalytics(
  rows: Transaction[],
  forecastRows: Transaction[],
  usePrimary: boolean,
  displayCurrency: string,
): BillAnalytics {
  const parts: BillParts = { purchases: 0, credits: 0, pending: 0, installments: 0, installmentCount: forecastRows.length, net: 0 }
  const categories = new Map<string, CategorySlice>()
  const cards = new Map<string, CardSlice>()
  const counted: BillRow[] = []

  const addCategory = (category: Category | null | undefined, fallbackId: string | null, amount: number) => {
    const id = category?.id ?? fallbackId
    const key = id ?? ''
    const slice = categories.get(key) ?? { id, name: category?.name ?? null, color: category?.color ?? null, amount: 0 }
    slice.amount += amount
    categories.set(key, slice)
  }

  for (const row of [...rows, ...forecastRows]) {
    const amount = billContribution(row, usePrimary, displayCurrency)
    if (amount == null) continue
    if (row.virtual) parts.installments += amount
    else if (amount < 0) parts.credits -= amount
    else if (row.status === 'pending') parts.pending += amount
    else parts.purchases += amount
    counted.push({ row, amount })

    const lines = row.has_category_lines ? row.category_lines ?? [] : []
    const linesTotal = lines.reduce((sum, line) => sum + Math.abs(Number(line.amount)), 0)
    if (lines.length > 0 && linesTotal > 0) {
      for (const line of lines) {
        addCategory(line.category, line.category_id, amount * (Math.abs(Number(line.amount)) / linesTotal))
      }
    } else {
      addCategory(row.category, row.category_id, amount)
    }

    const cardKey = row.card_last4 ?? ''
    const card = cards.get(cardKey) ?? { last4: row.card_last4 ?? null, amount: 0, count: 0 }
    card.amount += amount
    card.count += 1
    cards.set(cardKey, card)
  }
  parts.net = parts.purchases + parts.pending + parts.installments - parts.credits

  const byAmount = (a: { amount: number }, b: { amount: number }) => b.amount - a.amount
  const nonZero = (slice: { amount: number }) => Math.abs(slice.amount) > 0.005
  return {
    parts,
    byCategory: [...categories.values()].filter(nonZero).sort(byAmount),
    byCard: [...cards.values()].filter(nonZero).sort(byAmount),
    installments: counted
      .filter(({ row }) => (row.total_installments ?? 0) > 1)
      .sort(byAmount),
    topCharges: counted.filter(({ amount }) => amount > 0).sort(byAmount).slice(0, TOP_CHARGES),
  }
}

export interface RecurringTotals {
  expected: number
  paid: number
  pending: number
  overdueCount: number
  pendingCount: number
  paidCount: number
  /** Some occurrence in another currency had no rate and is left out. */
  missingConversion: boolean
}

/** Expected, paid and still-open totals for one direction, in the primary
 *  currency. Paid is what actually moved, so it can differ from expected. */
export function recurringTotals(
  occurrences: RecurringMonthOccurrence[],
  type: RecurringMonthOccurrence['type'],
): RecurringTotals {
  const totals: RecurringTotals = {
    expected: 0, paid: 0, pending: 0, overdueCount: 0, pendingCount: 0, paidCount: 0, missingConversion: false,
  }
  for (const item of occurrences) {
    if (item.type !== type) continue
    const expected = item.expected_amount_primary
    if (expected == null) totals.missingConversion = true
    else totals.expected += expected
    if (item.status === 'paid') {
      totals.paidCount += 1
      if (item.paid_amount_primary == null) totals.missingConversion = true
      else totals.paid += item.paid_amount_primary
      continue
    }
    if (item.status === 'overdue') totals.overdueCount += 1
    else totals.pendingCount += 1
    if (expected != null) totals.pending += expected
  }
  return totals
}

const STATUS_ORDER: Record<RecurringMonthOccurrence['status'], number> = { overdue: 0, pending: 1, paid: 2 }

/** What needs a decision first: overdue, then still pending, then paid,
 *  each by date. */
export function sortOccurrences(occurrences: RecurringMonthOccurrence[]): RecurringMonthOccurrence[] {
  return [...occurrences].sort((a, b) =>
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.date.localeCompare(b.date))
}
