/** Categorizações: every category of a month in one place, the automatic
 *  ones included, so a wrong one gets noticed and fixed where it is seen.
 *
 *  Each row says how its category got there (a rule, the bank, an import, a
 *  recurring bill, the user, an accepted suggestion), because that is what
 *  decides whether it is worth checking. A change made here offers the two
 *  things that keep it from being needed again: the same category for the
 *  rest of the payee's rows, and a rule for the ones still to come.
 */
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { isAxiosError } from 'axios'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Hand,
  Landmark,
  Lightbulb,
  Repeat,
  Search,
  SlidersHorizontal,
  Upload,
  X,
} from 'lucide-react'

import {
  accounts as accountsApi,
  categories as categoriesApi,
  categoryGroups as categoryGroupsApi,
  payees as payeesApi,
  rules as rulesApi,
  transactions as transactionsApi,
} from '@/lib/api'
import { extractApiError } from '@/lib/api-errors'
import { getAccountName } from '@/lib/account-utils'
import {
  categoryTotals,
  groupForReview,
  isUncategorized,
  matchesFilter,
  matchesSearch,
  pendingLookalikes,
  provenanceOf,
  signedPrimary,
  type CategorizationFilter,
  type CategoryTotal,
  type Provenance,
} from '@/lib/categorization'
import { formatCurrency, formatSignedAmount } from '@/lib/format'
import { invalidateFinancialQueries } from '@/lib/invalidate-queries'
import { currentMonth, monthLabel, monthRange, shiftMonth } from '@/lib/month-utils'
import { monthFromParam } from '@/lib/month-view'
import { cn } from '@/lib/utils'
import { formatDayMonth } from '@/hooks/use-credit-card-timeline'
import { useDateLocale, useDisplayLocale } from '@/hooks/use-display-locale'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { useAuth } from '@/contexts/auth-context'
import { useCollectionFilter } from '@/contexts/collection-filter-context'
import { useWorkspace } from '@/contexts/workspace-context'
import { CategoryIcon } from '@/components/category-icon'
import { CategorySelect } from '@/components/category-select'
import { Segmented } from '@/components/invoice-ui'
import { RuleDialog, type RuleDialogInitialData } from '@/components/rule-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import type { Category, CategoryGroup, CategorySuggestion, Rule, Transaction } from '@/types'

const FILTERS: CategorizationFilter[] = ['uncategorized', 'automatic', 'manual', 'all']
const PAGE_SIZE = 500

const PROVENANCE_ICON: Record<Provenance, React.ElementType> = {
  rule: SlidersHorizontal,
  provider: Landmark,
  import: Upload,
  recurring: Repeat,
  manual: Hand,
  suggestion: Lightbulb,
  unknown: CircleHelp,
  uncategorized: CircleHelp,
}

/** The latest change made on this page, for the follow-up it offers. */
interface FollowUp {
  tx: Transaction
  from: Category | null
  categoryId: string | null
}

type Money = (value: number) => string

export default function CategorizationPage() {
  const { t, i18n } = useTranslation()
  const locale = useDisplayLocale()
  const dateLocale = useDateLocale()
  const { mask } = usePrivacyMode()
  const { user } = useAuth()
  const { canWrite, hasModule } = useWorkspace()
  const { activeAccountIds } = useCollectionFilter()
  const queryClient = useQueryClient()
  const primaryCurrency = user?.preferences?.currency_display ?? 'USD'
  const uiLanguage = i18n.resolvedLanguage ?? i18n.language
  const thisMonth = currentMonth()
  const money: Money = (value) => mask(formatCurrency(value, primaryCurrency, locale))

  // Month and filter live in the URL, like /month: shareable, and a reload
  // lands on the same review.
  const [searchParams, setSearchParams] = useSearchParams()
  const [search, setSearch] = useState('')
  const [followUp, setFollowUp] = useState<FollowUp | null>(null)
  const [ruleDraft, setRuleDraft] = useState<RuleDialogInitialData | null>(null)
  const month = monthFromParam(searchParams.get('month'), thisMonth)
  const filter: CategorizationFilter = FILTERS.find((key) => key === searchParams.get('filter')) ?? 'all'
  useEffect(() => {
    if (searchParams.get('month') === month) return
    const params = new URLSearchParams(searchParams)
    params.set('month', month)
    setSearchParams(params, { replace: true })
  }, [month, searchParams, setSearchParams])
  const goToMonth = (next: string) => {
    const params = new URLSearchParams(searchParams)
    params.set('month', next)
    setSearchParams(params)
    setFollowUp(null)
  }
  const setFilter = (next: CategorizationFilter) => {
    const params = new URLSearchParams(searchParams)
    if (next === 'all') params.delete('filter')
    else params.set('filter', next)
    setSearchParams(params, { replace: true })
  }

  const noAccounts = activeAccountIds !== null && activeAccountIds.length === 0
  const listKey = ['transactions', 'categorization', month, activeAccountIds] as const
  const listQuery = useQuery({
    queryKey: listKey,
    queryFn: async () => {
      const { from, to } = monthRange(month)
      const rows: Transaction[] = []
      // A month rarely passes one page; the loop is for the one that does,
      // since totals over a partial month would be wrong, not just short.
      for (let page = 1; ; page++) {
        const result = await transactionsApi.list({
          from,
          to,
          account_ids: activeAccountIds ?? undefined,
          exclude_transfers: true,
          exclude_ignored: true,
          page,
          limit: PAGE_SIZE,
        })
        rows.push(...result.items)
        if (rows.length >= result.total || result.items.length === 0) break
      }
      // A row shared from someone else's workspace is theirs to categorize.
      return rows.filter((tx) => !tx.is_shared)
    },
    enabled: !noAccounts,
  })
  const rows = useMemo(() => (noAccounts ? [] : listQuery.data ?? []), [noAccounts, listQuery.data])

  const { data: categoryList = [] } = useQuery({ queryKey: ['categories'], queryFn: categoriesApi.list })
  const { data: groupList = [] } = useQuery<CategoryGroup[]>({ queryKey: ['categoryGroups'], queryFn: categoryGroupsApi.list })
  const { data: accountList = [] } = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi.list() })
  const showRules = hasModule('rules')
  const { data: ruleList = [] } = useQuery({ queryKey: ['rules'], queryFn: rulesApi.list, enabled: showRules })
  const { data: payeeList = [] } = useQuery({ queryKey: ['payees'], queryFn: payeesApi.list, enabled: ruleDraft !== null })

  const categoriesById = useMemo(() => new Map(categoryList.map((category) => [category.id, category])), [categoryList])
  const accountNames = useMemo(() => new Map(accountList.map((account) => [account.id, getAccountName(account)])), [accountList])
  const ruleNames = useMemo(() => new Map(ruleList.map((rule) => [rule.id, rule.name])), [ruleList])

  // One request for the whole month, not one per row.
  const uncategorizedIds = useMemo(() => rows.filter(isUncategorized).map((tx) => tx.id), [rows])
  const suggestionsQuery = useQuery({
    queryKey: ['transactions', 'category-suggestions', uncategorizedIds],
    queryFn: () => transactionsApi.categorySuggestions(uncategorizedIds),
    enabled: canWrite && uncategorizedIds.length > 0,
  })
  const suggestionsById = useMemo(
    () => new Map((suggestionsQuery.data ?? []).map((suggestion) => [suggestion.transaction_id, suggestion])),
    [suggestionsQuery.data],
  )

  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map((key) => [key, rows.filter((tx) => matchesFilter(tx, key)).length])) as Record<CategorizationFilter, number>,
    [rows],
  )
  const unknownCount = useMemo(() => rows.filter((tx) => provenanceOf(tx) === 'unknown').length, [rows])
  const totals = useMemo(() => categoryTotals(rows), [rows])
  const visible = useMemo(
    () => rows.filter((tx) => matchesFilter(tx, filter) && matchesSearch(tx, search)),
    [rows, filter, search],
  )
  const groups = useMemo(() => groupForReview(visible, uiLanguage), [visible, uiLanguage])

  const changeMutation = useMutation({
    mutationFn: ({ tx, categoryId, source }: { tx: Transaction; categoryId: string | null; source: 'manual' | 'suggestion' }) =>
      transactionsApi.bulkCategorize([tx.id], categoryId, source),
    onMutate: async ({ tx, categoryId, source }) => {
      // The row and the totals move at once; the refetch afterwards confirms.
      await queryClient.cancelQueries({ queryKey: listKey })
      const category = categoryId ? categoriesById.get(categoryId) ?? null : null
      queryClient.setQueryData<Transaction[]>(listKey, (current) => current?.map((row) => (
        row.id === tx.id
          ? { ...row, category_id: categoryId, category, category_source: categoryId ? source : null, category_rule_id: null }
          : row
      )))
      setFollowUp(categoryId ? { tx, from: tx.category, categoryId } : null)
    },
    onError: (error) => {
      setFollowUp(null)
      toast.error(extractApiError(error))
    },
    onSettled: () => invalidateFinancialQueries(queryClient),
  })
  const change = (tx: Transaction, categoryId: string | null, source: 'manual' | 'suggestion') => {
    if ((tx.category_id ?? null) === categoryId) return
    changeMutation.mutate({ tx, categoryId, source })
  }

  const createRuleMutation = useMutation({
    mutationFn: (data: Omit<Rule, 'id' | 'user_id'>) => rulesApi.create(data),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['rules'] })
      setRuleDraft(null)
      const applied = result.applied_count ?? 0
      if (applied > 0) {
        invalidateFinancialQueries(queryClient)
        toast.success(t('rules.createdAndApplied', { count: applied }))
      } else {
        toast.success(t('rules.created'))
      }
    },
    onError: (error: unknown) => {
      toast.error(isAxiosError(error) && error.response?.status === 409 ? t('rules.duplicateName') : extractApiError(error))
    },
  })

  const openRuleDialog = (change: FollowUp) => {
    const { tx, categoryId } = change
    const name = tx.payee_id ? tx.payee_name ?? tx.payee ?? tx.description : tx.description
    setRuleDraft({
      name: t('categorization.ruleName', { name, category: categoriesById.get(categoryId ?? '')?.name ?? '' }),
      conditions: tx.payee_id
        ? [{ field: 'payee_id', op: 'equals', value: tx.payee_id }]
        : [{ field: 'description', op: 'contains', value: tx.description }],
      actions: [{ op: 'set_category', value: categoryId ?? '' }],
    })
  }

  const title = monthLabel(month, uiLanguage).replace(/^\p{L}/u, (c) => c.toUpperCase())
  const loading = !noAccounts && listQuery.isLoading

  return (
    <div className="mx-auto max-w-4xl space-y-5 pb-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t('nav.categorization')}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{t('categorization.subtitle')}</p>
        </div>
        <nav className="flex items-center gap-2" aria-label={t('month.navigation')}>
          {month !== thisMonth && (
            <Button variant="outline" size="sm" className="h-10" onClick={() => goToMonth(thisMonth)}>
              {t('month.current')}
            </Button>
          )}
          <div className="flex items-center gap-0.5 rounded-lg border border-border bg-card p-1">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => goToMonth(shiftMonth(month, -1))} aria-label={t('month.previous')}>
              <ChevronLeft size={16} />
            </Button>
            <p className="min-w-32 px-1 text-center text-sm font-medium tabular-nums" aria-live="polite" data-testid="categorization-month">
              {title}
            </p>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => goToMonth(shiftMonth(month, 1))} aria-label={t('month.next')}>
              <ChevronRight size={16} />
            </Button>
          </div>
        </nav>
      </div>

      {loading ? (
        <div className="space-y-3" aria-busy="true" aria-label={t('common.loading')}>
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-10 w-72 rounded-lg" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      ) : listQuery.isError ? (
        <div role="alert" className="rounded-xl border border-border bg-card px-5 py-10 text-center shadow-sm">
          <p className="text-sm font-medium">{t('categorization.error')}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void listQuery.refetch()}>{t('common.retry')}</Button>
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-border bg-card px-5 py-12 text-center shadow-sm">
          <p className="text-sm font-medium">{t('categorization.empty.title')}</p>
          <p className="mx-auto mt-1 max-w-sm text-xs leading-5 text-muted-foreground">{t('categorization.empty.hint')}</p>
        </div>
      ) : (
        <>
          <TotalsSection totals={totals} rowCount={rows.length} money={money} moved={followUp} />

          {followUp && (
            <FollowUpPanel
              key={`${followUp.tx.id}:${followUp.categoryId}`}
              change={followUp}
              category={categoriesById.get(followUp.categoryId ?? '') ?? null}
              monthIds={new Set(rows.map((tx) => tx.id))}
              money={money}
              canCreateRule={showRules}
              onCreateRule={() => openRuleDialog(followUp)}
              onDismiss={() => setFollowUp(null)}
            />
          )}

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="-mx-1 overflow-x-auto px-1" role="group" aria-label={t('categorization.filterLabel')}>
              <Segmented
                value={filter}
                onChange={setFilter}
                testIdPrefix="categorization-filter"
                options={FILTERS.map((key) => ({ value: key, label: t(`categorization.filters.${key}`), count: counts[key] }))}
              />
            </div>
            <div className="relative sm:w-72">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('categorization.searchPlaceholder')}
                aria-label={t('categorization.searchPlaceholder')}
                className="h-10 pl-8"
              />
            </div>
          </div>

          {(filter === 'automatic' || filter === 'manual') && unknownCount > 0 && (
            <p className="text-xs text-muted-foreground">{t('categorization.unknownHint', { count: unknownCount })}</p>
          )}

          {groups.length === 0 ? (
            <div className="rounded-xl border border-border bg-card px-5 py-10 text-center shadow-sm">
              <p className="text-sm font-medium">
                {filter === 'uncategorized' && !search.trim() ? t('categorization.emptyFilter.uncategorized') : t('categorization.emptyFilter.other')}
              </p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
              {groups.map((group) => {
                const headingId = `categorization-group-${group.key || 'none'}`
                const groupTotal = group.rows.reduce((sum, tx) => sum + signedPrimary(tx), 0)
                return (
                  <section key={group.key} aria-labelledby={headingId} className="border-b border-border last:border-b-0">
                    <div className="flex items-center justify-between gap-3 bg-muted/40 px-4 py-2 sm:px-5">
                      <h2 id={headingId} className="flex min-w-0 items-center gap-2 text-xs font-semibold">
                        {group.category && <CategoryIcon icon={group.category.icon} color={group.category.color} size="xs" />}
                        <span className="truncate">
                          {group.split ? t('categorization.split') : group.category?.name ?? t('categorization.uncategorized')}
                        </span>
                      </h2>
                      <p className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {t('categorization.rowCount', { count: group.rows.length })} · {money(groupTotal)}
                      </p>
                    </div>
                    <ul className="divide-y divide-border">
                      {group.rows.map((tx) => (
                        <ReviewRow
                          key={tx.id}
                          tx={tx}
                          accountName={tx.account_id ? accountNames.get(tx.account_id) ?? null : null}
                          ruleName={tx.category_rule_id ? ruleNames.get(tx.category_rule_id) ?? null : null}
                          suggestion={canWrite ? suggestionsById.get(tx.id) ?? null : null}
                          suggestedCategory={categoriesById.get(suggestionsById.get(tx.id)?.category_id ?? '') ?? null}
                          categories={categoryList}
                          groups={groupList}
                          canWrite={canWrite}
                          dateLocale={dateLocale}
                          locale={locale}
                          onChange={change}
                        />
                      ))}
                    </ul>
                  </section>
                )
              })}
            </div>
          )}
        </>
      )}

      {ruleDraft && (
        <RuleDialog
          open
          onClose={() => setRuleDraft(null)}
          rule={null}
          categories={categoryList}
          categoryGroups={groupList}
          accounts={accountList}
          payees={payeeList}
          onSave={(data) => createRuleMutation.mutate(data as Omit<Rule, 'id' | 'user_id'>)}
          loading={createRuleMutation.isPending}
          initialData={ruleDraft}
        />
      )}
    </div>
  )
}

/** The month per category, small enough to sit above the list: a change
 *  below moves money between two of these, and both are marked. */
function TotalsSection({ totals, rowCount, money, moved }: {
  totals: CategoryTotal[]
  rowCount: number
  money: Money
  moved: FollowUp | null
}) {
  const { t } = useTranslation()
  const movedKeys = moved ? new Set([moved.from?.id ?? '', moved.categoryId ?? '']) : null
  return (
    <section aria-labelledby="categorization-totals-title" className="rounded-xl border border-border bg-card p-4 shadow-sm sm:px-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="categorization-totals-title" className="text-sm font-semibold">{t('categorization.totals.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('categorization.rowCount', { count: rowCount })}</p>
      </div>
      <ul className="mt-3 flex flex-wrap gap-2">
        {totals.map((entry) => (
          <li
            key={entry.key}
            data-testid={`category-total-${entry.key || 'none'}`}
            data-moved={movedKeys?.has(entry.key) ? 'true' : undefined}
            className={cn(
              'inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors duration-200',
              entry.key === '' ? 'border-dashed border-border' : 'border-border',
              movedKeys?.has(entry.key) && 'border-primary/50 bg-primary/5',
            )}
          >
            {entry.category ? (
              <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: entry.category.color || '#6B7280' }} aria-hidden="true" />
            ) : null}
            <span className="truncate">{entry.category?.name ?? t('categorization.uncategorized')}</span>
            <span className={cn('font-medium tabular-nums', entry.total < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400')}>
              {money(entry.total)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function ReviewRow({ tx, accountName, ruleName, suggestion, suggestedCategory, categories, groups, canWrite, dateLocale, locale, onChange }: {
  tx: Transaction
  accountName: string | null
  ruleName: string | null
  suggestion: CategorySuggestion | null
  suggestedCategory: Category | null
  categories: Category[]
  groups: CategoryGroup[]
  canWrite: boolean
  dateLocale: string
  locale: string
  onChange: (tx: Transaction, categoryId: string | null, source: 'manual' | 'suggestion') => void
}) {
  const { t } = useTranslation()
  const { mask } = usePrivacyMode()
  const provenance = provenanceOf(tx)
  const ProvenanceIcon = PROVENANCE_ICON[provenance]
  const payee = tx.payee_name ?? tx.payee
  const where = [accountName, tx.card_last4 ? `•••• ${tx.card_last4}` : null].filter(Boolean).join(' ')
  const provenanceLabel = provenance === 'rule'
    ? ruleName ? t('categorization.source.ruleNamed', { name: ruleName }) : t('categorization.source.rule')
    : t(`categorization.source.${provenance}`)

  return (
    <li className="px-4 py-3 sm:px-5" data-testid={`categorization-row-${tx.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{tx.description}</p>
          <p className="truncate text-xs text-muted-foreground">
            <time dateTime={tx.date}>{formatDayMonth(tx.date, dateLocale)}</time>
            {payee && <> · {payee}</>}
            {where && <> · {where}</>}
          </p>
        </div>
        <p className={cn('shrink-0 text-sm font-semibold tabular-nums', tx.type === 'debit' ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400')}>
          {mask(formatSignedAmount(Number(tx.amount), tx.type, tx.currency, locale))}
        </p>
      </div>

      <div className="mt-2 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
        {tx.has_category_lines ? (
          <p className="text-xs">
            {(tx.category_lines ?? []).map((line) => line.category?.name).filter(Boolean).join(' + ')}
            <span className="ml-2 text-muted-foreground">{t('categorization.splitHint')}</span>
          </p>
        ) : (
          <CategorySelect
            value={tx.category_id ?? ''}
            onChange={(next) => onChange(tx, next || null, 'manual')}
            categories={categories}
            groups={groups}
            currentCategory={tx.category}
            allowNone
            disabled={!canWrite}
            placeholder={t('categorization.uncategorized')}
            aria-label={t('categorization.categoryOf', {
              description: tx.description,
              category: tx.category?.name ?? t('categorization.uncategorized'),
            })}
            className="w-full sm:w-60"
          />
        )}
        <p className={cn('inline-flex items-center gap-1 text-xs', provenance === 'uncategorized' ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground')}>
          <ProvenanceIcon size={12} aria-hidden="true" />
          {provenanceLabel}
        </p>
      </div>

      {suggestion && suggestedCategory && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg bg-muted/60 px-3 py-2 text-xs">
          <Lightbulb size={12} className="text-muted-foreground" aria-hidden="true" />
          <span>{t('categorization.suggestion')}</span>
          <span className="inline-flex items-center gap-1 font-medium">
            <span className="size-2 rounded-full" style={{ backgroundColor: suggestedCategory.color || '#6B7280' }} aria-hidden="true" />
            {suggestedCategory.name}
          </span>
          <span className="text-muted-foreground">
            {t(`categorization.suggestionBasis.${suggestion.matched_by}`, { count: suggestion.uses })}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-8"
            onClick={() => onChange(tx, suggestion.category_id, 'suggestion')}
            aria-label={t('categorization.acceptLabel', { category: suggestedCategory.name, description: tx.description })}
          >
            {t('categorization.accept')}
          </Button>
        </div>
      )}
    </li>
  )
}

/** What a change can still do: reach the payee's other rows, here and in
 *  other months, and become a rule. Counted before anything is applied. */
function FollowUpPanel({ change, category, monthIds, money, canCreateRule, onCreateRule, onDismiss }: {
  change: FollowUp
  category: Category | null
  monthIds: ReadonlySet<string>
  money: Money
  canCreateRule: boolean
  onCreateRule: () => void
  onDismiss: () => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { tx, from, categoryId } = change
  const similarQuery = useQuery({
    queryKey: ['transactions', 'similar', tx.id],
    queryFn: () => transactionsApi.similar(tx.id),
  })
  const pending = similarQuery.data ? pendingLookalikes(similarQuery.data, categoryId, monthIds) : null
  const applyMutation = useMutation({
    mutationFn: (ids: string[]) => transactionsApi.bulkCategorize(ids, categoryId, 'manual'),
    onSuccess: (result) => {
      toast.success(t('categorization.followUp.applied', { count: result.updated }))
    },
    onError: (error) => toast.error(extractApiError(error)),
    onSettled: () => invalidateFinancialQueries(queryClient),
  })
  const keyName = tx.payee_id ? tx.payee_name ?? tx.payee ?? tx.description : tx.description
  const toName = category?.name ?? ''
  const fromName = from?.name ?? t('categorization.uncategorized')

  return (
    <section aria-labelledby="categorization-follow-up-title" className="rounded-xl border border-border bg-card p-4 shadow-sm sm:px-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <h2 id="categorization-follow-up-title" className="truncate text-sm font-semibold">{tx.description}</h2>
          <p role="status" className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            <span className="tabular-nums">{money(Math.abs(signedPrimary(tx)))}</span>
            <span>{fromName}</span>
            <ArrowRight size={12} aria-label={t('categorization.followUp.movedTo')} />
            <span className="font-medium text-foreground">{toName}</span>
          </p>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onDismiss} aria-label={t('categorization.followUp.dismiss')}>
          <X size={16} />
        </Button>
      </div>

      <div className="mt-3 space-y-2">
        <p className="text-xs text-muted-foreground">
          {tx.payee_id
            ? t('categorization.followUp.samePayee', { name: keyName })
            : t('categorization.followUp.sameDescription', { name: keyName })}
        </p>
        {similarQuery.isLoading ? (
          <Skeleton className="h-9 w-64 rounded-md" />
        ) : similarQuery.isError || !pending ? (
          <p className="text-xs">
            {t('categorization.followUp.error')}{' '}
            <button type="button" className="font-medium underline underline-offset-2" onClick={() => void similarQuery.refetch()}>
              {t('common.retry')}
            </button>
          </p>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            {pending.month.length > 0 ? (
              <Button size="sm" className="h-9" disabled={applyMutation.isPending} onClick={() => applyMutation.mutate(pending.month)}>
                {t('categorization.followUp.applyMonth', { count: pending.month.length })}
              </Button>
            ) : (
              <p className="text-xs">{t('categorization.followUp.noneMonth')}</p>
            )}
            {pending.all.length > pending.month.length && (
              <Button size="sm" variant="outline" className="h-9" disabled={applyMutation.isPending} onClick={() => applyMutation.mutate(pending.all)}>
                {t('categorization.followUp.applyAll', { count: pending.all.length })}
              </Button>
            )}
            {canCreateRule && (
              <Button size="sm" variant="ghost" className="h-9" onClick={onCreateRule}>
                <SlidersHorizontal size={14} aria-hidden="true" />
                {t('categorization.followUp.createRule')}
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
