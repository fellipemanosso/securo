import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'

import ConnectionsPage from '@/pages/connections'
import { renderWithProviders, t } from '@/test/utils'
import type { Account, BankConnection } from '@/types'

const api = vi.hoisted(() => ({
  accountsList: vi.fn(),
  connectionsList: vi.fn(),
  sync: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  accounts: { list: api.accountsList },
  connections: {
    list: api.connectionsList,
    getProviders: vi.fn().mockResolvedValue([]),
    sync: api.sync,
    delete: vi.fn(),
    getReauthUrl: vi.fn(),
  },
}))

vi.mock('@/contexts/workspace-context', () => ({
  useWorkspace: () => ({ canWrite: true }),
}))

vi.mock('@/contexts/collection-filter-context', () => ({
  useCollectionFilter: () => ({ activeAccountIds: null }),
}))

vi.mock('@/hooks/use-display-locale', () => ({
  useDisplayLocale: () => 'en',
  useDateLocale: () => 'en-US',
}))

vi.mock('@/lib/invalidate-queries', () => ({
  invalidateFinancialQueries: vi.fn(),
}))

vi.mock('@/components/bank-connect-dialog', () => ({ BankConnectDialog: () => null }))
vi.mock('@/components/connector-select-dialog', () => ({ ConnectorSelectDialog: () => null }))
vi.mock('@/components/oauth-connect-dialog', () => ({ OAuthConnectDialog: () => null }))
vi.mock('@/components/token-connect-dialog', () => ({ TokenConnectDialog: () => null }))
vi.mock('@/components/connection-settings-dialog', () => ({ ConnectionSettingsDialog: () => null }))

function makeConnection(overrides: Partial<BankConnection>): BankConnection {
  return {
    id: 'conn-1',
    user_id: 'user-1',
    provider: 'simplefin',
    institution_name: 'Institution B',
    display_name: null,
    logo_url: null,
    external_id: 'INST-B',
    status: 'active',
    settings: null,
    last_sync_at: null,
    created_at: '2026-10-01T00:00:00Z',
    institutions: [],
    ...overrides,
  }
}

function makeAccount(connectionId: string, overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1',
    user_id: 'user-1',
    connection_id: connectionId,
    external_id: 'acc-external-1',
    name: 'Healthy Checking',
    display_name: null,
    masked_number: null,
    institution_name: 'Institution B',
    institution_logo_url: null,
    type: 'checking',
    balance: 42,
    current_balance: 42,
    previous_balance: null,
    balance_primary: 42,
    currency: 'USD',
    credit_limit: null,
    available_credit: null,
    statement_close_day: null,
    payment_due_day: null,
    is_closed: false,
    ...overrides,
  } as unknown as Account
}

describe('ConnectionsPage connection row actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.accountsList.mockResolvedValue([makeAccount('conn-1')])
    api.connectionsList.mockResolvedValue([])
    api.sync.mockResolvedValue({ sync_outcome: 'success', merged_count: 0 })
  })

  it('offers a retry next to reconnect for a connection in the error state', async () => {
    api.connectionsList.mockResolvedValue([makeConnection({ id: 'conn-err', status: 'error' })])
    renderWithProviders(<ConnectionsPage />, { route: '/connections' })

    await screen.findByRole('button', { name: t('accounts.retrySync') })
    expect(screen.getByRole('button', { name: t('accounts.reconnect') })).toBeInTheDocument()
  })

  it('keeps reconnect as the only action for an expired connection', async () => {
    api.connectionsList.mockResolvedValue([makeConnection({ id: 'conn-exp', status: 'expired' })])
    renderWithProviders(<ConnectionsPage />, { route: '/connections' })

    await screen.findByRole('button', { name: t('accounts.reconnect') })
    expect(screen.queryByRole('button', { name: t('accounts.retrySync') })).not.toBeInTheDocument()
  })

  it('keeps sync as the only action for an active connection', async () => {
    api.connectionsList.mockResolvedValue([makeConnection({ id: 'conn-ok', status: 'active' })])
    renderWithProviders(<ConnectionsPage />, { route: '/connections' })

    await screen.findByRole('button', { name: t('accounts.sync') })
    expect(screen.queryByRole('button', { name: t('accounts.reconnect') })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: t('accounts.retrySync') })).not.toBeInTheDocument()
  })

  it('retries the sync for the connection whose row the retry button sits in', async () => {
    api.connectionsList.mockResolvedValue([makeConnection({ id: 'conn-err', status: 'error' })])
    const { user } = renderWithProviders(<ConnectionsPage />, { route: '/connections' })

    const retry = await screen.findByRole('button', { name: t('accounts.retrySync') })
    await user.click(retry)

    expect(api.sync).toHaveBeenCalledWith('conn-err')
  })

  it('lists the accounts and cards of a connection under it', async () => {
    api.connectionsList.mockResolvedValue([makeConnection({ id: 'conn-1' })])
    api.accountsList.mockResolvedValue([
      makeAccount('conn-1'),
      makeAccount('conn-1', { id: 'card-1', name: 'Black Card', type: 'credit_card' }),
    ])
    renderWithProviders(<ConnectionsPage />, { route: '/connections' })

    expect(await screen.findByText('Healthy Checking')).toBeInTheDocument()
    expect(screen.getByText('Black Card')).toBeInTheDocument()
  })
})
