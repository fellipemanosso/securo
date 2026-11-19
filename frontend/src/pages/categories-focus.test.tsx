/**
 * Where keyboard focus is after the categories page changes under it.
 *
 * Two paths used to drop focus on the page: a row action that went `disabled`
 * while its request ran, and an edit that moved the row to another section and
 * so removed the control the user had pressed.
 */
import { createContext } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'

import CategoriesPage from '@/pages/categories'
import { renderWithProviders } from '@/test/utils'

const api = vi.hoisted(() => ({
  categories: {
    listIncludingHidden: vi.fn(),
    update: vi.fn(),
    ruleUsage: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks()
  api.categoryGroups.listIncludingHidden.mockResolvedValue([])
  api.categories.ruleUsage.mockResolvedValue({ rules: [] })
})

describe('focus on a row action while its request runs', () => {
  it('stays on the hide button, which only reports itself as busy, then on its show twin', async () => {
    let finishUpdate: () => void = () => {}
    let hidden = false
    api.categories.listIncludingHidden.mockImplementation(() =>
      Promise.resolve([category('food', 'Food', { is_system: true, is_hidden: hidden })]),
    )
    api.categories.update.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishUpdate = () => {
            hidden = true
            resolve(category('food', 'Food', { is_system: true, is_hidden: true }))
          }
        }),
    )
    const { user } = renderWithProviders(<CategoriesPage />)

    const hide = await screen.findByRole('button', { name: 'Hide default category: Food' })
    hide.focus()
    await user.keyboard('{Enter}')

    await waitFor(() => expect(hide).toHaveAttribute('aria-disabled', 'true'))
    expect(hide).not.toBeDisabled()
    expect(hide).toHaveFocus()

    // A second press while it is busy does nothing.
    await user.keyboard('{Enter}')
    expect(api.categories.update).toHaveBeenCalledTimes(1)

    finishUpdate()
    const show = await screen.findByRole('button', { name: 'Show default category: Food' })
    expect(show).toHaveFocus()
  })
})

describe('focus after editing a category into another group', () => {
  it('follows the row to its new section instead of falling to the page', async () => {
    const pets = category('pets', 'Pets')
    const moved = { ...pets, group_id: 'home' }
    const home = (categories: object[]) => ({
      id: 'home',
      user_id: 'user-1',
      name: 'Home',
      icon: 'folder',
      color: '#6B7280',
      position: 0,
      is_system: false,
      is_hidden: false,
      categories,
    })
    let saved = false
    api.categories.listIncludingHidden.mockImplementation(() => Promise.resolve([saved ? moved : pets]))
    api.categoryGroups.listIncludingHidden.mockImplementation(() =>
      Promise.resolve([home(saved ? [moved] : [])]),
    )
    api.categories.update.mockImplementation(async () => {
      saved = true
      return moved
    })
    const { user } = renderWithProviders(<CategoriesPage />)

    const edit = await screen.findByRole('button', { name: 'Edit: Pets' })
    edit.focus()
    await user.keyboard('{Enter}')
    const dialog = await screen.findByRole('dialog')
    await user.selectOptions(within(dialog).getByLabelText('Group'), 'home')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.categories.update).toHaveBeenCalled())
    await waitFor(() => {
      const active = document.activeElement as HTMLElement
      expect(active.closest('[data-row-id]')).toHaveAttribute('data-row-id', 'pets')
      expect(active.closest('[data-section]')).toHaveAttribute('data-section', 'home')
    })
  })
})
