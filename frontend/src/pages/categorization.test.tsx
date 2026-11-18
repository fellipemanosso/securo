/**
 * Categorizações: the month lives in the URL, the chips sort rows by how
 * their category was set, a change moves money between the category totals
 * at once, offers the payee's other rows (counted first) and a rule, an
 * uncategorized row takes its suggestion in one click, and the navigation
 * badge follows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { useLocation } from 'react-router-dom'

import CategorizationPage from '@/pages/categorization'
import { NavCountBadge } from '@/components/nav-count-badge'
import { useUncategorizedCount } from '@/hooks/use-uncategorized-count'
import { formatCurrency } from '@/lib/format'
import { renderWithProviders, t, type ProviderRenderResult } from '@/test/utils'
import type { Category, CategorySuggestion, SimilarTransaction, Transaction } from '@/types'

const api = vi.hoisted(() => ({
  transactions: {
    list: vi.fn(),
    bulkCategorize: vi.fn(),
    categorySuggestions: vi.fn(),
    similar: vi.fn(),
  },
  categories: { list: vi.fn() },
  categoryGroups: { list: vi.fn() },
  accounts: { list: vi.fn() },
  rules: { list: vi.fn(), create: vi.fn(), preview: vi.fn() },
  payees: { list: vi.fn() },
}))

vi.mock('@/lib/api', () => api)
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

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

// The real context object stays: CategorySelect reads it directly.
vi.mock('@/contexts/workspace-context', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useWorkspace: () => ({ canWrite: true, hasModule: () => true }),
}))

vi.mock('@/contexts/collection-filter-context', () => ({
  useCollectionFilter: () => ({ activeAccountIds: null, activeWalletIds: null }),
}))

const money = (value: number) => formatCurrency(value, 'BRL', 'en-US')

function category(id: string, name: string): Category {
  return {
    id, name, user_id: 'u', group_id: null, icon: 'tag', color: '#64748b',
    is_system: false, is_hidden: false, treat_as_transfer: false, is_ignored: false,
  }
}

const food = category('cat-food', 'Food')
const transport = category('cat-transport', 'Transport')
const salary = category('cat-salary', 'Salary')
const categoriesById: Record<string, Category> = { [food.id]: food, [transport.id]: transport, [salary.id]: salary }

function tx(id: string, description: string, amount: number, overrides: Partial<Transaction> = {}): Transaction {
  const categoryId = overrides.category_id ?? null
  return {
    id, user_id: 'u', account_id: 'acc-1', category_id: categoryId,
    category: categoryId ? categoriesById[categoryId] : null,
    external_id: null, description, original_description: null, amount, currency: 'BRL',
    date: '2026-11-05', type: 'debit', source: 'sync', status: 'posted',
    payee: null, payee_id: null, payee_name: null, notes: null, transfer_pair_id: null,
    amount_primary: null, fx_rate_used: null, fx_fallback: false,
    installment_number: null, total_installments: null, installment_total_amount: null,
    installment_purchase_date: null, installment_series_id: null, bill_id: null,
    effective_bill_date: null, splits: [], is_ignored: false,
    category_source: null, category_rule_id: null,
    ...overrides,
  }
}

function seed(): Transaction[] {
  return [
    tx('tx-uber', 'UBER TRIP', 30, { payee_id: 'payee-uber', payee_name: 'Uber' }),
    tx('tx-uber-2', 'UBER TRIP 2', 20, { payee_id: 'payee-uber', payee_name: 'Uber', date: '2026-11-03' }),
    tx('tx-ifood', 'IFOOD', 45, { category_id: food.id, category_source: 'rule', category_rule_id: 'rule-ifood' }),
    tx('tx-salary', 'SALARIO', 5000, { type: 'credit', category_id: salary.id, category_source: 'provider' }),
    tx('tx-feira', 'FEIRA', 15, { category_id: food.id, category_source: 'manual' }),
    tx('tx-padaria', 'PADARIA', 10, { category_id: food.id }),
  ]
}

// What the server holds: the list and the count read it, writes change it.
let rows: Transaction[] = []
let similar: SimilarTransaction[] = []

function recategorize(ids: string[], categoryId: string | null, source: 'manual' | 'suggestion') {
  rows = rows.map((row) => ids.includes(row.id)
    ? { ...row, category_id: categoryId, category: categoryId ? categoriesById[categoryId] : null, category_source: source }
    : row)
  similar = similar.map((row) => ids.includes(row.id) ? { ...row, category_id: categoryId } : row)
  return { updated: ids.length }
}

function SidebarBadge() {
  const { data } = useUncategorizedCount('2026-11')
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

function renderPage(route = '/categorization?month=2026-11') {
  return renderWithProviders(
    <>
      <SidebarBadge />
      <CategorizationPage />
      <LocationProbe />
    </>,
    { route },
  )
}

const row = (id: string) => screen.getByTestId(`categorization-row-${id}`)

async function pickCategory(user: ProviderRenderResult['user'], description: string, current: string, next: string) {
  await user.click(screen.getByRole('button', { name: t('categorization.categoryOf', { description, category: current }) }))
  await user.click(await screen.findByRole('option', { name: next }))
}

beforeEach(() => {
  vi.clearAllMocks()
  rows = seed()
  similar = []
  api.transactions.list.mockImplementation(async (params: { from: string; to: string; uncategorized?: boolean; page?: number; limit?: number }) => {
    const inMonth = rows.filter((row) => row.date >= params.from && row.date <= params.to)
    if (params.uncategorized) {
      const total = inMonth.filter((row) => !row.category_id && !row.has_category_lines).length
      return { items: [], total, page: 1, limit: 1 }
    }
    return { items: inMonth, total: inMonth.length, page: params.page ?? 1, limit: params.limit ?? 500 }
  })
  api.transactions.bulkCategorize.mockImplementation(async (ids: string[], categoryId: string | null, source: 'manual' | 'suggestion') =>
    recategorize(ids, categoryId, source))
  api.transactions.categorySuggestions.mockResolvedValue([])
  api.transactions.similar.mockImplementation(async () => similar)
  api.categories.list.mockResolvedValue([food, transport, salary])
  api.categoryGroups.list.mockResolvedValue([])
  api.accounts.list.mockResolvedValue([{ id: 'acc-1', name: 'Nubank', display_name: null }])
  api.rules.list.mockResolvedValue([{ id: 'rule-ifood', name: 'iFood', user_id: 'u', conditions_op: 'and', conditions: [], actions: [], priority: 0, is_active: true }])
  api.rules.create.mockResolvedValue({ id: 'rule-new', applied_count: 0 })
  api.payees.list.mockResolvedValue([])
})

describe('Categorizações page', () => {
  it('keeps the month in the URL and lists that month', async () => {
    const { user } = renderPage()

    expect(await screen.findByText('UBER TRIP')).toBeInTheDocument()
    expect(api.transactions.list).toHaveBeenCalledWith(expect.objectContaining({
      from: '2026-11-01', to: '2026-11-30', exclude_transfers: true, exclude_ignored: true,
    }))

    await user.click(screen.getByRole('button', { name: t('month.previous') }))

    expect(await screen.findByText(t('categorization.empty.title'))).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('/categorization?month=2026-10')
    expect(api.transactions.list).toHaveBeenCalledWith(expect.objectContaining({ from: '2026-10-01', to: '2026-10-31' }))
  })

  it('sorts rows by how their category was set, saying how for each', async () => {
    const { user } = renderPage()
    await screen.findByText('UBER TRIP')

    expect(screen.getByTestId('categorization-filter-uncategorized-count')).toHaveTextContent('2')
    expect(screen.getByTestId('categorization-filter-automatic-count')).toHaveTextContent('2')
    expect(screen.getByTestId('categorization-filter-manual-count')).toHaveTextContent('1')
    expect(screen.getByTestId('categorization-filter-all-count')).toHaveTextContent('6')
    // Uncategorized rows lead the list.
    const groups = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)
    expect(groups.indexOf(t('categorization.uncategorized'))).toBeLessThan(groups.indexOf('Food'))

    await user.click(screen.getByTestId('categorization-filter-uncategorized'))
    expect(screen.getByText('UBER TRIP')).toBeInTheDocument()
    expect(screen.queryByText('IFOOD')).not.toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('filter=uncategorized')

    await user.click(screen.getByTestId('categorization-filter-automatic'))
    expect(within(row('tx-ifood')).getByText(t('categorization.source.ruleNamed', { name: 'iFood' }))).toBeInTheDocument()
    expect(within(row('tx-salary')).getByText(t('categorization.source.provider'))).toBeInTheDocument()
    expect(screen.queryByText('FEIRA')).not.toBeInTheDocument()
    // The row with no recorded origin is in neither chip, and the page says so.
    expect(screen.queryByText('PADARIA')).not.toBeInTheDocument()
    expect(screen.getByText(t('categorization.unknownHint', { count: 1 }))).toBeInTheDocument()

    await user.click(screen.getByTestId('categorization-filter-manual'))
    expect(screen.getByText('FEIRA')).toBeInTheDocument()
    expect(screen.queryByText('IFOOD')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('categorization-filter-all'))
    await user.type(screen.getByRole('searchbox', { name: t('categorization.searchPlaceholder') }), 'padaria')
    expect(screen.getByText('PADARIA')).toBeInTheDocument()
    expect(screen.queryByText('UBER TRIP')).not.toBeInTheDocument()
  })

  it('recategorizes inline and moves the money between the totals', async () => {
    const { user } = renderPage()
    await screen.findByText('UBER TRIP')
    expect(screen.getByTestId('category-total-none')).toHaveTextContent(money(-50))
    expect(screen.queryByTestId('category-total-cat-transport')).not.toBeInTheDocument()

    await pickCategory(user, 'UBER TRIP', t('categorization.uncategorized'), 'Transport')

    expect(api.transactions.bulkCategorize).toHaveBeenCalledWith(['tx-uber'], 'cat-transport', 'manual')
    await waitFor(() => expect(screen.getByTestId('category-total-cat-transport')).toHaveTextContent(money(-30)))
    expect(screen.getByTestId('category-total-none')).toHaveTextContent(money(-20))
    expect(within(row('tx-uber')).getByText(t('categorization.source.manual'))).toBeInTheDocument()
  })

  it('counts the payee’s other rows before applying the change to them', async () => {
    similar = [
      { id: 'tx-uber-2', category_id: null, date: '2026-11-03' },
      { id: 'tx-uber-sep', category_id: null, date: '2026-09-10' },
      { id: 'tx-uber-aug', category_id: 'cat-transport', date: '2026-08-01' },
    ]
    const { user } = renderPage()
    await screen.findByText('UBER TRIP')

    await pickCategory(user, 'UBER TRIP', t('categorization.uncategorized'), 'Transport')

    expect(await screen.findByText(t('categorization.followUp.samePayee', { name: 'Uber' }))).toBeInTheDocument()
    expect(api.transactions.similar).toHaveBeenCalledWith('tx-uber')
    const applyMonth = await screen.findByRole('button', { name: t('categorization.followUp.applyMonth', { count: 1 }) })
    // Already in Transport, the August row is not counted.
    expect(screen.getByRole('button', { name: t('categorization.followUp.applyAll', { count: 2 }) })).toBeInTheDocument()

    await user.click(applyMonth)

    expect(api.transactions.bulkCategorize).toHaveBeenLastCalledWith(['tx-uber-2'], 'cat-transport', 'manual')
    expect(await screen.findByText(t('categorization.followUp.noneMonth'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('categorization.followUp.applyAll', { count: 1 }) })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('category-total-cat-transport')).toHaveTextContent(money(-50)))
    expect(screen.queryByTestId('category-total-none')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: t('categorization.followUp.applyAll', { count: 1 }) }))
    expect(api.transactions.bulkCategorize).toHaveBeenLastCalledWith(['tx-uber-sep'], 'cat-transport', 'manual')
  })

  it('turns a change into a rule for the payee', async () => {
    const { user } = renderPage()
    await screen.findByText('UBER TRIP')

    await pickCategory(user, 'UBER TRIP', t('categorization.uncategorized'), 'Transport')
    await user.click(await screen.findByRole('button', { name: t('categorization.followUp.createRule') }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByDisplayValue(t('categorization.ruleName', { name: 'Uber', category: 'Transport' }))).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: t('common.save') }))

    await waitFor(() => expect(api.rules.create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Uber → Transport',
      conditions: [{ field: 'payee_id', op: 'equals', value: 'payee-uber' }],
      actions: [{ op: 'set_category', value: 'cat-transport' }],
    })))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('accepts a suggestion from the payee’s history in one click', async () => {
    const suggestion: CategorySuggestion = { transaction_id: 'tx-uber', category_id: 'cat-transport', uses: 4, matched_by: 'payee' }
    api.transactions.categorySuggestions.mockResolvedValue([suggestion])
    const { user } = renderPage()
    await screen.findByText('UBER TRIP')

    await waitFor(() => expect(api.transactions.categorySuggestions).toHaveBeenCalledWith(['tx-uber', 'tx-uber-2']))
    const uber = row('tx-uber')
    expect(await within(uber).findByText(t('categorization.suggestionBasis.payee', { count: 4 }))).toBeInTheDocument()

    await user.click(within(uber).getByRole('button', {
      name: t('categorization.acceptLabel', { category: 'Transport', description: 'UBER TRIP' }),
    }))

    expect(api.transactions.bulkCategorize).toHaveBeenCalledWith(['tx-uber'], 'cat-transport', 'suggestion')
    expect(await within(row('tx-uber')).findByText(t('categorization.source.suggestion'))).toBeInTheDocument()
  })

  it('updates the navigation badge after categorizing', async () => {
    const { user } = renderPage()
    await screen.findByText('UBER TRIP')
    const sidebar = screen.getByTestId('sidebar')
    await waitFor(() => expect(within(sidebar).getByTestId('nav-count-badge')).toHaveTextContent('2'))

    await pickCategory(user, 'UBER TRIP', t('categorization.uncategorized'), 'Transport')
    await waitFor(() => expect(within(sidebar).getByTestId('nav-count-badge')).toHaveTextContent('1'))

    await pickCategory(user, 'UBER TRIP 2', t('categorization.uncategorized'), 'Transport')
    await waitFor(() => expect(within(sidebar).queryByTestId('nav-count-badge')).not.toBeInTheDocument())
  })

  it('offers a retry when the month cannot be loaded', async () => {
    api.transactions.list.mockRejectedValue(new Error('offline'))
    renderPage()

    expect(await screen.findByText(t('categorization.error'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('common.retry') })).toBeInTheDocument()
  })
})
