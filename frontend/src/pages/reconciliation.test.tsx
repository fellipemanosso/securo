/**
 * Conciliações: the page opens on what needs a decision, says so plainly
 * when nothing does, the pending badge follows an accept or a decline, and
 * links minted for the old Rules tabs land here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { Route, Routes, useLocation } from 'react-router-dom'

import ReconciliationPage from '@/pages/reconciliation'
import RulesPage from '@/pages/rules'
import { NavCountBadge } from '@/components/nav-count-badge'
import { usePendingReconciliationCount } from '@/hooks/use-pending-reconciliation-count'
import { renderWithProviders, t } from '@/test/utils'
import type { ReconciliationHistoryEvent, ReconciliationSuggestion } from '@/types'

const api = vi.hoisted(() => ({
  reconciliation: {
    suggestions: vi.fn(),
    suggestionCount: vi.fn(),
    accept: vi.fn(),
    decline: vi.fn(),
    history: vi.fn(),
  },
  accounts: { list: vi.fn() },
  transactions: { get: vi.fn() },
  invoices: { get: vi.fn() },
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

function suggestion(id: string, description: string, label: string): ReconciliationSuggestion {
  return {
    id,
    node: 'reconciliation.match_recurring',
    strategy_id: 'same_account_exact',
    expectation_kind: 'recurring',
    expectation_id: `bill-${id}`,
    expectation_label: label,
    amount: '89.90',
    scores: { amount_exact: true, currency: 'BRL' },
    status: 'pending',
    created_at: '2026-11-10T12:00:00Z',
    covers: [{ expectation_kind: 'recurring', expectation_id: `bill-${id}`, label, amount: '89.90' }],
    transaction: {
      id: `tx-${id}`,
      description,
      amount: '-89.90',
      currency: 'BRL',
      date: '2026-11-10',
      type: 'debit',
      account_id: null,
    },
  }
}

const internet = suggestion('s1', 'VIVO FIBRA', 'Internet')
const gym = suggestion('s2', 'SMARTFIT', 'Academia')

/** The sidebar link's badge, reading the same query the layout reads. */
function SidebarBadge() {
  const { data } = usePendingReconciliationCount()
  return (
    <div data-testid="sidebar">
      <NavCountBadge count={data} />
    </div>
  )
}

function LocationProbe() {
  const location = useLocation()
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>
}

beforeEach(() => {
  vi.clearAllMocks()
  api.accounts.list.mockResolvedValue([])
  api.reconciliation.history.mockResolvedValue([])
})

describe('Conciliações page', () => {
  it('opens on the pending questions with their count', async () => {
    api.reconciliation.suggestions.mockResolvedValue([internet, gym])
    api.reconciliation.suggestionCount.mockResolvedValue(2)

    renderWithProviders(<ReconciliationPage />, { route: '/reconciliation' })

    expect(await screen.findByText('VIVO FIBRA')).toBeInTheDocument()
    expect(screen.getByText('SMARTFIT')).toBeInTheDocument()
    const pendingTab = screen.getByTestId('reconciliation-tab-pending')
    await waitFor(() => expect(within(pendingTab).getByTestId('nav-count-badge')).toHaveTextContent('2'))
    expect(screen.getAllByRole('button', { name: t('reconciliation.queue.accept') })).toHaveLength(2)
  })

  it('says nothing is pending rather than showing an empty list', async () => {
    api.reconciliation.suggestions.mockResolvedValue([])
    api.reconciliation.suggestionCount.mockResolvedValue(0)

    renderWithProviders(<ReconciliationPage />, { route: '/reconciliation' })

    expect(await screen.findByText(t('reconciliation.queue.emptyTitle'))).toBeInTheDocument()
    expect(screen.queryByTestId('nav-count-badge')).not.toBeInTheDocument()
  })

  it('offers a retry when the queue cannot be loaded', async () => {
    api.reconciliation.suggestions.mockRejectedValue(new Error('offline'))
    api.reconciliation.suggestionCount.mockResolvedValue(0)

    renderWithProviders(<ReconciliationPage />, { route: '/reconciliation' })

    expect(await screen.findByText(t('reconciliation.queue.error'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('common.retry') })).toBeInTheDocument()
  })

  it('keeps the history one tab away, addressable by URL', async () => {
    const event: ReconciliationHistoryEvent = {
      id: 'e1',
      at: '2026-11-09T10:00:00Z',
      action: 'linked',
      expectation_kind: 'recurring',
      expectation_id: 'bill-x',
      expectation_label: 'Aluguel',
      amount: '1500.00',
      currency: 'BRL',
      user_id: null,
    }
    api.reconciliation.history.mockResolvedValue([event])
    api.reconciliation.suggestions.mockResolvedValue([internet])
    api.reconciliation.suggestionCount.mockResolvedValue(1)

    const { user } = renderWithProviders(
      <>
        <ReconciliationPage />
        <LocationProbe />
      </>,
      { route: '/reconciliation' },
    )

    await screen.findByText('VIVO FIBRA')
    await user.click(screen.getByTestId('reconciliation-tab-history'))

    expect(await screen.findByText(t('reconciliation.history.title'))).toBeInTheDocument()
    expect(screen.getByText(/Aluguel/)).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('/reconciliation?tab=history')
    expect(screen.queryByText('VIVO FIBRA')).not.toBeInTheDocument()
  })
})

describe('pending badge', () => {
  it('drops by one after an accept and after a decline', async () => {
    let open = [internet, gym]
    api.reconciliation.suggestions.mockImplementation(async () => open)
    api.reconciliation.suggestionCount.mockImplementation(async () => open.length)
    const answer = async (id: string) => {
      const answered = open.find((s) => s.id === id)!
      open = open.filter((s) => s.id !== id)
      return answered
    }
    api.reconciliation.accept.mockImplementation(answer)
    api.reconciliation.decline.mockImplementation(answer)

    const { user } = renderWithProviders(
      <>
        <SidebarBadge />
        <ReconciliationPage />
      </>,
      { route: '/reconciliation' },
    )

    const sidebar = await screen.findByTestId('sidebar')
    await waitFor(() => expect(within(sidebar).getByTestId('nav-count-badge')).toHaveTextContent('2'))

    await screen.findByText('VIVO FIBRA')
    await user.click(screen.getAllByRole('button', { name: t('reconciliation.queue.accept') })[0])

    expect(api.reconciliation.accept).toHaveBeenCalledWith('s1')
    await waitFor(() => expect(within(sidebar).getByTestId('nav-count-badge')).toHaveTextContent('1'))
    await waitFor(() => expect(screen.queryByText('VIVO FIBRA')).not.toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: t('reconciliation.queue.declineHint') }))

    expect(api.reconciliation.decline).toHaveBeenCalledWith('s2')
    await waitFor(() => expect(within(sidebar).queryByTestId('nav-count-badge')).not.toBeInTheDocument())
    expect(await screen.findByText(t('reconciliation.queue.emptyTitle'))).toBeInTheDocument()
  })
})

describe('old Rules links', () => {
  function renderRules(route: string) {
    return renderWithProviders(
      <Routes>
        <Route path="/rules" element={<RulesPage />} />
        <Route path="/reconciliation" element={<LocationProbe />} />
      </Routes>,
      { route },
    )
  }

  it('sends the queue tab to Conciliações', async () => {
    renderRules('/rules?tab=queue')
    expect(await screen.findByTestId('location')).toHaveTextContent(/^\/reconciliation$/)
  })

  it('sends the history tab to the history on Conciliações', async () => {
    renderRules('/rules?tab=history')
    expect(await screen.findByTestId('location')).toHaveTextContent('/reconciliation?tab=history')
  })
})
