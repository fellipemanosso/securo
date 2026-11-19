import { screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import TransactionsPage from '@/pages/transactions'
import { renderWithProviders, t } from '@/test/utils'
import type { Account, Category, CategoryGroup, Transaction } from '@/types'
import type * as WorkspaceContextModule from '@/contexts/workspace-context'

const api = vi.hoisted(() => ({
  transactions: {
    list: vi.fn(), update: vi.fn(), delete: vi.fn(), create: vi.fn(),
    transferPair: vi.fn(), toggleIgnore: vi.fn(), unlinkRecurring: vi.fn(),
    similar: vi.fn(), bulkCategorize: vi.fn(),
    attachments: {
      list: vi.fn(), upload: vi.fn(), delete: vi.fn(), rename: vi.fn(), downloadUrl: vi.fn(),
    },
  },
  categories: { list: vi.fn(), listIncludingHidden: vi.fn(), create: vi.fn() },
  categoryGroups: { list: vi.fn(), listIncludingHidden: vi.fn() },
  accounts: {
    get: vi.fn(), list: vi.fn(), bills: vi.fn(), summary: vi.fn(),
    update: vi.fn(), runningBalance: vi.fn(),
  },
  recurring: { list: vi.fn() },
  payees: { list: vi.fn(), create: vi.fn() },
  admin: { accountingMode: vi.fn() },
  groups: { get: vi.fn(), list: vi.fn() },
  rules: { create: vi.fn(), list: vi.fn(), update: vi.fn() },
  reconciliation: { suggestions: vi.fn() },
  currencies: { list: vi.fn() },
  settings: { attachments: vi.fn() },
  assets: { list: vi.fn() },
  mortgagePayments: { get: vi.fn(), replace: vi.fn(), remove: vi.fn() },
}))

vi.mock('@/lib/api', () => api)
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
vi.mock('@/hooks/use-display-locale', () => ({
  useDisplayLocale: () => 'en-US',
  useDateLocale: () => 'en-US',
}))
vi.mock('@/hooks/use-privacy-mode', () => ({
  usePrivacyMode: () => ({ mask: (value: string) => value, privacyMode: false, MASK: '***' }),
}))
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ user: { id: 'user-1', preferences: { currency_display: 'USD' } } }),
}))
vi.mock('@/contexts/workspace-context', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkspaceContextModule>()
  return { ...actual, useWorkspace: () => ({ canWrite: true, hasModule: () => true }) }
})
vi.mock('@/contexts/collection-filter-context', () => ({
  useCollectionFilter: () => ({
    collections: [], activeCollectionId: null, activeCollection: null,
    setActiveCollectionId: () => {}, activeAccountIds: null, activeWalletIds: null,
  }),
}))

const oldCategory: Category = {
  id: 'category-old', user_id: 'user-1', group_id: 'group-1', name: 'Old category',
  icon: 'circle', color: '#111111', is_system: false, is_hidden: false,
  treat_as_transfer: false, is_ignored: false,
}
const newCategory: Category = {
  ...oldCategory, id: 'category-new', name: 'New category', color: '#222222',
}
const categoryGroup: CategoryGroup = {
  id: 'group-1', user_id: 'user-1', name: 'Everyday', icon: 'circle', color: '#333333',
  position: 0, is_system: false, is_hidden: false, categories: [oldCategory, newCategory],
}
const checkingAccount = {
  id: 'account-1', user_id: 'user-1', connection_id: null, external_id: null,
  name: 'Checking', display_name: null, masked_number: null, institution_name: null,
  institution_logo_url: null, type: 'checking', currency: 'USD', balance: 100,
  initial_balance: 0, initial_balance_date: null, is_archived: false, is_active: true,
} as unknown as Account
const transaction: Transaction = {
  id: 'transaction-1', user_id: 'user-1', account_id: checkingAccount.id,
  category_id: oldCategory.id, category: oldCategory, external_id: null,
  description: 'Weekly bread run', original_description: null, amount: 25, currency: 'USD',
  date: '2026-10-20', type: 'debit', source: 'manual', status: 'posted', payee: 'Silva Bakery',
  payee_id: 'payee-1', payee_name: 'Silva Bakery', notes: null, transfer_pair_id: null,
  transfer_counterpart: null,
  amount_primary: null, fx_rate_used: null, fx_fallback: false, installment_number: null,
  total_installments: null, installment_total_amount: null, installment_purchase_date: null,
  installment_series_id: null, bill_id: null, effective_bill_date: null, splits: [],
  is_ignored: false,
}
const saved: Transaction = { ...transaction, category_id: newCategory.id, category: newCategory }

async function editCategory() {
  const view = renderWithProviders(<TransactionsPage />, {
    route: '/transactions', path: '/transactions',
  })

  await view.user.click(await screen.findByText(transaction.description))
  await view.user.click(await screen.findByRole('button', { name: oldCategory.name }))
  await view.user.click(await screen.findByText(newCategory.name))
  await view.user.click(screen.getByRole('button', { name: t('common.save') }))
  return view
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.setSystemTime(new Date('2026-10-20T12:00:00'))
  api.transactions.list.mockImplementation(async () => ({
    items: [api.transactions.update.mock.calls.length > 0 ? saved : transaction],
    total: 1,
    page: 1,
    limit: 50,
  }))
  api.transactions.update.mockResolvedValue(saved)
  api.transactions.similar.mockResolvedValue([
    { id: 'older-1', category_id: null, date: '2026-09-02' },
    { id: 'older-2', category_id: 'category-elsewhere', date: '2026-08-02' },
  ])
  api.transactions.bulkCategorize.mockResolvedValue({ updated: 2 })
  api.transactions.attachments.list.mockResolvedValue([])
  api.categories.list.mockResolvedValue([oldCategory, newCategory])
  api.categories.listIncludingHidden.mockResolvedValue([oldCategory, newCategory])
  api.categoryGroups.list.mockResolvedValue([categoryGroup])
  api.categoryGroups.listIncludingHidden.mockResolvedValue([categoryGroup])
  api.accounts.list.mockResolvedValue([checkingAccount])
  api.recurring.list.mockResolvedValue([])
  api.payees.list.mockResolvedValue([])
  api.admin.accountingMode.mockResolvedValue({ mode: 'cash' })
  api.groups.list.mockResolvedValue([])
  api.rules.list.mockResolvedValue([])
  api.reconciliation.suggestions.mockResolvedValue([])
  api.currencies.list.mockResolvedValue([{ code: 'USD', symbol: '$', name: 'US Dollar', flag: '🇺🇸' }])
  api.settings.attachments.mockResolvedValue({
    allowed_extensions: [], max_file_size_mb: 10, max_attachments_per_transaction: 10,
  })
})

describe('apply category to the same payee after an edit', () => {
  it('saves first, then asks and applies the category to the look-alikes', async () => {
    const { user } = await editCategory()

    const title = t('transactions.categoryFollowUp.titlePayee', { category: newCategory.name, name: 'Silva Bakery' })
    expect(await screen.findByRole('dialog', { name: title })).toBeInTheDocument()
    expect(api.transactions.update).toHaveBeenCalledWith(
      transaction.id,
      expect.objectContaining({ category_id: newCategory.id }),
    )
    expect(api.transactions.similar).toHaveBeenCalledWith(transaction.id)
    expect(api.transactions.bulkCategorize).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: t('transactions.categoryFollowUp.applyAll', { count: 2 }) }))

    await waitFor(() => expect(api.transactions.bulkCategorize).toHaveBeenCalledWith(
      ['older-1', 'older-2'], newCategory.id, 'manual',
    ))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: title })).not.toBeInTheDocument())
  })

  it('leaves the other transactions alone on "Only this one"', async () => {
    const { user } = await editCategory()

    await user.click(await screen.findByRole('button', { name: t('transactions.categoryFollowUp.thisOnly') }))

    expect(api.transactions.bulkCategorize).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('does not ask when the payee has no other transaction to change', async () => {
    api.transactions.similar.mockResolvedValue([])

    await editCategory()

    await waitFor(() => expect(api.transactions.similar).toHaveBeenCalledWith(transaction.id))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
