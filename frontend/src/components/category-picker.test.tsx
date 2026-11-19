import { screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { renderWithProviders, t } from '@/test/utils'
import type { Category, CategoryGroup } from '@/types'

vi.mock('@/lib/api', () => ({ categories: { create: vi.fn() } }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { CategoryPicker } from './category-picker'

const groceries = { id: 'cat-1', name: 'Groceries', group_id: 'grp-1' } as unknown as Category
const rent = { id: 'cat-2', name: 'Rent', group_id: 'grp-1' } as unknown as Category
const movies = { id: 'cat-3', name: 'Movies', group_id: null } as unknown as Category
const essentials = { id: 'grp-1', name: 'Essentials', categories: [groceries, rent] } as unknown as CategoryGroup

function renderPicker(props: Partial<React.ComponentProps<typeof CategoryPicker>> = {}) {
  const onChange = vi.fn()
  const utils = renderWithProviders(
    <CategoryPicker
      value={null}
      onChange={onChange}
      categories={[groceries, rent, movies]}
      groups={[essentials]}
      {...props}
    />,
  )
  return { ...utils, onChange }
}

describe('CategoryPicker', () => {
  it('lists categories under their group, with the rest under "no group"', () => {
    renderPicker()

    expect(screen.getByText('Essentials')).toBeInTheDocument()
    expect(screen.getByText(t('groups.noGroup'))).toBeInTheDocument()
    expect(screen.getByText('Groceries')).toBeInTheDocument()
    expect(screen.getByText('Movies')).toBeInTheDocument()
  })

  it('filters by name and reports the chosen category', async () => {
    const { user, onChange } = renderPicker()

    await user.type(screen.getByPlaceholderText(t('transactions.searchCategory')), 'ren')

    expect(screen.queryByText('Groceries')).not.toBeInTheDocument()
    await user.click(screen.getByText('Rent'))
    expect(onChange).toHaveBeenCalledWith('cat-2')
  })

  it('offers "no category" only when asked and reports an empty value', async () => {
    const { onChange, unmount } = renderPicker()
    expect(screen.queryByText(t('transactions.noCategory'))).not.toBeInTheDocument()
    unmount()

    const second = renderPicker({ allowNone: true })
    await second.user.click(screen.getByText(t('transactions.noCategory')))
    expect(second.onChange).toHaveBeenCalledWith('')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('does not mark "no category" as current when there is no selection to show', () => {
    renderPicker({ allowNone: true, value: null })

    expect(document.querySelector('svg.lucide-check')).toBeNull()
  })

  it('highlights the first option on open by default, so Enter picks it', async () => {
    const { user, onChange } = renderPicker()

    expect(screen.getByRole('option', { name: 'Groceries' })).toHaveAttribute('aria-selected', 'true')
    await user.click(screen.getByPlaceholderText(t('transactions.searchCategory')))
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledWith('cat-1')
  })

  it('can open with nothing highlighted, so Enter picks nothing until the user chooses', async () => {
    const { user, onChange } = renderPicker({ autoHighlightFirst: false })
    const input = screen.getByPlaceholderText(t('transactions.searchCategory'))

    expect(screen.queryByRole('option', { selected: true })).toBeNull()
    await user.click(input)
    await user.keyboard('{Enter}')
    expect(onChange).not.toHaveBeenCalled()

    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('option', { name: 'Groceries' })).toHaveAttribute('aria-selected', 'true')

    await user.type(input, 'mov')
    expect(screen.getByRole('option', { name: 'Movies' })).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledWith('cat-3')
  })

  it('marks categories that leave the reports only when asked to', () => {
    const refunds = { id: 'cat-4', name: 'Refunds', group_id: null, is_ignored: true } as unknown as Category
    const invest = { id: 'cat-5', name: 'Investments', group_id: null, treat_as_transfer: true } as unknown as Category
    const props = { categories: [movies, refunds, invest], groups: [] }

    const plain = renderPicker(props)
    expect(screen.queryByText(t('categories.ignoreTransferBadge'))).toBeNull()
    expect(screen.queryByText(t('categories.treatAsTransferBadge'))).toBeNull()
    plain.unmount()

    renderPicker({ ...props, showReportFlags: true })
    expect(within(screen.getByRole('option', { name: /Refunds/ })).getByText(t('categories.ignoreTransferBadge'))).toBeInTheDocument()
    expect(within(screen.getByRole('option', { name: /Investments/ })).getByText(t('categories.treatAsTransferBadge'))).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Movies' })).toHaveTextContent(/^Movies$/)
  })
})
