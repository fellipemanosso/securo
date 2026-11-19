import { screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { splitLookalikes, useApplyCategoryToSimilar } from '@/components/apply-category-to-similar'
import { renderWithProviders, t } from '@/test/utils'
import type { Category, Transaction } from '@/types'

const api = vi.hoisted(() => ({
  transactions: { similar: vi.fn(), bulkCategorize: vi.fn() },
}))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))

vi.mock('@/lib/api', () => api)
vi.mock('sonner', () => ({ toast }))

const groceries = {
  id: 'cat-groceries', name: 'Groceries', icon: 'circle', color: '#111111',
} as Category

const before = {
  id: 'tx-1', description: 'PADARIA SILVA 123', payee: 'Silva Bakery', payee_id: 'payee-1',
  payee_name: 'Silva Bakery', category_id: null, category: null, transfer_pair_id: null,
  has_category_lines: false,
} as unknown as Transaction
const saved = { ...before, category_id: groceries.id, category: groceries } as Transaction

function Harness({ previous = before, next = saved }: { previous?: Transaction; next?: Transaction }) {
  const { offer, dialog } = useApplyCategoryToSimilar()
  return (
    <>
      <button type="button" onClick={() => void offer(previous, next)}>save</button>
      {dialog}
    </>
  )
}

async function offerWith(similar: { id: string; category_id: string | null; date: string }[], props = {}) {
  api.transactions.similar.mockResolvedValue(similar)
  const view = renderWithProviders(<Harness {...props} />)
  await view.user.click(screen.getByRole('button', { name: 'save' }))
  return view
}

const row = (id: string, category_id: string | null) => ({ id, category_id, date: '2026-09-01' })

beforeEach(() => {
  vi.clearAllMocks()
  api.transactions.bulkCategorize.mockResolvedValue({ updated: 3 })
})

describe('splitLookalikes', () => {
  it('separates uncategorized rows from rows in another category and drops those already in it', () => {
    expect(splitLookalikes([row('a', null), row('b', 'other'), row('c', groceries.id)], groceries.id))
      .toEqual({ uncategorized: ['a'], recategorized: ['b'] })
  })
})

describe('useApplyCategoryToSimilar', () => {
  it.each([
    ['there are no look-alikes', []],
    ['every look-alike already has the category', [row('a', groceries.id)]],
  ])('shows nothing when %s', async (_name, similar) => {
    await offerWith(similar)
    await waitFor(() => expect(api.transactions.similar).toHaveBeenCalledWith('tx-1'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it.each([
    ['the saved row is half of a transfer pair', { next: { ...saved, transfer_pair_id: 'pair-1' } }],
    ['the saved row is split into category lines', { next: { ...saved, has_category_lines: true, category_id: null, category: null } }],
    ['the new category is empty', { next: { ...saved, category_id: null, category: null }, previous: { ...before, category_id: groceries.id, category: groceries } }],
    ['the category did not change', { previous: saved }],
  ])('does not even look up look-alikes when %s', async (_name, props) => {
    await offerWith([row('a', null)], props)
    expect(api.transactions.similar).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('names the category and the payee once and counts both groups', async () => {
    await offerWith([row('a', null), row('b', null), row('c', 'cat-other')])

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAccessibleName(t('transactions.categoryFollowUp.titlePayee', { category: 'Groceries', name: 'Silva Bakery' }))
    expect(screen.getByText(t('transactions.categoryFollowUp.summary', { count: 3 }))).toBeInTheDocument()
    expect(screen.getByText(t('transactions.categoryFollowUp.uncategorized', { count: 2 }))).toBeInTheDocument()
    expect(screen.getByText(t('transactions.categoryFollowUp.otherCategory', { count: 1 }))).toBeInTheDocument()
    expect(dialog.textContent?.match(/Silva Bakery/g)).toHaveLength(1)
  })

  it('names the description when the row has no payee', async () => {
    const noPayee = { ...saved, payee_id: null, payee_name: null, payee: null }
    await offerWith([row('a', null)], { next: noPayee })

    expect(await screen.findByRole('dialog')).toHaveAccessibleName(
      t('transactions.categoryFollowUp.titleDescription', { category: 'Groceries', name: 'PADARIA SILVA 123' }),
    )
  })

  it('applies to every look-alike with the manual source and reports the count', async () => {
    const { user, queryClient } = await offerWith([row('a', null), row('b', 'cat-other')])
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    await user.click(await screen.findByRole('button', { name: t('transactions.categoryFollowUp.applyAll', { count: 2 }) }))

    await waitFor(() => expect(api.transactions.bulkCategorize).toHaveBeenCalledWith(['a', 'b'], groceries.id, 'manual'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(t('categorization.followUp.applied', { count: 3 })))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['transactions'] })
  })

  it('offers an uncategorized-only action when both groups exist and sends just those ids', async () => {
    const { user } = await offerWith([row('a', null), row('b', 'cat-other'), row('c', null)])

    await user.click(await screen.findByRole('button', { name: t('transactions.categoryFollowUp.applyUncategorized', { count: 2 }) }))

    await waitFor(() => expect(api.transactions.bulkCategorize).toHaveBeenCalledWith(['a', 'c'], groceries.id, 'manual'))
  })

  it.each([
    ['only uncategorized rows', [row('a', null)]],
    ['only rows in another category', [row('b', 'cat-other')]],
  ])('has no uncategorized-only action with %s', async (_name, similar) => {
    await offerWith(similar)

    await screen.findByRole('dialog')
    expect(screen.queryByRole('button', { name: /^Only the/ })).not.toBeInTheDocument()
  })

  it('starts on "Only this one", which sends nothing and closes', async () => {
    const { user } = await offerWith([row('a', null)])

    const dismiss = await screen.findByRole('button', { name: t('transactions.categoryFollowUp.thisOnly') })
    await waitFor(() => expect(dismiss).toHaveFocus())
    await user.click(dismiss)

    expect(api.transactions.bulkCategorize).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('closes on Escape without applying anything', async () => {
    const { user } = await offerWith([row('a', null)])

    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')

    expect(api.transactions.bulkCategorize).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('disables every action and shows the saving label while applying', async () => {
    let finish: (value: { updated: number }) => void = () => {}
    api.transactions.bulkCategorize.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const { user } = await offerWith([row('a', null), row('b', 'cat-other')])

    await user.click(await screen.findByRole('button', { name: t('transactions.categoryFollowUp.applyAll', { count: 2 }) }))

    expect(await screen.findByRole('button', { name: t('common.saving') })).toBeDisabled()
    expect(screen.getByRole('button', { name: t('transactions.categoryFollowUp.thisOnly') })).toBeDisabled()
    finish({ updated: 2 })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('keeps the prompt open and reports the error when applying fails', async () => {
    api.transactions.bulkCategorize.mockRejectedValue(new Error('boom'))
    const { user } = await offerWith([row('a', null)])

    await user.click(await screen.findByRole('button', { name: t('transactions.categoryFollowUp.applyAll', { count: 1 }) }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('does nothing visible when the look-alike lookup fails', async () => {
    api.transactions.similar.mockRejectedValue(new Error('offline'))
    const view = renderWithProviders(<Harness />)

    await view.user.click(screen.getByRole('button', { name: 'save' }))
    await waitFor(() => expect(api.transactions.similar).toHaveBeenCalled())

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(toast.error).not.toHaveBeenCalled()
  })
})
