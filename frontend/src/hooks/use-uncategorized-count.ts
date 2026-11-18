import { useQuery } from '@tanstack/react-query'

import { transactions } from '@/lib/api'
import { monthRange } from '@/lib/month-utils'

/** How many of a month's transactions have no category, for the
 *  Categorizações navigation badge.
 *
 *  The same filters the page lists with (no transfers, no ignored rows), read
 *  from the list's own total so the two never disagree on what counts.
 *  Keyed under `transactions` on purpose: every mutation that can categorize
 *  a row already invalidates that prefix (see `invalidateFinancialQueries`),
 *  so the badge follows a change made on any page. */
export function useUncategorizedCount(month: string, enabled = true) {
  return useQuery({
    queryKey: ['transactions', 'uncategorized-count', month],
    queryFn: async () => {
      const { from, to } = monthRange(month)
      const page = await transactions.list({
        from,
        to,
        uncategorized: true,
        exclude_transfers: true,
        exclude_ignored: true,
        limit: 1,
      })
      return page.total
    },
    enabled,
  })
}
