import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { useWorkspace } from '@/contexts/workspace-context'
import { connections } from '@/lib/api'
import { invalidateFinancialQueries } from '@/lib/invalidate-queries'
import type { BankConnection } from '@/types'

const SYNC_ALL_KEY = ['connections', 'sync-all'] as const

/**
 * Connections the header button pulls without the user stepping in: active
 * ones, and errored ones that a plain retry may fix. Expired ones need the
 * user to reconnect, so they are left to their own row.
 */
export function isSyncableConnection(conn: BankConnection): boolean {
  return conn.status === 'active' || conn.status === 'error'
}

/** True while a "sync all" run started from any page is in flight. */
export function useSyncAllPending(): boolean {
  return useIsMutating({ mutationKey: SYNC_ALL_KEY }) > 0
}

/**
 * Header button that asks the bank of every syncable connection for fresh
 * data, one connection at a time so a bank is never hit by parallel
 * refreshes. Renders nothing for read-only members or when no connection
 * can sync.
 */
export function SyncAllConnectionsButton({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslation()
  const { canWrite } = useWorkspace()
  const queryClient = useQueryClient()
  const { data: connectionsList } = useQuery({
    queryKey: ['connections'],
    queryFn: connections.list,
    enabled: canWrite,
  })
  const syncable = (connectionsList ?? []).filter(isSyncableConnection)

  const syncAll = useMutation({
    mutationKey: SYNC_ALL_KEY,
    mutationFn: async (ids: string[]) => {
      const outcome = { synced: 0, rateLimited: 0, failed: 0 }
      for (const id of ids) {
        try {
          const result = await connections.sync(id)
          if (result.sync_outcome === 'rate_limited') outcome.rateLimited += 1
          else outcome.synced += 1
        } catch {
          outcome.failed += 1
        }
      }
      return outcome
    },
    onSuccess: (outcome) => {
      if (outcome.rateLimited === 0 && outcome.failed === 0) {
        toast.success(t('accounts.syncAllDone', { count: outcome.synced }))
      } else {
        toast.warning(t('accounts.syncAllPartial', outcome))
      }
    },
    onSettled: () => {
      invalidateFinancialQueries(queryClient)
      queryClient.invalidateQueries({ queryKey: ['connections'] })
    },
  })
  const running = useSyncAllPending()

  if (!canWrite || syncable.length === 0) return null

  return (
    <Button
      variant="outline"
      className="gap-1.5"
      disabled={disabled || running}
      onClick={() => syncAll.mutate(syncable.map((conn) => conn.id))}
      aria-label={t('accounts.syncAll')}
      title={t('accounts.syncAll')}
    >
      <RefreshCw size={16} className={running ? 'animate-spin' : ''} />
      <span className="hidden sm:inline">{t('accounts.syncAll')}</span>
    </Button>
  )
}
