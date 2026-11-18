import { useQuery } from '@tanstack/react-query'

import { reconciliation } from '@/lib/api'

/** How many reconciliation questions are waiting, for the navigation badge
 *  and the Conciliações page header.
 *
 *  Keyed under `reconciliation-suggestions` on purpose: everything that
 *  answers or raises a question already invalidates that prefix, so the
 *  badge follows an accept or a decline without each caller having to know
 *  it exists. */
export const PENDING_RECONCILIATION_COUNT_KEY = ['reconciliation-suggestions', 'count'] as const

export function usePendingReconciliationCount(enabled = true) {
  return useQuery({
    queryKey: PENDING_RECONCILIATION_COUNT_KEY,
    queryFn: reconciliation.suggestionCount,
    enabled,
  })
}
