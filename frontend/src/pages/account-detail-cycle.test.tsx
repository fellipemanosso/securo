/**
 * Canonical credit-card cycle wiring.
 *
 * Domain arithmetic belongs to the backend timeline interface. These tests
 * verify that the page forwards an opaque cycle key and drops that key as soon
 * as the user chooses a generic date range.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'

import AccountDetailPage from '@/pages/account-detail'
import { renderWithProviders } from '@/test/utils'
import type { Category, Transaction } from '@/types'

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
  connections: { list: vi.fn() },
}))

vi.mock('@/lib/api', () => ({
  accounts: api.accounts,
  transactions: api.transactions,
  dashboard: api.dashboard,
  categories: api.categories,
  categoryGroups: api.categoryGroups,
  connections: api.connections,
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

// Which transaction the page opens is what these tests check; the dialog's
// own form, and the APIs it loads, have their own tests.
vi.mock('@/components/transaction-dialog', () => ({
  TransactionDialog: ({ open, transaction }: { open: boolean; transaction: Transaction | null }) =>
    open ? <div role="dialog" aria-label={`Editing ${transaction?.description ?? ''}`} /> : null,
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
function statementTimeline(statement: { source: 'bank' | 'manual'; closing_date: string; due_date: string; amount: number; status?: 'open' | 'paid' }) {
  return [{
    account_id: 'acc-1',
    default_key: 'bill:bill-1',
    items: [{
      account_id: 'acc-1', due_month: statement.due_date.slice(0, 7), kind: 'statement',
      cycle_key: 'bill:bill-1', start: '2026-08-01', end: '2026-08-29',
      closing_date: statement.closing_date, due_date: statement.due_date, amount: statement.amount,
      primary_amount: null, source: statement.source, record_id: 'bill-1', status: statement.status ?? 'open',
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

    expect(await screen.findByText('Closes Wed, 9/30')).toBeInTheDocument()
    expect(screen.getByText('Securo estimate')).toBeInTheDocument()
    expect(screen.queryByText(/^Bank/)).not.toBeInTheDocument()
  })
})

describe('bill header', () => {
  it('leads with the open bill: its state, closing and due dates and countdown', async () => {
    await renderPage()

    const header = await screen.findByRole('region', { name: 'October bill' })
    expect(within(header).getByText('Open')).toBeInTheDocument()
    expect(within(header).getByText('Closes Wed, 9/30')).toBeInTheDocument()
    expect(within(header).getByText('Due Sat, 10/10')).toBeInTheDocument()
    expect(within(header).getByText('Due in 32 days')).toBeInTheDocument()
    expect(within(header).getByText('Securo estimate')).toBeInTheDocument()
    // The statement navigation follows the bill it selects.
    const nav = screen.getByRole('navigation', { name: 'Bills' })
    expect(header.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(nav).getByTitle('Previous cycle')).toBeInTheDocument()
  })

  it('marks a paid statement as paid, with nothing left to pay or count down', async () => {
    api.accounts.creditCardTimeline.mockResolvedValue(statementTimeline({
      source: 'bank', closing_date: '2026-08-30', due_date: '2026-09-10', amount: 512, status: 'paid',
    }))
    renderWithProviders(<AccountDetailPage />, { route: '/accounts/acc-1', path: '/accounts/:id' })

    const header = await screen.findByRole('region', { name: 'September bill' })
    expect(await within(header).findByText('Paid')).toBeInTheDocument()
    expect(within(header).getByText('Closed Sun, 8/30')).toBeInTheDocument()
    expect(within(header).getByText('Due Thu, 9/10')).toBeInTheDocument()
    expect(within(header).queryByText(/Due in/)).not.toBeInTheDocument()
    expect(within(header).queryByRole('button', { name: 'Pay bill' })).not.toBeInTheDocument()
  })

  it('pays the bill with a transfer into this card, prefilled with the total', async () => {
    const checking = { id: 'chk-1', name: 'Checking', type: 'checking', currency: 'BRL', balance: 1000, is_active: true }
    api.accounts.list.mockResolvedValue([account, checking])
    api.accounts.summary.mockResolvedValue({
      monthly_income: 0, monthly_expenses: 0, projected_income: 0, projected_expenses: 720,
    })
    const { user } = await renderPage()

    await user.click(await screen.findByRole('button', { name: 'Pay bill' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByDisplayValue('720')).toBeInTheDocument()
    const [from, to] = within(dialog).getAllByRole('combobox')
    expect(from).toHaveValue('chk-1')
    expect(to).toHaveValue('acc-1')
    expect(to).toBeDisabled()
  })

  it('extends the strip past the selected bill to the next ones already committed', async () => {
    const projection = (dueMonth: string, closing: string, amount: number) => ({
      account_id: 'acc-1', due_month: dueMonth, kind: 'projection',
      cycle_key: `cycle:${closing}`, start: closing, end: closing,
      closing_date: closing, due_date: `${dueMonth}-10`, amount,
      primary_amount: null, source: null, record_id: null, status: null,
      editable: false, unavailable_reason: null,
    })
    api.accounts.creditCardTimeline.mockResolvedValue([{
      ...timeline[0],
      items: [
        ...timeline[0].items,
        projection('2026-11', '2026-10-30', 400),
        projection('2026-12', '2026-11-30', 300),
        projection('2027-01', '2026-12-30', 200),
        projection('2027-02', '2027-01-30', 100),
      ],
    }])
    await renderPage()

    const nav = screen.getByRole('navigation', { name: 'Bills' })
    // Six cells: the two bills before the selected one, the selected one
    // and the next three.
    expect(await within(nav).findByRole('button', { name: /Jan 2027/ })).toBeInTheDocument()
    expect(within(nav).getByRole('button', { name: /Apr 2026/ })).toBeInTheDocument()
    expect(within(nav).getByRole('button', { name: /Nov 2026.*R\$400\.00/ })).toBeInTheDocument()
    expect(within(nav).queryByRole('button', { name: /Feb 2027/ })).not.toBeInTheDocument()
  })
})

describe('card limit', () => {
  it('shows the card\'s current use on every bill, and the selected bill\'s share beside it', async () => {
    api.accounts.get.mockResolvedValue({ ...account, available_credit: 3200 })
    api.accounts.summary.mockResolvedValue({
      monthly_income: 0, monthly_expenses: 0, projected_income: 0, projected_expenses: 720,
    })
    const { user } = await renderPage()

    const card = screen.getByRole('region', { name: 'Credit limit' })
    // (5000 − 3200) ÷ 5000, not the open bill's 720 ÷ 5000.
    expect(await within(card).findByRole('progressbar', { name: 'Utilization' })).toHaveAttribute('aria-valuenow', '36')
    expect(within(card).getByText('Used R$1,800.00 of R$5,000.00')).toBeInTheDocument()
    expect(within(card).getByText('R$3,200.00')).toBeInTheDocument()
    expect(await within(card).findByText('This bill: 14% of the limit')).toBeInTheDocument()

    await user.click(screen.getByTitle('Previous cycle'))

    // The May bank statement (280) is now the selected bill; the card's use
    // has not moved.
    expect(await within(card).findByText('This bill: 6% of the limit')).toBeInTheDocument()
    expect(within(card).getByRole('progressbar', { name: 'Utilization' })).toHaveAttribute('aria-valuenow', '36')
    expect(within(card).getByText('Used R$1,800.00 of R$5,000.00')).toBeInTheDocument()
  })

  it('falls back to the card balance when the bank reports no available credit, and says so', async () => {
    api.accounts.get.mockResolvedValue({ ...account, current_balance: -1000, available_credit: null })
    await renderPage()

    const card = screen.getByRole('region', { name: 'Credit limit' })
    expect(await within(card).findByRole('progressbar', { name: 'Utilization' })).toHaveAttribute('aria-valuenow', '20')
    expect(within(card).getByText('Used R$1,000.00 of R$5,000.00')).toBeInTheDocument()
    expect(within(card).getByText(/Estimated from the card balance/)).toBeInTheDocument()
  })
})

function category(overrides: Partial<Category>): Category {
  return {
    id: 'cat-1', user_id: 'user-1', group_id: null, name: 'Shopping', icon: 'tag',
    color: '#000000', is_system: false, is_hidden: false, treat_as_transfer: false,
    is_ignored: false, ...overrides,
  }
}

function cardTx(id: string, overrides: Partial<Transaction>): Transaction {
  return {
    id, user_id: 'user-1', account_id: 'acc-1', category_id: null, category: null,
    external_id: null, description: id, original_description: null, amount: 0,
    currency: 'BRL', date: '2026-09-01', type: 'debit', source: 'manual', status: 'posted',
    payee: null, payee_id: null, payee_name: null, notes: null, transfer_pair_id: null,
    amount_primary: null, fx_rate_used: null, fx_fallback: false, installment_number: null,
    total_installments: null, installment_total_amount: null, installment_purchase_date: null,
    installment_series_id: null, bill_id: null, effective_bill_date: null, splits: [],
    is_ignored: false, ...overrides,
  }
}

describe('one bill total per statement', () => {
  it('ends the running total, the strip and the card on the same bill total', async () => {
    // A purchase, a refund, a card payment nobody paired (filed under a
    // transfer category) and an installment the bank has not sent yet. The
    // bill counts all but the payment: 300 - 50 + 720 = 970.
    api.transactions.list.mockResolvedValue({
      items: [
        cardTx('Card payment', {
          date: '2026-09-07', type: 'credit', amount: 1000,
          category: category({ id: 'cat-pay', name: 'Transfers', treat_as_transfer: true }),
        }),
        cardTx('Refund', { date: '2026-09-03', type: 'credit', amount: 50, category: category({}) }),
        cardTx('Market', { date: '2026-09-02', type: 'debit', amount: 300, category: category({}) }),
      ],
      total: 3,
    })
    api.accounts.installmentForecasts.mockResolvedValue([{
      key: 'tx-1:7', description: 'THIAGO PEREIRA', amount: 720, currency: 'BRL', type: 'debit',
      purchase_date: '2026-05-06', due_date: '2026-10-10', installment_number: 7,
      total_installments: 10, category_id: null, card_last4: '9984',
    }])
    api.accounts.summary.mockResolvedValue({
      monthly_income: 0, monthly_expenses: 250, projected_income: 0, projected_expenses: 970,
    })
    // The timeline still carries an older figure for the open cycle.
    api.accounts.creditCardTimeline.mockResolvedValue([{
      ...timeline[0],
      items: timeline[0].items.map((item) =>
        item.cycle_key === 'cycle:2026-09-30' ? { ...item, amount: 1234 } : item),
    }])

    await renderPage()
    await screen.findByText('THIAGO PEREIRA')

    // The newest row is the payment; the bill leaves it out, so the running
    // total stays on what the rows before it add up to.
    const newest = screen.getByText('Card payment').closest('tr')!
    await waitFor(() => expect(newest.querySelectorAll('td')[4].textContent).toBe('R$970.00'))
    const stripSlot = screen.getAllByRole('button', { name: /Oct 2026/ }).find((b) => b !== cycleHeader())!
    expect(stripSlot.textContent).toContain('R$970.00')
    expect(screen.queryByText(/1,234\.00/)).not.toBeInTheDocument()
    // Purchases and credits side by side under the total.
    const composition = screen.getByText('Credits').closest('dl')!
    expect(composition.textContent).toContain('PurchasesR$1,020.00')
    expect(composition.textContent).toContain('-R$50.00')
    expect(screen.queryByText(/not in this list/)).not.toBeInTheDocument()
  })

  it('names what the listed rows do not explain, so the views still end on the total', async () => {
    api.transactions.list.mockResolvedValue({
      items: [cardTx('Market', { date: '2026-09-02', type: 'debit', amount: 300 })],
      total: 1,
    })
    api.accounts.summary.mockResolvedValue({
      monthly_income: 0, monthly_expenses: 300, projected_income: 0, projected_expenses: 250,
    })

    await renderPage()

    expect(await screen.findByText('Payments and adjustments not in this list: -R$50.00')).toBeInTheDocument()
    expect(screen.getByText('The last day includes -R$50.00 in payments and adjustments')).toBeInTheDocument()
  })

  it('shows a statement with more credits than charges as a credit balance', async () => {
    api.accounts.creditCardTimeline.mockResolvedValue(statementTimeline({
      source: 'manual', closing_date: '2026-08-30', due_date: '2026-09-10', amount: -150,
    }))
    renderWithProviders(<AccountDetailPage />, { route: '/accounts/acc-1', path: '/accounts/:id' })

    // Once in the card's title, once under the strip's amount.
    await waitFor(() => expect(screen.getAllByText('Credit balance')).toHaveLength(2))
    expect(screen.queryByText('Bill total')).not.toBeInTheDocument()
    expect(screen.getAllByText('R$150.00').length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByText(/-R\$150/)).not.toBeInTheDocument()
  })
})

describe('months without a statement', () => {
  const missing = (overrides: Record<string, unknown>) => ({
    account_id: 'acc-1', kind: 'unavailable', closing_date: null, amount: null,
    primary_amount: null, source: null, record_id: null, status: null, editable: false,
    ...overrides,
  })
  const bill = (id: string, dates: { start: string; end: string; closing_date: string; due_date: string }, amount: number) => ({
    account_id: 'acc-1', due_month: dates.due_date.slice(0, 7), kind: 'statement',
    cycle_key: `bill:${id}`, ...dates, amount, primary_amount: null, source: 'bank',
    record_id: id, status: 'paid', editable: false, unavailable_reason: null,
  })

  beforeEach(() => {
    api.accounts.get.mockResolvedValue({ ...account, connection_id: 'conn-1' })
    api.connections.list.mockResolvedValue([{ id: 'conn-1', last_sync_at: null }])
    api.accounts.creditCardTimeline.mockResolvedValue([{
      account_id: 'acc-1',
      default_key: 'bill:bill-sep',
      items: [
        // Before the card's history begins: not shown at all.
        missing({ due_month: '2026-05', cycle_key: 'cycle:2026-04-30', start: '2026-03-30', end: '2026-04-29', due_date: '2026-05-10', unavailable_reason: 'past_statement_missing' }),
        bill('bill-jun', { start: '2026-04-30', end: '2026-05-29', closing_date: '2026-05-30', due_date: '2026-06-10' }, 200),
        missing({ due_month: '2026-07', cycle_key: 'cycle:2026-06-30', start: '2026-05-30', end: '2026-06-29', closing_date: '2026-06-30', due_date: '2026-07-10', unavailable_reason: 'past_statement_missing' }),
        missing({ due_month: '2026-08', cycle_key: null, start: null, end: null, due_date: null, unavailable_reason: 'missing_close_config' }),
        bill('bill-sep', { start: '2026-07-30', end: '2026-08-29', closing_date: '2026-08-30', due_date: '2026-09-10' }, 500),
      ],
    }])
  })

  async function renderStatementPage() {
    const rendered = renderWithProviders(<AccountDetailPage />, { route: '/accounts/acc-1', path: '/accounts/:id' })
    await waitFor(() => expect(txCalls().at(-1)?.cycle_key).toBe('bill:bill-sep'))
    return rendered
  }

  it('keeps each missing month in the strip as a labelled slot, never as R$0', async () => {
    await renderStatementPage()

    const bankMissing = (await screen.findByText("Bank didn't send")).parentElement!
    expect(bankMissing.tagName).toBe('BUTTON')
    expect(within(bankMissing).queryByText(/R\$/)).not.toBeInTheDocument()
    // Its name says the state, not just the month.
    expect(bankMissing).toHaveAccessibleName("Jul 2026, Bank didn't send")
    // A month Securo cannot even place in a cycle is shown but not selectable.
    const noBill = screen.getByText('No bill').parentElement!
    expect(noBill.tagName).toBe('DIV')
    expect(within(noBill).queryByText(/R\$/)).not.toBeInTheDocument()
    expect(screen.queryByText(/May 2026/)).not.toBeInTheDocument()
  })

  it('steps over a month with no cycle and onto one the bank did not send, as an estimate', async () => {
    const { user } = await renderStatementPage()
    const previous = await screen.findByTitle('Previous cycle')

    await user.click(previous)
    await waitFor(() => expect(txCalls().at(-1)!.cycle_key).toBe('cycle:2026-06-30'))
    expect(await screen.findByText('Securo estimate')).toBeInTheDocument()
    expect(screen.queryByText(/^Bank ·/)).not.toBeInTheDocument()

    await user.click(previous)
    await waitFor(() => expect(txCalls().at(-1)!.cycle_key).toBe('bill:bill-jun'))
    expect(previous).toBeDisabled()
  })
})

describe('keyboard and screen reader access', () => {
  const forecast = {
    key: 'tx-1:7', description: 'THIAGO PEREIRA', amount: 720, currency: 'BRL', type: 'debit',
    purchase_date: '2026-05-06', due_date: '2026-10-10', installment_number: 7,
    total_installments: 10, category_id: null, card_last4: '9984',
  }

  it('opens a transaction from the keyboard and keeps forecast rows out of the tab order', async () => {
    api.transactions.list.mockResolvedValue({
      items: [cardTx('Market', { date: '2026-09-02', type: 'debit', amount: 300 })],
      total: 1,
    })
    api.accounts.installmentForecasts.mockResolvedValue([forecast])
    const { user } = await renderPage()

    await screen.findByText('THIAGO PEREIRA')
    expect(screen.getByText('THIAGO PEREIRA').closest('tr')).not.toHaveAttribute('tabindex')

    const row = screen.getByRole('row', { name: 'Edit Market, 9/2/2026, -R$300.00' })
    row.focus()
    await user.keyboard('{Enter}')

    expect(await screen.findByRole('dialog', { name: 'Editing Market' })).toBeInTheDocument()
  })

  it('marks the selected bill in the strip and names each cell by month and amount', async () => {
    const { user } = await renderPage()

    const nav = screen.getByRole('navigation', { name: 'Bills' })
    const selected = await within(nav).findByRole('button', { name: /^Oct 2026, / })
    await waitFor(() => expect(selected).toHaveAttribute('aria-current', 'true'))
    const may = within(nav).getByRole('button', { name: 'May 2026, R$280.00' })
    expect(may).not.toHaveAttribute('aria-current')

    await user.click(within(nav).getByRole('button', { name: 'Previous cycle' }))

    await waitFor(() => expect(within(nav).getByRole('button', { name: 'May 2026, R$280.00' })).toHaveAttribute('aria-current', 'true'))
    expect(within(nav).getByRole('button', { name: /^Oct 2026, / })).not.toHaveAttribute('aria-current')
  })

  it('opens a row\'s help on a click or tap without opening the row', async () => {
    api.transactions.list.mockResolvedValue({
      items: [cardTx('Sofa', {
        date: '2026-09-02', type: 'debit', amount: 100,
        installment_number: 3, total_installments: 10, installment_total_amount: 1000,
      })],
      total: 1,
    })
    const { user } = await renderPage()

    await user.click(await screen.findByRole('button', { name: 'Installment 3 of 10' }))

    // The help popover is the only dialog: the row's edit dialog stays shut.
    const help = await screen.findByRole('dialog')
    expect(help).toHaveTextContent('Installment plan — 10 charges totaling R$1,000.00')
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
  })
})
