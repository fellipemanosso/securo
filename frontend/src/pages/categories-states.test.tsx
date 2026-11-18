/**
 * What the categories page shows when its lists do not arrive normally.
 *
 * A failed load used to render the same blank card as an empty workspace, so a
 * network blip looked like "my categories are gone".
 */
import { createContext } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'

import CategoriesPage from '@/pages/categories'
import { renderWithProviders } from '@/test/utils'

const api = vi.hoisted(() => ({
  categories: {
    listIncludingHidden: vi.fn(),
  },
  categoryGroups: {
    listIncludingHidden: vi.fn(),
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

const FOOD = {
  id: 'food',
  user_id: 'user-1',
  name: 'Food',
  icon: 'circle-help',
  color: '#6366f1',
  group_id: null,
  is_system: true,
  is_hidden: false,
  treat_as_transfer: false,
  is_ignored: false,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('categories page when the lists do not load', () => {
  it('says so and lets the user retry, instead of showing an empty card', async () => {
    api.categories.listIncludingHidden.mockRejectedValueOnce(new Error('network'))
    api.categories.listIncludingHidden.mockResolvedValue([FOOD])
    api.categoryGroups.listIncludingHidden.mockResolvedValue([])
    const { user } = renderWithProviders(<CategoriesPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load your categories.")
    expect(screen.queryByText('No categories yet.')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('Food')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('names an empty workspace as empty, offers to add one, and no collapse toggle for nothing', async () => {
    api.categories.listIncludingHidden.mockResolvedValue([])
    api.categoryGroups.listIncludingHidden.mockResolvedValue([])
    renderWithProviders(<CategoriesPage />)

    expect(await screen.findByText('No categories yet.')).toBeInTheDocument()
    // The toolbar button and the empty state's own call to action.
    expect(screen.getAllByRole('button', { name: 'Add Category' })).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /collapse all|expand all/i })).not.toBeInTheDocument()
  })
})
