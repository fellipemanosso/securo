/**
 * The Investimentos page: totals that only count what has a value, warnings
 * naming what was left out, positions grouped by class that open on
 * Patrimônio, and an empty state that points to connecting or importing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'

import InvestmentsPage from '@/pages/investments'
import { formatCurrency } from '@/lib/format'
import { makeAsset, makeWallet } from '@/test/asset-fixture'
import { renderWithProviders, t } from '@/test/utils'

const api = vi.hoisted(() => ({
  assets: { list: vi.fn(), portfolioTrend: vi.fn() },
  assetGroups: { list: vi.fn() },
}))
vi.mock('@/lib/api', () => api)

const mobile = vi.hoisted(() => ({ value: false }))
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mobile.value }))

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

const money = (value: number, currency = 'BRL') => formatCurrency(value, currency, 'en-US')

const wallets = [
  makeWallet('w-bank', 'Banco X', { source: 'pluggy', institution_name: 'Banco X' }),
  makeWallet('w-broker', 'Corretora'),
]

const portfolio = [
  makeAsset({
    id: 'cdb', name: 'CDB Banco X', investment_class: 'fixed_income', source: 'pluggy', group_id: 'w-bank',
    current_value: 1500, purchase_price: 1350, gain_loss: 150, value_count: 3, value_as_of: '2026-11-16',
  }),
  makeAsset({
    id: 'petr', name: 'Petrobras', ticker: 'PETR4.SA', type: 'stock', investment_class: 'stocks', group_id: 'w-broker',
    valuation_method: 'market_price', units: 10, last_price: 50, current_value: 500, purchase_price: 450,
    total_invested: 450, average_price: 45, gain_loss: 50, value_count: 2, value_as_of: '2026-11-17',
  }),
  makeAsset({
    id: 'eur-fund', name: 'Fundo Europa', type: 'fund', investment_class: 'funds', currency: 'EUR',
    current_value: 200, gain_loss: 20, purchase_price: 180,
  }),
  makeAsset({ id: 'no-price', name: 'Fundo sem cota', type: 'fund', investment_class: 'funds', current_value: null, value_as_of: null }),
  makeAsset({ id: 'house', name: 'Casa', type: 'real_estate', investment_class: null, current_value: 300000 }),
]

beforeEach(() => {
  vi.clearAllMocks()
  mobile.value = false
  api.assets.list.mockResolvedValue(portfolio)
  api.assetGroups.list.mockResolvedValue(wallets)
  api.assets.portfolioTrend.mockResolvedValue({ assets: [], trend: [], total: 0 })
})

describe('InvestmentsPage', () => {
  it('totals the positions with a value and says what it left out', async () => {
    renderWithProviders(<InvestmentsPage />, { route: '/investments' })

    // 1500 + 500; the EUR fund (no FX rate) and the fund with no price are out.
    expect(await screen.findByTestId('investments-total')).toHaveTextContent(money(2000))
    expect(screen.getByText(t('investments.summary.valueHint', { count: 2 }))).toBeInTheDocument()
    expect(screen.getByTestId('investments-cost')).toHaveTextContent(money(1800))
    expect(screen.getByTestId('investments-return')).toHaveTextContent(`+${money(200)}`)
    expect(screen.getByTestId('investments-return')).toHaveTextContent('+11.1%')

    expect(screen.getByText(t('investments.warnings.noPrice', { names: 'Fundo sem cota' }))).toBeInTheDocument()
    expect(screen.getByText(t('investments.warnings.noFx', { currency: 'EUR', primary: 'BRL', amount: money(200, 'EUR') }))).toBeInTheDocument()

    const provenance = screen.getByTestId('investments-provenance')
    expect(provenance).toHaveTextContent(t('investments.provenance.synced', { count: 1 }))
    expect(provenance).toHaveTextContent(t('investments.provenance.manual', { count: 3 }))
  })

  it('allocates by class and by wallet, each adding up to the total', async () => {
    renderWithProviders(<InvestmentsPage />, { route: '/investments' })

    const byClass = await screen.findByTestId('investments-by-class')
    const classRows = within(byClass).getAllByRole('listitem').map((row) => row.textContent)
    expect(classRows).toEqual([
      `${t('investments.class.fixed_income')}${money(1500)}75.0%`,
      `${t('investments.class.stocks')}${money(500)}25.0%`,
      `${t('investments.class.funds')}${money(0)}0.0%`,
    ])

    const byWallet = screen.getByTestId('investments-by-wallet')
    const walletRows = within(byWallet).getAllByRole('listitem').map((row) => row.textContent)
    expect(walletRows).toEqual([
      `Banco X${money(1500)}75.0%`,
      `Corretora${money(500)}25.0%`,
      `${t('investments.allocation.noWallet')}${money(0)}0.0%`,
    ])
  })

  it('lists positions grouped by class, each opening on Patrimônio', async () => {
    renderWithProviders(<InvestmentsPage />, { route: '/investments' })

    const stocks = await screen.findByTestId('investments-class-stocks')
    const link = within(stocks).getByRole('link', { name: t('investments.positions.open', { name: 'PETR4.SA', page: t('nav.assets') }) })
    expect(link).toHaveAttribute('href', '/assets?asset=petr')
    const row = link.closest('tr')!
    expect(row).toHaveTextContent('Corretora')
    expect(row).toHaveTextContent(money(50))
    expect(row).toHaveTextContent(t('investments.positions.avgPrice', { price: money(45) }))
    expect(row).toHaveTextContent('+11.1%')
    expect(row).toHaveTextContent('25.0%')

    const funds = screen.getByTestId('investments-class-funds')
    expect(within(funds).getByText(t('investments.positions.noPrice'))).toBeInTheDocument()
    expect(within(funds).getByText(t('investments.positions.noFx'))).toBeInTheDocument()
    // Not an investment: stays on Patrimônio only.
    expect(screen.queryByText('Casa')).not.toBeInTheDocument()
  })

  it('shows positions as cards on a phone', async () => {
    mobile.value = true
    renderWithProviders(<InvestmentsPage />, { route: '/investments' })

    const card = await screen.findByRole('link', { name: t('investments.positions.open', { name: 'CDB Banco X', page: t('nav.assets') }) })
    expect(card).toHaveAttribute('href', '/assets?asset=cdb')
    expect(card).toHaveTextContent('Banco X')
    expect(card).toHaveTextContent(money(1500))
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('draws the value over time only when there are at least two dates', async () => {
    api.assets.portfolioTrend.mockResolvedValue({
      assets: [{ id: 'cdb', name: 'CDB', type: 'investment', group_id: 'w-bank' }],
      trend: [{ date: '2026-10-01', cdb: 1400, _total: 1400 }, { date: '2026-11-01', cdb: 1500, _total: 1500 }],
      total: 1500,
    })
    renderWithProviders(<InvestmentsPage />, { route: '/investments' })
    expect(await screen.findByRole('heading', { name: t('investments.evolution.title') })).toBeInTheDocument()
  })

  it('omits the chart without history', async () => {
    renderWithProviders(<InvestmentsPage />, { route: '/investments' })
    await screen.findByTestId('investments-total')
    expect(screen.queryByRole('heading', { name: t('investments.evolution.title') })).not.toBeInTheDocument()
  })

  it('points to connecting or importing when there are no investments', async () => {
    api.assets.list.mockResolvedValue([portfolio[4]])
    renderWithProviders(<InvestmentsPage />, { route: '/investments' })

    expect(await screen.findByRole('heading', { name: t('investments.empty.title') })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: t('investments.empty.connect') })).toHaveAttribute('href', '/connections')
    expect(screen.getByRole('link', { name: t('investments.empty.import') })).toHaveAttribute('href', '/import?tab=investments')
    expect(screen.getByRole('link', { name: t('investments.empty.add', { page: t('nav.assets') }) })).toHaveAttribute('href', '/assets')
    expect(screen.queryByTestId('investments-total')).not.toBeInTheDocument()
  })

  it('offers a retry when the assets fail to load', async () => {
    api.assets.list.mockRejectedValueOnce(new Error('boom'))
    const { user } = renderWithProviders(<InvestmentsPage />, { route: '/investments' })

    expect(await screen.findByRole('alert')).toHaveTextContent(t('investments.error'))
    await user.click(screen.getByRole('button', { name: t('common.retry') }))
    await waitFor(() => expect(screen.getByTestId('investments-total')).toHaveTextContent(money(2000)))
  })
})
