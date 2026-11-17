/**
 * Per-card controls on a credit-card account: a card can be renamed or hidden,
 * and hiding one makes every statement query leave its purchases out.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

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
    installmentForecasts: vi.fn(async () => []),
    updateCard: vi.fn(),
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

const account = {
  id: 'acc-1',
  name: 'Card',
  display_name: null,
  type: 'credit_card',
  currency: 'BRL',
  balance: -280,
  is_active: true,
  credit_limit: 5000,
  statement_close_day: 30,
  payment_due_day: 10,
}

const card = (last4: string, alias: string | null, is_hidden = false) => ({
  last4, alias, is_hidden, transaction_count: 4, first_date: '2026-01-01', last_date: '2026-09-01',
})

let cardState = [card('1876', 'Wife'), card('0339', null)]

beforeEach(() => {
  vi.clearAllMocks()
  cardState = [card('1876', 'Wife'), card('0339', null)]
  api.accounts.get.mockResolvedValue(account)
  api.accounts.creditCardTimeline.mockResolvedValue([])
  api.accounts.list.mockResolvedValue([account])
  api.accounts.update.mockImplementation(async (_id: string, payload: Record<string, unknown>) => ({
    ...account,
    ...payload,
  }))
  api.accounts.cards.mockImplementation(async () => cardState)
  api.accounts.updateCard.mockImplementation(async (_id: string, last4: string, payload: { alias?: string | null; is_hidden?: boolean }) => {
    cardState = cardState.map((c) => (c.last4 === last4 ? { ...c, ...payload } : c))
    return cardState.find((c) => c.last4 === last4)
  })
  api.accounts.summary.mockResolvedValue({
    monthly_income: 0, monthly_expenses: 0, projected_income: 0, projected_expenses: 0,
  })
  api.transactions.list.mockResolvedValue({ items: [], total: 0 })
  api.dashboard.projectedTransactions.mockResolvedValue([])
  api.categories.list.mockResolvedValue([])
  api.categoryGroups.list.mockResolvedValue([])
})

async function openCardsPopover() {
  const user = userEvent.setup()
  renderWithProviders(<AccountDetailPage />, { route: '/accounts/acc-1', path: '/accounts/:id' })
  await user.click(await screen.findByRole('button', { name: /Cards \(2\)/ }))
  return user
}

describe('credit card cards control', () => {
  it('lists each card by alias or last digits with its transaction count', async () => {
    await openCardsPopover()

    expect(await screen.findByText('Wife')).toBeInTheDocument()
    expect(screen.getByText('•••• 0339')).toBeInTheDocument()
    expect(screen.getAllByText('4 tx')).toHaveLength(2)
  })

  it('hides a card and reloads the statement, which the server then serves without it', async () => {
    const user = await openCardsPopover()
    await screen.findByText('Wife')
    const listCalls = api.transactions.list.mock.calls.length
    const summaryCalls = api.accounts.summary.mock.calls.length

    await user.click(screen.getAllByRole('button', { name: 'Hide card' })[0])

    await waitFor(() => expect(api.accounts.updateCard).toHaveBeenCalledWith('acc-1', '1876', { is_hidden: true }))
    await waitFor(() => {
      expect(api.transactions.list.mock.calls.length).toBeGreaterThan(listCalls)
      expect(api.accounts.summary.mock.calls.length).toBeGreaterThan(summaryCalls)
    })
    expect(await screen.findByText(/Hidden cards \(1\)/)).toBeInTheDocument()
  })

  it('renames a card with an empty or filled alias', async () => {
    const user = await openCardsPopover()
    await screen.findByText('Wife')

    await user.click(screen.getAllByRole('button', { name: 'Rename card' })[1])
    await user.type(screen.getByLabelText('Card name'), 'Travel{Enter}')

    await waitFor(() => expect(api.accounts.updateCard).toHaveBeenCalledWith('acc-1', '0339', { alias: 'Travel' }))
  })
  it('renames the principal card from its detail header', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AccountDetailPage />, { route: '/accounts/acc-1', path: '/accounts/:id' })

    await user.click(await screen.findByRole('button', { name: 'Display name' }))
    await user.type(screen.getByRole('textbox', { name: 'Display name' }), 'Travel')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(api.accounts.update).toHaveBeenCalledExactlyOnceWith('acc-1', { display_name: 'Travel' })
    })
    expect(await screen.findByRole('heading', { name: 'Travel' })).toBeInTheDocument()
  })
})

