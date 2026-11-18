/**
 * The arithmetic behind the Categorizações page, kept out of the component
 * so it can be read (and tested) on its own: how a row got its category,
 * which filter it answers to, how the month's money splits by category, and
 * how many look-alike rows a recategorization would still reach.
 */
import { normalizeText } from '@/lib/utils'
import type { Category, CategorySource, SimilarTransaction, Transaction } from '@/types'

export type CategorizationFilter = 'uncategorized' | 'automatic' | 'manual' | 'all'

/** What the row's category says about who chose it. `unknown` is a category
 *  the backend did not record a source for: rows categorized before it did. */
export type Provenance = CategorySource | 'uncategorized' | 'unknown'

/** Which filter chip each provenance answers to. A category with no
 *  recorded source is neither automatic nor manual: it only shows in "all". */
const FILTER_OF: Record<Provenance, Exclude<CategorizationFilter, 'all'> | null> = {
  rule: 'automatic',
  provider: 'automatic',
  import: 'automatic',
  recurring: 'automatic',
  manual: 'manual',
  suggestion: 'manual',
  uncategorized: 'uncategorized',
  unknown: null,
}

export function isUncategorized(tx: Pick<Transaction, 'category_id' | 'has_category_lines'>): boolean {
  return !tx.category_id && !tx.has_category_lines
}

export function provenanceOf(tx: Pick<Transaction, 'category_id' | 'has_category_lines' | 'category_source'>): Provenance {
  if (isUncategorized(tx)) return 'uncategorized'
  return tx.category_source ?? 'unknown'
}

export function matchesFilter(tx: Transaction, filter: CategorizationFilter): boolean {
  return filter === 'all' || FILTER_OF[provenanceOf(tx)] === filter
}

/** Search over what the row shows: description, payee, category name. */
export function matchesSearch(tx: Transaction, query: string): boolean {
  const needle = normalizeText(query.trim())
  if (!needle) return true
  const haystack = [
    tx.description,
    tx.payee_name,
    tx.payee,
    tx.category?.name,
    ...(tx.category_lines ?? []).map((line) => line.category?.name),
  ]
  return haystack.some((value) => value != null && normalizeText(value).includes(needle))
}

/** Signed value in the primary currency: income positive, spending negative. */
export function signedPrimary(tx: Pick<Transaction, 'amount' | 'amount_primary' | 'type'>): number {
  const magnitude = Math.abs(Number(tx.amount_primary ?? tx.amount))
  return tx.type === 'debit' ? -magnitude : magnitude
}

export interface CategoryTotal {
  /** The category id, or '' for the uncategorized bucket. */
  key: string
  category: Category | null
  total: number
  count: number
}

/**
 * The month's money per category. A split row adds each part to its own
 * category, in proportion, so the totals add up to the rows. The
 * uncategorized bucket leads when it holds anything, because it is the work
 * left; the rest follow by size.
 */
export function categoryTotals(rows: Transaction[]): CategoryTotal[] {
  const totals = new Map<string, CategoryTotal>()
  const add = (key: string, category: Category | null, value: number) => {
    const entry = totals.get(key) ?? { key, category, total: 0, count: 0 }
    entry.total += value
    entry.count += 1
    entry.category ??= category
    totals.set(key, entry)
  }
  for (const tx of rows) {
    const value = signedPrimary(tx)
    const lines = tx.has_category_lines ? tx.category_lines ?? [] : []
    const whole = Math.abs(Number(tx.amount))
    if (lines.length > 0 && whole > 0) {
      for (const line of lines) {
        add(line.category_id, line.category ?? null, value * (Math.abs(Number(line.amount)) / whole))
      }
    } else {
      add(tx.category_id ?? '', tx.category, value)
    }
  }
  return [...totals.values()].sort((a, b) => {
    if (a.key === '' || b.key === '') return a.key === '' ? -1 : 1
    return Math.abs(b.total) - Math.abs(a.total)
  })
}

export interface ReviewGroup {
  key: string
  category: Category | null
  /** The parts of a split row are several categories: it gets its own group. */
  split: boolean
  rows: Transaction[]
}

/** Uncategorized first, then each category by name, split rows last;
 *  newest first inside a group. */
export function groupForReview(rows: Transaction[], locale: string): ReviewGroup[] {
  const groups = new Map<string, ReviewGroup>()
  for (const tx of rows) {
    const key = tx.has_category_lines ? 'split' : tx.category_id ?? ''
    const group = groups.get(key) ?? { key, category: tx.has_category_lines ? null : tx.category, split: !!tx.has_category_lines, rows: [] }
    group.rows.push(tx)
    groups.set(key, group)
  }
  const rank = (group: ReviewGroup) => (group.key === '' ? 0 : group.split ? 2 : 1)
  const collator = new Intl.Collator(locale, { sensitivity: 'base' })
  return [...groups.values()]
    .map((group) => ({ ...group, rows: [...group.rows].sort((a, b) => b.date.localeCompare(a.date)) }))
    .sort((a, b) => rank(a) - rank(b) || collator.compare(a.category?.name ?? '', b.category?.name ?? ''))
}

/**
 * The look-alikes a change to `categoryId` would still move: those not in it
 * already, in this month (the ids the page has loaded) and in every month.
 */
export function pendingLookalikes(
  similar: SimilarTransaction[],
  categoryId: string | null,
  monthIds: ReadonlySet<string>,
): { month: string[]; all: string[] } {
  const all = similar.filter((row) => row.category_id !== categoryId).map((row) => row.id)
  return { month: all.filter((id) => monthIds.has(id)), all }
}
