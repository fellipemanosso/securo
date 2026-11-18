/**
 * Investimentos opens a position on Patrimônio with `/assets?asset=<id>`:
 * that holding starts expanded (its detail loads) and nothing else does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'

import AssetsPage from '@/pages/assets'
import { makeAsset, makeWallet } from '@/test/asset-fixture'
import { renderWithProviders } from '@/test/utils'

const api = vi.hoisted(() => ({
  assets: {
    list: vi.fn(),
    portfolioTrend: vi.fn(),
    values: vi.fn(),
    valueTrend: vi.fn(),
    transactions: vi.fn(),
    allTransactions: vi.fn(),
  },
  assetGroups: { list: vi.fn() },
  accounts: { list: vi.fn() },
  currencies: { list: vi.fn() },
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

beforeEach(() => {
  vi.clearAllMocks()
  api.assets.list.mockResolvedValue([
    makeAsset({ id: 'cdb', name: 'CDB Banco X', group_id: 'w-bank', current_value: 1000, purchase_price: 900 }),
    makeAsset({ id: 'lci', name: 'LCI Banco X', group_id: 'w-bank', current_value: 500, purchase_price: 480 }),
  ])
  api.assets.portfolioTrend.mockResolvedValue({ assets: [], trend: [], total: 0 })
  api.assets.values.mockResolvedValue([])
  api.assets.valueTrend.mockResolvedValue([])
  api.assets.transactions.mockResolvedValue([])
  api.assets.allTransactions.mockResolvedValue([])
  api.assetGroups.list.mockResolvedValue([makeWallet('w-bank', 'Banco X')])
  api.accounts.list.mockResolvedValue([])
  api.currencies.list.mockResolvedValue([])
})

describe('AssetsPage ?asset= link', () => {
  it('opens the linked holding expanded', async () => {
    renderWithProviders(<AssetsPage />, { route: '/assets?asset=cdb' })

    await screen.findByText('CDB Banco X')
    await waitFor(() => expect(api.assets.values).toHaveBeenCalledWith('cdb'))
    expect(api.assets.values).not.toHaveBeenCalledWith('lci')
  })

  it('opens nothing without the link', async () => {
    renderWithProviders(<AssetsPage />, { route: '/assets' })

    await screen.findByText('CDB Banco X')
    expect(api.assets.values).not.toHaveBeenCalled()
  })
})
