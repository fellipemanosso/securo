/**
 * The Mês page: the month lives in the URL and drives every request, the
 * recurring list says what is paid, pending and overdue, and a card's bill
 * modal ends on the same total the card page shows for that bill.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { useLocation } from 'react-router-dom'

import MonthPage from '@/pages/month'
import AccountDetailPage from '@/pages/account-detail'
import { formatCurrency } from '@/lib/format'
import { renderWithProviders, t } from '@/test/utils'
import type { Category, CreditCardTimeline, RecurringMonthOccurrence, Transaction } from '@/types'

const api = vi.hoisted(() => ({
  accounts: {
    get: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    creditCardTimeline: vi.fn(),
    summary: vi.fn(),
    cards: vi.fn(),
    installmentForecasts: vi.fn(),
  },
  transactions: { list: vi.fn(), update: vi.fn(), delete: vi.fn(), create: vi.fn() },
  dashboard: { summary: vi.fn(), projectedTransactions: vi.fn() },
  recurring: { monthStatus: vi.fn() },
  categories: { list: vi.fn() },
  categoryGroups: { list: vi.fn() },
  connections: { list: vi.fn() },
}))

vi.mock('@/lib/api', () => api)

vi.mock('@/hooks/use-display-locale', () => ({
  useDisplayLocale: () => 'en-US',
  useDateLocale: () => 'en-US',
}))

vi.mock('@/hooks/use-privacy-mode', () => ({
  usePrivacyMode: () => ({ mask: (value: string) => value, privacyMode: false, MASK: '***' }),
}))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ user: { preferences: { currency_display: 'BRL' } } }),
}))

vi.mock('@/contexts/workspace-context', () => ({
  useWorkspace: () => ({ canWrite: true, hasModule: () => true }),
}))

vi.mock('@/contexts/collection-filter-context', () => ({
  useCollectionFilter: () => ({ activeAccountIds: null, activeWalletIds: null }),
}))

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
vi.mock('@/components/transaction-dialog', () => ({ TransactionDialog: () => null }))

const money = (value: number) => formatCurrency(value, 'BRL', 'en-US')

const card = {
  id: 'card-1', user_id: 'u', connection_id: null, external_id: null, name: 'Nubank', display_name: null,
  masked_number: null, institution_name: null, institution_logo_url: null, type: 'credit_card',
  balance: -350, current_balance: -350, previous_balance: null, balance_primary: null, currency: 'BRL',
  credit_limit: 5000, available_credit: 4650, statement_close_day: 15, payment_due_day: 25,
  next_close_date: null, next_due_date: null, minimum_payment: null, card_brand: null, card_level: null,
  shared_balance_group: null, is_closed: false, closed_at: null,
}

const CYCLE = 'cycle:2026-11-15'
const timeline: CreditCardTimeline[] = [{
  account_id: 'card-1',
  default_key: CYCLE,
  items: [
    {
      account_id: 'card-1', due_month: '2026-11', kind: 'projection', cycle_key: CYCLE,
      start: '2026-10-16', end: '2026-11-15', closing_date: '2026-11-15', due_date: '2026-11-25',
      // Deliberately not the bill total: an estimate reads the cycle summary, as the card page does.
      amount: 340, primary_amount: null, source: null, record_id: null, status: null, editable: false,
      unavailable_reason: null,
    },
  ],
}]

const groceries = { id: 'cat-food', name: 'Groceries', color: '#22c55e', icon: 'cart' } as Category

function row(overrides: Partial<Transaction>): Transaction {
  return {
    id: 'tx', user_id: 'u', account_id: 'card-1', category_id: null, category: null, external_id: null,
    description: 'Row', original_description: null, amount: 0, currency: 'BRL', date: '2026-11-02',
    type: 'debit', source: 'sync', status: 'posted', payee: null, payee_id: null, payee_name: null,
    notes: null, transfer_pair_id: null, amount_primary: null, fx_rate_used: null, fx_fallback: false,
    installment_number: null, total_installments: null, installment_total_amount: null,
    installment_purchase_date: null, installment_series_id: null, bill_id: null, effective_bill_date: null,
    splits: [], is_ignored: false, ...overrides,
  }
}

// A purchase, a refund that shrinks the bill and an installment the bank has
// not billed yet: 300 - 50 + 100.
const cycleRows = [
  row({ id: 'tx-market', description: 'Supermarket', amount: 300, category: groceries, category_id: 'cat-food', card_last4: '4321' }),
  row({ id: 'tx-refund', description: 'Refund', amount: 50, type: 'credit', category: groceries, category_id: 'cat-food', card_last4: '4321' }),
]
const forecasts = [{
  key: 'sofa-6', description: 'Sofa', amount: 100, currency: 'BRL', type: 'debit', purchase_date: '2026-06-02',
  due_date: '2026-11-25', installment_number: 6, total_installments: 10, category_id: null, card_last4: '4321',
}]

const occurrences: RecurringMonthOccurrence[] = [
  {
    recurring_id: 'rent', description: 'Rent', account_id: 'card-1', category_id: null, category_name: null,
    category_icon: null, category_color: null, type: 'debit', frequency: 'monthly', currency: 'BRL',
    date: '2026-11-05', expected_amount: 1500, expected_amount_primary: 1500, status: 'paid',
    transaction_id: 'tx-rent', paid_amount: 1500, paid_amount_primary: 1500,
  },
  {
    recurring_id: 'internet', description: 'Internet', account_id: 'card-1', category_id: null, category_name: null,
    category_icon: null, category_color: null, type: 'debit', frequency: 'monthly', currency: 'BRL',
    date: '2026-11-10', expected_amount: 120, expected_amount_primary: 120, status: 'overdue',
    transaction_id: null, paid_amount: null, paid_amount_primary: null,
  },
  {
    recurring_id: 'gym', description: 'Gym', account_id: 'card-1', category_id: null, category_name: null,
    category_icon: null, category_color: null, type: 'debit', frequency: 'monthly', currency: 'BRL',
    date: '2026-11-25', expected_amount: 90, expected_amount_primary: 90, status: 'pending',
    transaction_id: null, paid_amount: null, paid_amount_primary: null,
  },
]

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname}{location.search}</output>
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.setSystemTime(new Date('2026-11-18T12:00:00'))
  api.accounts.get.mockResolvedValue(card)
  api.accounts.list.mockResolvedValue([card])
  api.accounts.creditCardTimeline.mockResolvedValue(timeline)
  api.accounts.summary.mockResolvedValue({
    account_id: 'card-1', current_balance: -350, opening_balance: 0, monthly_income: 50,
    monthly_expenses: 300, projected_income: 50, projected_expenses: 350,
    current_balance_primary: null, opening_balance_primary: null, monthly_income_primary: null,
    monthly_expenses_primary: null,
  })
  api.accounts.cards.mockResolvedValue([{ last4: '4321', alias: 'Ana', is_hidden: false, transaction_count: 3, first_date: null, last_date: null }])
  api.accounts.installmentForecasts.mockResolvedValue(forecasts)
  api.transactions.list.mockResolvedValue({ items: cycleRows, total: cycleRows.length, page: 1, limit: 500, pages: 1 })
  api.dashboard.summary.mockResolvedValue({
    monthly_income: 8000, monthly_expenses: 3000, monthly_income_primary: 8000, monthly_expenses_primary: 3000,
    projected_income: 8000, projected_expenses: 3210, projected_income_primary: 8000, projected_expenses_primary: 3210,
    primary_currency: 'BRL', fx_fallback: false,
  })
  api.dashboard.projectedTransactions.mockResolvedValue([])
  api.recurring.monthStatus.mockResolvedValue(occurrences)
  api.categories.list.mockResolvedValue([groceries])
  api.categoryGroups.list.mockResolvedValue([])
  api.connections.list.mockResolvedValue([])
})

describe('MonthPage', () => {
  it('keeps the month in the URL and reloads every block for it', async () => {
    const { user } = renderWithProviders(<><MonthPage /><LocationProbe /></>, { route: '/month' })

    expect(await screen.findByRole('heading', { level: 1, name: 'November 2026' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/month?month=2026-11'))
    expect(api.dashboard.summary).toHaveBeenCalledWith('2026-11-01', undefined, undefined, undefined)
    expect(api.recurring.monthStatus).toHaveBeenCalledWith('2026-11', undefined)

    await user.click(screen.getByRole('button', { name: t('month.next') }))

    expect(await screen.findByRole('heading', { level: 1, name: 'December 2026' })).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('/month?month=2026-12')
    await waitFor(() => expect(api.dashboard.summary).toHaveBeenCalledWith('2026-12-01', undefined, undefined, undefined))
    expect(api.recurring.monthStatus).toHaveBeenCalledWith('2026-12', undefined)
    expect(api.accounts.creditCardTimeline).toHaveBeenCalledWith(['card-1'], '2026-12-01', '2026-12-31')

    await user.click(screen.getByRole('button', { name: t('month.current') }))
    expect(await screen.findByRole('heading', { level: 1, name: 'November 2026' })).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('/month?month=2026-11')

    await user.click(screen.getByRole('button', { name: t('month.previous') }))
    expect(await screen.findByRole('heading', { level: 1, name: 'October 2026' })).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('/month?month=2026-10')
  })

  it('opens the month a shared link names', async () => {
    renderWithProviders(<MonthPage />, { route: '/month?month=2025-02' })

    expect(await screen.findByRole('heading', { level: 1, name: 'February 2025' })).toBeInTheDocument()
    await waitFor(() => expect(api.recurring.monthStatus).toHaveBeenCalledWith('2025-02', undefined))
  })

  it('shows realized and still expected results', async () => {
    renderWithProviders(<MonthPage />, { route: '/month?month=2026-11' })

    const results = await screen.findByRole('region', { name: t('month.results.title') })
    expect(await within(results).findByText(money(8000))).toBeInTheDocument()
    expect(within(results).getByText(money(3000))).toBeInTheDocument()
    expect(within(results).getByText(money(5000))).toBeInTheDocument()
    expect(within(results).getAllByText(t('month.results.pending', { amount: `+${money(210)}` })).length).toBeGreaterThan(0)
  })

  it('marks each recurring entry paid, pending or overdue, with the totals', async () => {
    renderWithProviders(<MonthPage />, { route: '/month?month=2026-11' })

    const section = await screen.findByRole('region', { name: t('month.recurring.title') })
    const items = await within(section).findAllByRole('listitem')
    // What needs a decision comes first.
    expect(items.map((item) => item.querySelector('p')?.textContent)).toEqual(['Internet', 'Gym', 'Rent'])
    expect(within(items[0]).getByText(t('month.recurring.status.overdue'))).toBeInTheDocument()
    expect(within(items[1]).getByText(t('month.recurring.status.pending'))).toBeInTheDocument()
    expect(within(items[2]).getByText(t('month.recurring.status.paid'))).toBeInTheDocument()

    const totals = within(section).getByText(t('month.recurring.expected')).closest('dl')!
    expect(within(totals).getByText(money(1710))).toBeInTheDocument()
    expect(within(totals).getByText(money(1500))).toBeInTheDocument()
    expect(within(totals).getByText(money(210))).toBeInTheDocument()
    expect(within(totals).getByText(t('month.recurring.overdueCount', { count: 1 }))).toBeInTheDocument()
  })

  it('opens a bill whose total matches the card page, refund and forecast installment included', async () => {
    const { user, unmount } = renderWithProviders(<MonthPage />, { route: '/month?month=2026-11' })

    const bills = await screen.findByRole('region', { name: t('month.bills.title') })
    const open = await within(bills).findByRole('button', { name: t('month.bills.open', { name: 'Nubank' }) })
    await waitFor(() => expect(within(open).getByText(money(350))).toBeInTheDocument())
    expect(within(open).getByText(t('accounts.billConfidence.estimated'))).toBeInTheDocument()

    await user.click(open)
    const dialog = await screen.findByRole('dialog')
    const total = await within(dialog).findByTestId('month-bill-total')
    expect(total).toHaveTextContent(money(350))
    // The parts the total is made of, with no unexplained residual.
    expect(await within(dialog).findByText(t('accounts.billBreakdown.credits'))).toBeInTheDocument()
    expect(within(dialog).queryByText(t('accounts.billBreakdown.adjustments'))).not.toBeInTheDocument()
    const installments = within(dialog).getByRole('region', { name: t('month.bill.installments') })
    expect(within(installments).getByText('Sofa')).toBeInTheDocument()
    expect(within(installments).getByText('6/10')).toBeInTheDocument()
    expect(within(installments).getByText(t('month.bill.forecast'))).toBeInTheDocument()
    const byCard = within(dialog).getByRole('region', { name: t('month.bill.byCard') })
    expect(within(byCard).getByText(/4321/)).toHaveTextContent('Ana')
    const link = within(dialog).getByRole('link', { name: t('month.bill.openCard') })
    expect(link).toHaveAttribute('href', `/accounts/card-1?cycle=${encodeURIComponent(CYCLE)}`)
    const modalTotal = total.textContent
    unmount()

    // The card page, opened on that same bill, shows the same number.
    renderWithProviders(<AccountDetailPage />, {
      route: `/accounts/card-1?cycle=${encodeURIComponent(CYCLE)}`,
      path: '/accounts/:id',
    })
    const header = await screen.findByRole('region', { name: /bill/i })
    await waitFor(() => expect(within(header).getByText(modalTotal!)).toBeInTheDocument())
  })
})
