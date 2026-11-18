/**
 * Canonical credit-card cycle wiring.
 *
 * Domain arithmetic belongs to the backend timeline interface. These tests
 * verify that the page forwards an opaque cycle key and drops that key as soon
 * as the user chooses a generic date range.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'

import AccountDetailPage from '@/pages/account-detail'
import { renderWithProviders } from '@/test/utils'

const api = vi.hoisted(() => ({
  accounts: {
    get: vi.fn(),
    creditCardTimeline: vi.fn(),
    summary: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    cards: vi.fn(),
    installmentForecasts: vi.fn(),
  },
  transactions: { list: vi.fn(), update: vi.fn(), delete: vi.fn(), create: vi.fn() },
  dashboard: { projectedTransactions: vi.fn() },
  categories: { list: vi.fn() },
  categoryGroups: { list: vi.fn() },
}))

vi.mock('@/lib/api', () => ({
  accounts: api.accounts,
  transactions: api.transactions,
  dashboard: api.dashboard,
  categories: api.categories,
  categoryGroups: api.categoryGroups,
}))

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
  useWorkspace: () => ({ canWrite: true }),
}))

// Closes on the 30th, bills due on the 10th. The newest bill is due
// 2026-05-10, so the cycle that is still open starts on 2026-04-30.
const account = {
  id: 'acc-1',
  name: 'Card',
  type: 'credit_card',
  currency: 'BRL',
  balance: -280,
  is_active: true,
  credit_limit: 5000,
  statement_close_day: 30,
  payment_due_day: 10,
}

const timeline = [{
  account_id: 'acc-1',
  default_key: 'cycle:2026-09-30',
  items: [
    {
      account_id: 'acc-1', due_month: '2026-04', kind: 'statement',
      cycle_key: 'bill:bill-apr', start: '2026-02-28', end: '2026-03-29',
      closing_date: '2026-03-30', due_date: '2026-04-10', amount: 125,
      primary_amount: null, source: 'bank', record_id: 'bill-apr', status: 'open',
      editable: false, unavailable_reason: null,
    },
    {
      account_id: 'acc-1', due_month: '2026-05', kind: 'statement',
      cycle_key: 'bill:bill-may', start: '2026-03-30', end: '2026-04-29',
      closing_date: '2026-04-30', due_date: '2026-05-10', amount: 280,
      primary_amount: null, source: 'bank', record_id: 'bill-may', status: 'open',
      editable: false, unavailable_reason: null,
    },
    {
      account_id: 'acc-1', due_month: '2026-10', kind: 'projection',
      cycle_key: 'cycle:2026-09-30', start: '2026-08-30', end: '2026-09-29',
      closing_date: '2026-09-30', due_date: '2026-10-10', amount: 0,
      primary_amount: null, source: null, record_id: null, status: null,
      editable: false, unavailable_reason: null,
    },
  ],
}]

/** The cycle header. Matching on the month alone is ambiguous: the timeline
 *  bar for the same cycle carries the same text. */
function cycleHeader() {
  return screen
    .getAllByRole('button')
    .find((b) => b.getAttribute('aria-haspopup') === 'dialog' && /\d{4}|-/.test(b.textContent ?? ''))!
}

/** Every `transactions.list` call the page has made, oldest first. */
function txCalls() {
  return api.transactions.list.mock.calls.map(([args]) => args as Record<string, unknown>)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.setSystemTime(new Date('2026-09-08T12:00:00'))
  api.accounts.get.mockResolvedValue(account)
  api.accounts.creditCardTimeline.mockResolvedValue(timeline)
  api.accounts.list.mockResolvedValue([account])
  api.accounts.cards.mockResolvedValue([])
  api.accounts.installmentForecasts.mockResolvedValue([])
  api.accounts.summary.mockResolvedValue({
    monthly_income: 0, monthly_expenses: 0, projected_income: 0, projected_expenses: 0,
  })
  api.transactions.list.mockResolvedValue({ items: [], total: 0 })
  api.dashboard.projectedTransactions.mockResolvedValue([])
  api.categories.list.mockResolvedValue([])
  api.categoryGroups.list.mockResolvedValue([])
})

async function renderPage() {
  const rendered = renderWithProviders(<AccountDetailPage />, {
    route: '/accounts/acc-1',
    path: '/accounts/:id',
  })
  await waitFor(() => {
    expect(txCalls().at(-1)?.cycle_key).toBe('cycle:2026-09-30')
  })
  return rendered
}

describe('credit card cycle window', () => {
  it('uses the canonical key for the open cycle', async () => {
    await renderPage()

    await waitFor(() => {
      const last = txCalls().at(-1)!
      expect(last.cycle_key).toBe('cycle:2026-09-30')
      expect(last.from).toBeUndefined()
      expect(last.to).toBeUndefined()
    })
  })

  it('uses the canonical key for a bank statement', async () => {
    const { user } = await renderPage()

    await user.click(await screen.findByTitle('Previous cycle'))

    await waitFor(() => {
      const last = txCalls().at(-1)!
      expect(last.cycle_key).toBe('bill:bill-may')
    })
  })

  it('drops canonical semantics on a hand-picked range', async () => {
    const { user } = await renderPage()

    await user.click(await screen.findByTitle('Previous cycle'))
    await waitFor(() => expect(txCalls().at(-1)!.cycle_key).toBe('bill:bill-may'))

    await user.click(cycleHeader())
    await user.click(await screen.findByRole('button', { name: '4/29/2026' }))
    await user.click(screen.getByRole('button', { name: 'April 2026' }))
    await user.click(screen.getByRole('button', { name: 'May' }))
    await user.click(await screen.findByRole('button', { name: '15' }))

    await waitFor(() => {
      const last = txCalls().at(-1)!
      expect(last.to).toBe('2026-05-15')
      expect(last.cycle_key).toBeUndefined()
    })
  }, 10_000)

  it('names a hand-picked range by its own dates instead of a statement month', async () => {
    const { user } = await renderPage()

    await user.click(await screen.findByTitle('Previous cycle'))
    await user.click(cycleHeader())
    await user.click(await screen.findByRole('button', { name: '4/29/2026' }))
    await user.click(screen.getByRole('button', { name: 'April 2026' }))
    await user.click(screen.getByRole('button', { name: 'May' }))
    await user.click(await screen.findByRole('button', { name: '15' }))

    // Before the fix this read "Jun 2026", naming the window after a bill it
    // has no claim to.
    await waitFor(() => expect(cycleHeader().textContent).toMatch(/30 Mar - 15 May/i))
  })

  it('keeps the page on screen while the next cycle loads', async () => {
    const { user } = await renderPage()
    // Jumping two cycles back skips the prefetched previous summary, so both
    // the summary and the transactions of the target cycle are still in flight.
    // The frontend lib target predates Promise.withResolvers.
    let resolveSummary!: (value: unknown) => void
    let resolveTransactions!: (value: unknown) => void
    api.accounts.summary.mockImplementationOnce(() => new Promise((resolve) => { resolveSummary = resolve }))
    api.transactions.list.mockImplementationOnce(() => new Promise((resolve) => { resolveTransactions = resolve }))

    await user.click(await screen.findByRole('button', { name: /Apr 2026/ }))

    // Before the fix the whole page was swapped for a bare skeleton here.
    await waitFor(() => expect(cycleHeader().getAttribute('aria-busy')).toBe('true'))
    expect(screen.getByTitle('Next cycle')).toBeInTheDocument()

    resolveSummary({ monthly_income: 0, monthly_expenses: 0, projected_income: 0, projected_expenses: 0 })
    resolveTransactions({ items: [], total: 0 })
    await waitFor(() => expect(cycleHeader().getAttribute('aria-busy')).toBe('false'))
  })

  it('stops at the oldest statement instead of leaving the timeline', async () => {
    const { user } = await renderPage()
    const previous = await screen.findByTitle('Previous cycle')

    await user.click(previous)
    await waitFor(() => expect(txCalls().at(-1)!.cycle_key).toBe('bill:bill-may'))
    await user.click(previous)
    await waitFor(() => expect(txCalls().at(-1)!.cycle_key).toBe('bill:bill-apr'))

    // Before the fix a further click stepped onto a bare date window a month
    // earlier, named by its dates instead of a statement month.
    expect(previous).toBeDisabled()
    expect(screen.getByTitle('Next cycle')).toBeEnabled()
  })

  it('lists the installments the bank will bill on the open statement', async () => {
    api.accounts.installmentForecasts.mockResolvedValue([{
      key: 'tx-1:7', description: 'THIAGO PEREIRA', amount: 720, currency: 'BRL', type: 'debit',
      purchase_date: '2026-05-06', due_date: '2026-10-10', installment_number: 7,
      total_installments: 10, category_id: null, card_last4: '9984',
    }])

    await renderPage()

    await waitFor(() => expect(api.accounts.installmentForecasts).toHaveBeenCalledWith('acc-1', 'cycle:2026-09-30'))
    expect(await screen.findByText('THIAGO PEREIRA')).toBeInTheDocument()
    expect(screen.getByText('7/10')).toBeInTheDocument()
  })
})

/** A one-statement timeline whose statement is the default bill. */
function statementTimeline(statement: { source: 'bank' | 'manual'; closing_date: string; due_date: string; amount: number }) {
  return [{
    account_id: 'acc-1',
    default_key: 'bill:bill-1',
    items: [{
      account_id: 'acc-1', due_month: statement.due_date.slice(0, 7), kind: 'statement',
      cycle_key: 'bill:bill-1', start: '2026-08-01', end: '2026-08-29',
      closing_date: statement.closing_date, due_date: statement.due_date, amount: statement.amount,
      primary_amount: null, source: statement.source, record_id: 'bill-1', status: 'open',
      editable: statement.source === 'manual', unavailable_reason: null,
    }],
  }]
}

describe('bill total provenance', () => {
  it('calls the open cycle a Securo estimate and explains what it adds up', async () => {
    api.accounts.summary.mockResolvedValue({
      monthly_income: 0, monthly_expenses: 0, projected_income: 0, projected_expenses: 720,
    })
    api.accounts.installmentForecasts.mockResolvedValue([{
      key: 'tx-1:7', description: 'THIAGO PEREIRA', amount: 720, currency: 'BRL', type: 'debit',
      purchase_date: '2026-05-06', due_date: '2026-10-10', installment_number: 7,
      total_installments: 10, category_id: null, card_last4: '9984',
    }])
    const { user } = await renderPage()

    expect(await screen.findByText('Securo estimate')).toBeInTheDocument()
    await screen.findByText('THIAGO PEREIRA')
    await user.click(screen.getByRole('button', { name: "What's included?" }))

    expect(await screen.findByText('1 forecast installment')).toBeInTheDocument()
    expect(screen.getByText('Estimated total')).toBeInTheDocument()
    // The listed parts already add up to the total.
    expect(screen.queryByText('Payments and adjustments')).not.toBeInTheDocument()
  })

  it('credits a closed bank statement to the bank, with its closing date', async () => {
    const { user } = await renderPage()

    await user.click(await screen.findByTitle('Previous cycle'))

    expect(await screen.findByText('Bank · closed 04/30')).toBeInTheDocument()
    expect(screen.queryByText('Securo estimate')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: "What's included?" })).not.toBeInTheDocument()
  })

  it('shows a manual statement with its own amount, labelled manual', async () => {
    api.accounts.creditCardTimeline.mockResolvedValue(statementTimeline({
      source: 'manual', closing_date: '2026-08-30', due_date: '2026-09-10', amount: 512,
    }))
    api.accounts.summary.mockResolvedValue({
      monthly_income: 0, monthly_expenses: 0, projected_income: 0, projected_expenses: 999,
    })
    renderWithProviders(<AccountDetailPage />, { route: '/accounts/acc-1', path: '/accounts/:id' })

    expect(await screen.findByText('Manual')).toBeInTheDocument()
    expect(screen.getAllByText(/512\.00/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/999\.00/)).not.toBeInTheDocument()
    expect(screen.queryByText(/^Bank/)).not.toBeInTheDocument()
  })

  it('does not credit the bank for a statement it has not closed yet', async () => {
    api.accounts.creditCardTimeline.mockResolvedValue(statementTimeline({
      source: 'bank', closing_date: '2026-09-30', due_date: '2026-10-10', amount: 300,
    }))
    renderWithProviders(<AccountDetailPage />, { route: '/accounts/acc-1', path: '/accounts/:id' })

    expect(await screen.findByText('Closes on 09/30')).toBeInTheDocument()
    expect(screen.getByText('Securo estimate')).toBeInTheDocument()
    expect(screen.queryByText(/^Bank/)).not.toBeInTheDocument()
  })
})
