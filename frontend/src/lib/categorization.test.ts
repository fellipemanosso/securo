import { describe, expect, it } from 'vitest'

import { categoryTotals, groupForReview, matchesFilter, pendingLookalikes } from '@/lib/categorization'
import type { Category, Transaction } from '@/types'

const food = { id: 'food', name: 'Food', color: '#000' } as Category
const home = { id: 'home', name: 'Home', color: '#111' } as Category

function tx(overrides: Partial<Transaction>): Transaction {
  return {
    id: 'tx', date: '2026-11-05', type: 'debit', amount: 10, amount_primary: null,
    category_id: null, category: null, has_category_lines: false, category_lines: [],
    category_source: null, description: 'x',
    ...overrides,
  } as Transaction
}

describe('categoryTotals', () => {
  it('adds each part of a split row to its own category, in primary currency', () => {
    const totals = categoryTotals([
      tx({ id: 'a', amount: 100, amount_primary: 500, has_category_lines: true, category_lines: [
        { id: 'l1', category_id: 'food', amount: 60, category: food, share_type: 'exact', share_pct: null, position: 0, notes: null },
        { id: 'l2', category_id: 'home', amount: 40, category: home, share_type: 'exact', share_pct: null, position: 1, notes: null },
      ] }),
      tx({ id: 'b', amount: 20, category_id: 'food', category: food }),
      tx({ id: 'c', amount: 5, type: 'credit' }),
    ])
    expect(totals.map(({ key, total }) => [key, total])).toEqual([
      ['', 5],
      ['food', -320],
      ['home', -200],
    ])
  })
})

describe('groupForReview', () => {
  it('puts uncategorized first, categories by name, split rows last', () => {
    const groups = groupForReview([
      tx({ id: 'split', has_category_lines: true }),
      tx({ id: 'home', category_id: 'home', category: home }),
      tx({ id: 'none' }),
      tx({ id: 'food', category_id: 'food', category: food }),
    ], 'en')
    expect(groups.map((group) => group.key)).toEqual(['', 'food', 'home', 'split'])
  })
})

describe('matchesFilter', () => {
  it('keeps a category with no recorded origin out of automatic and manual', () => {
    const unknown = tx({ category_id: 'food' })
    expect(matchesFilter(unknown, 'automatic')).toBe(false)
    expect(matchesFilter(unknown, 'manual')).toBe(false)
    expect(matchesFilter(unknown, 'all')).toBe(true)
    expect(matchesFilter(tx({ category_id: 'food', category_source: 'recurring' }), 'automatic')).toBe(true)
    expect(matchesFilter(tx({ category_id: 'food', category_source: 'suggestion' }), 'manual')).toBe(true)
  })
})

describe('pendingLookalikes', () => {
  it('counts only rows not in the new category, split into this month and every month', () => {
    const similar = [
      { id: 'm1', category_id: null, date: '2026-11-02' },
      { id: 'm2', category_id: 'food', date: '2026-11-03' },
      { id: 'o1', category_id: 'home', date: '2026-08-01' },
    ]
    expect(pendingLookalikes(similar, 'food', new Set(['m1', 'm2']))).toEqual({ month: ['m1'], all: ['m1', 'o1'] })
  })
})
