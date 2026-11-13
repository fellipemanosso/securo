import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'

import AccountsPage, { AccountDialog } from '@/pages/accounts'
import { renderWithProviders, t } from '@/test/utils'
import type { Account } from '@/types'

const api = vi.hoisted(() => ({
  accountsList: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  accounts: { list: api.accountsList },
  assets: { list: vi.fn().mockResolvedValue([]) },
  currencies: { list: vi.fn().mockResolvedValue([]) },
}))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ user: { preferences: { currency_display: 'USD' } } }),
}))

vi.mock('@/contexts/workspace-context', () => ({
  useWorkspace: () => ({ canWrite: true }),
}))

vi.mock('@/contexts/collection-filter-context', () => ({
  useCollectionFilter: () => ({ activeAccountIds: null }),
}))

vi.mock('@/hooks/use-privacy-mode', () => ({
  usePrivacyMode: () => ({ mask: (value: string) => value }),
}))

vi.mock('@/hooks/use-display-locale', () => ({
  useDisplayLocale: () => 'en',
  useDateLocale: () => 'en-US',
}))

vi.mock('@/lib/invalidate-queries', () => ({
  invalidateFinancialQueries: vi.fn(),
}))

vi.mock('@/components/account-page-actions', () => ({ AccountPageActions: () => null }))
vi.mock('@/components/account-row-actions', () => ({ AccountRowActions: () => null }))

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1',
    user_id: 'user-1',
    connection_id: null,
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

describe('AccountsPage lists', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.accountsList.mockImplementation((includeClosed: boolean) =>
      Promise.resolve(includeClosed ? [] : [
        makeAccount(),
        makeAccount({ id: 'acc-bank', name: 'Bank Savings', connection_id: 'conn-1', type: 'savings' }),
        makeAccount({ id: 'card-1', name: 'Black Card', type: 'credit_card' }),
      ]),
    )
  })

  it('lists manual and bank-linked accounts together', async () => {
    renderWithProviders(<AccountsPage />, { route: '/accounts' })

    expect(await screen.findByText('Healthy Checking')).toBeInTheDocument()
    expect(screen.getByText('Bank Savings')).toBeInTheDocument()
  })

  it('leaves credit cards to the cards page', async () => {
    renderWithProviders(<AccountsPage />, { route: '/accounts' })

    await screen.findByText('Healthy Checking')
    expect(screen.queryByText('Black Card')).not.toBeInTheDocument()
  })

  it('does not manage bank connections', async () => {
    renderWithProviders(<AccountsPage />, { route: '/accounts' })

    await screen.findByText('Healthy Checking')
    expect(screen.queryByRole('button', { name: t('accounts.sync') })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: t('accounts.reconnect') })).not.toBeInTheDocument()
  })
})

describe('AccountDialog account types', () => {
  it.each([
    { kind: 'manual', connectionId: null },
    { kind: 'bank-connected', connectionId: 'conn-1' },
  ])('saves Loan when editing an existing $kind checking account', async ({ connectionId }) => {
    const account = makeAccount({ connection_id: connectionId })
    const onSave = vi.fn()
    const { user } = renderWithProviders(
      <AccountDialog open account={account} onClose={vi.fn()} onSave={onSave} loading={false} />,
    )

    expect(screen.getByRole('heading', { name: t('accounts.editAccount') })).toBeInTheDocument()
    const [accountType] = screen.getAllByRole('combobox')
    expect(accountType).toHaveValue('checking')
    await user.selectOptions(accountType, 'loan')
    await user.click(screen.getByRole('button', { name: t('common.save') }))

    expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'loan' }))
  })
})
