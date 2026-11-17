import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'

import CardsOverviewPage from '@/pages/cards-overview'
import { renderWithProviders } from '@/test/utils'
import type { Account } from '@/types'

const api = vi.hoisted(() => ({
  accountsList: vi.fn(),
  accountsTimeline: vi.fn(),
  accountsUpdate: vi.fn(),
  recurringList: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  accounts: {
    list: api.accountsList,
    creditCardTimeline: api.accountsTimeline,
    update: api.accountsUpdate,
    create: vi.fn(),
    saveBill: vi.fn(),
    deleteBill: vi.fn(),
  },
  categories: { list: vi.fn().mockResolvedValue([]) },
  categoryGroups: { list: vi.fn().mockResolvedValue([]) },
  recurring: { list: api.recurringList },
  transactions: { createTransfer: vi.fn() },
}))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ user: { preferences: { currency_display: 'BRL' } } }),
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
  useDisplayLocale: () => 'pt-BR',
  useDateLocale: () => 'pt-BR',
}))

vi.mock('@/hooks/use-create-transaction', () => ({
  useCreateTransaction: () => ({
    create: vi.fn(),
    resetForm: vi.fn(),
    mutation: { isPending: false },
    duplicateDraft: null,
    formResetKey: 0,
  }),
}))

vi.mock('@/components/account-icon', () => ({ AccountIcon: () => null }))
vi.mock('@/components/transaction-dialog', () => ({ TransactionDialog: () => null }))
vi.mock('@/components/transfer-dialog', () => ({ TransferDialog: () => null }))
vi.mock('@/components/delete-confirmation-dialog', () => ({ DeleteConfirmationDialog: () => null }))
vi.mock('@/pages/accounts', () => ({ AccountDialog: () => null }))

const card = {
  id: 'card-1',
  user_id: 'user-1',
  connection_id: 'connection-1',
  external_id: 'external-card-1',
  name: 'Cartão Black',
  display_name: null,
  masked_number: '1234',
  institution_name: 'Banco',
  institution_logo_url: null,
  type: 'credit_card',
  balance: 0,
  current_balance: 0,
  previous_balance: null,
  balance_primary: 0,
  currency: 'BRL',
  credit_limit: 10000,
  available_credit: 10000,
  statement_close_day: null,
  payment_due_day: null,
  next_close_date: null,
  next_due_date: null,
  minimum_payment: null,
  card_brand: null,
  card_level: null,
  shared_balance_group: null,
  is_closed: false,
  closed_at: null,
} satisfies Account

describe('CardsOverviewPage', () => {
  beforeEach(() => {
    api.accountsList.mockResolvedValue([card])
    api.accountsTimeline.mockResolvedValue([])
    api.recurringList.mockResolvedValue([])
    api.accountsUpdate.mockImplementation(async (_id: string, payload: Partial<Account>) => ({
      ...card,
      ...payload,
    }))
  })

  it('sets a display name for the principal card', async () => {
    const { user } = renderWithProviders(<CardsOverviewPage />)

    await user.click(await screen.findByRole('button', { name: 'Renomear cartão' }))
    await user.type(screen.getByRole('textbox', { name: 'Nome de exibição do cartão' }), 'Viagens')
    await user.click(screen.getByRole('button', { name: 'Salvar nome do cartão' }))

    await waitFor(() => {
      expect(api.accountsUpdate).toHaveBeenCalledExactlyOnceWith('card-1', { display_name: 'Viagens' })
    })
    expect(await screen.findByRole('heading', { name: 'Viagens' })).toBeInTheDocument()
  })
})
