/**
 * What a row of the categories page tells the user, and where the user ends up
 * after creating or deleting one.
 */
import { createContext } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'

import CategoriesPage from '@/pages/categories'
import { renderWithProviders } from '@/test/utils'

const api = vi.hoisted(() => ({
  categories: {
    listIncludingHidden: vi.fn(),
    usage: vi.fn(),
    delete: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    ruleUsage: vi.fn(),
  },
  categoryGroups: {
    listIncludingHidden: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('@/lib/api', () => ({
  categories: api.categories,
  categoryGroups: api.categoryGroups,
}))

vi.mock('@/contexts/workspace-context', () => ({
  useWorkspace: () => ({ canWrite: true }),
  WorkspaceContext: createContext<{ canWrite: boolean } | undefined>({ canWrite: true }),
}))

function category(id: string, name: string, overrides = {}) {
  return {
    id,
    user_id: 'user-1',
    name,
    icon: 'circle-help',
    color: '#6366f1',
    group_id: null,
    is_system: false,
    is_hidden: false,
    treat_as_transfer: false,
    is_ignored: false,
    transaction_count: null,
    ...overrides,
  }
}

const NO_USAGE = { transactions: 0, budgets: 0, recurring_transactions: 0, rules: [] }

beforeEach(() => {
  vi.clearAllMocks()
  api.categoryGroups.listIncludingHidden.mockResolvedValue([])
})

describe('usage and origin on each row', () => {
  it('shows how many transactions use a category, with the right plural', async () => {
    api.categories.listIncludingHidden.mockResolvedValue([
      category('food', 'Food', { transaction_count: 214 }),
      category('pets', 'Pets', { transaction_count: 1 }),
      category('gifts', 'Gifts', { transaction_count: 0 }),
    ])
    renderWithProviders(<CategoriesPage />)

    expect(await screen.findByText('214 transactions')).toBeInTheDocument()
    expect(screen.getByText('1 transaction')).toBeInTheDocument()
    expect(screen.getByText('No transactions')).toBeInTheDocument()
  })

  it('shows nothing about usage when the server did not count', async () => {
    api.categories.listIncludingHidden.mockResolvedValue([category('food', 'Food')])
    renderWithProviders(<CategoriesPage />)

    await screen.findByText('Food')
    expect(screen.queryByText(/transaction/i)).not.toBeInTheDocument()
  })

  it('labels the categories that came with the app', async () => {
    api.categories.listIncludingHidden.mockResolvedValue([
      category('food', 'Food', { is_system: true }),
      category('pets', 'Pets'),
    ])
    renderWithProviders(<CategoriesPage />)

    await screen.findByText('Pets')
    expect(screen.getAllByText('Default')).toHaveLength(1)
  })
})

describe('after deleting a category', () => {
  it('puts focus on the next row instead of dropping it on the page', async () => {
    api.categories.listIncludingHidden
      .mockResolvedValueOnce([category('food', 'Food'), category('transport', 'Transport')])
      .mockResolvedValue([category('transport', 'Transport')])
    api.categories.usage.mockResolvedValue(NO_USAGE)
    api.categories.delete.mockResolvedValue(undefined)
    const { user } = renderWithProviders(<CategoriesPage />)

    const row = (await screen.findByText('Food')).closest('div')!.parentElement!
    await user.click(within(row).getByTitle('Delete'))
    await user.click(await screen.findByRole('button', { name: /^Delete$/ }))

    await waitFor(() => expect(api.categories.delete).toHaveBeenCalled())
    await waitFor(() =>
      expect(document.activeElement).toHaveAttribute('data-focus-touch', 'row:transport'),
    )
  })
})

describe('when creating a category fails', () => {
  it('says so inside the dialog and keeps what was typed', async () => {
    api.categories.listIncludingHidden.mockResolvedValue([category('food', 'Food')])
    api.categories.create.mockRejectedValue({
      response: { data: { detail: 'A category with this name already exists' } },
    })
    const { user } = renderWithProviders(<CategoriesPage />)

    await screen.findByText('Food')
    await user.click(screen.getByRole('button', { name: 'Add Category' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Name'), 'Pets')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(await within(dialog).findByRole('alert')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Pets')
  })
})
