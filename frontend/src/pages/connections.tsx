import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { Plus, RefreshCw, Settings, TriangleAlert, Unlink } from 'lucide-react'
import { toast } from 'sonner'
import { accounts, connections } from '@/lib/api'
import { getAccountName } from '@/lib/account-utils'
import { getAccountTypeConfig } from '@/lib/account-type-config'
import { getConnectionName } from '@/lib/connection-utils'
import { invalidateFinancialQueries } from '@/lib/invalidate-queries'
import { useDateLocale } from '@/hooks/use-display-locale'
import { useCollectionFilter } from '@/contexts/collection-filter-context'
import { useWorkspace } from '@/contexts/workspace-context'
import type { BankConnection } from '@/types'
import { AccountIcon, ConnectionLogo } from '@/components/account-icon'
import { PageHeader } from '@/components/page-header'
import { PageRefreshButton } from '@/components/page-refresh-button'
import {
  SyncAllConnectionsButton,
  isSyncableConnection,
  useSyncAllPending,
} from '@/components/sync-all-connections-button'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { BankConnectDialog } from '@/components/bank-connect-dialog'
import { ConnectorSelectDialog, type Provider } from '@/components/connector-select-dialog'
import { OAuthConnectDialog } from '@/components/oauth-connect-dialog'
import { TokenConnectDialog } from '@/components/token-connect-dialog'
import { ConnectionSettingsDialog } from '@/components/connection-settings-dialog'

/**
 * Bank integrations (Pluggy and the other providers): connect, sync,
 * reconnect, configure and disconnect. Accounts and cards are listed under
 * the connection they came from, but managed on their own pages.
 */
export default function ConnectionsPage() {
  const { t } = useTranslation()
  const dateLocale = useDateLocale()
  const { activeAccountIds } = useCollectionFilter()
  const { canWrite } = useWorkspace()
  const queryClient = useQueryClient()
  const [connectorSelectOpen, setConnectorSelectOpen] = useState(false)
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null)
  const [settingsConnection, setSettingsConnection] = useState<BankConnection | null>(null)
  const [disconnectingConnection, setDisconnectingConnection] = useState<BankConnection | null>(null)
  const [reconnectConnId, setReconnectConnId] = useState<string | null>(null)
  const [reconnectItemId, setReconnectItemId] = useState<string | null>(null)
  const [tokenReconnectConnection, setTokenReconnectConnection] = useState<BankConnection | null>(null)

  const { data: accountsList, isFetching: accountsFetching } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => accounts.list(),
  })
  const { data: connectionsList, isLoading } = useQuery({
    queryKey: ['connections'],
    queryFn: connections.list,
  })
  const { data: providersList } = useQuery({
    queryKey: ['connections', 'providers'],
    queryFn: connections.getProviders,
    staleTime: 1000 * 60 * 10,
  })

  const providersByName = useMemo(() => {
    const map = new Map<string, Provider>()
    for (const p of providersList ?? []) map.set(p.name, p as Provider)
    return map
  }, [providersList])

  const handleReconnectClick = async (conn: BankConnection) => {
    const providerInfo = providersByName.get(conn.provider)
    if (providerInfo?.flow_type === 'oauth') {
      try {
        const url = await connections.getReauthUrl(conn.id)
        window.location.assign(url)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        toast.error(message || t('accounts.connectError'))
      }
      return
    }
    if (providerInfo?.flow_type === 'token') {
      setTokenReconnectConnection(conn)
      return
    }
    // Widget flow (Pluggy): re-open the widget with the existing item_id.
    setReconnectConnId(conn.id)
    setReconnectItemId(conn.external_id)
  }

  const syncMutation = useMutation({
    mutationFn: (id: string) => connections.sync(id),
    onSuccess: (result) => {
      invalidateFinancialQueries(queryClient)
      queryClient.invalidateQueries({ queryKey: ['connections'] })
      // The provider can throttle the sync (429) and still return success
      // without pulling anything: say so instead of a false "Sync completed".
      if (result.sync_outcome === 'rate_limited') {
        toast.warning(t('accounts.syncRateLimited'))
      } else {
        toast.success(t('accounts.syncDone'))
      }
      const merged = result?.merged_count
      if (merged && merged > 0) {
        toast.info(t('accounts.mergedCount', { count: merged }))
      }
    },
    onError: (err) => {
      queryClient.invalidateQueries({ queryKey: ['connections'] })
      const detail = axios.isAxiosError(err) ? err.response?.data?.detail : null
      const message = typeof detail === 'string' ? detail : detail?.message
      toast.error(message || t('accounts.syncError'))
    },
  })

  const syncableConnections = (connectionsList ?? []).filter(isSyncableConnection)
  const syncAllPending = useSyncAllPending()

  const disconnectMutation = useMutation({
    mutationFn: (id: string) => connections.delete(id),
    onSuccess: () => {
      invalidateFinancialQueries(queryClient)
      queryClient.invalidateQueries({ queryKey: ['connections'] })
      queryClient.invalidateQueries({ queryKey: ['assets'] })
      queryClient.invalidateQueries({ queryKey: ['asset-groups'] })
      queryClient.invalidateQueries({ queryKey: ['portfolio-trend'] })
      setDisconnectingConnection(null)
      toast.success(t('accounts.disconnected'))
    },
  })

  const inActiveCollection = (id: string) => !activeAccountIds || activeAccountIds.includes(id)

  return (
    <div className="space-y-6">
      <PageHeader
        section={t('nav.connections')}
        title={t('nav.connections')}
        action={
          <div className="flex items-center gap-2">
            {canWrite && syncableConnections.length > 0 ? (
              <SyncAllConnectionsButton disabled={syncMutation.isPending} />
            ) : (
              <PageRefreshButton
                onRefresh={() => queryClient.refetchQueries({ type: 'active' })}
                refreshing={accountsFetching}
              />
            )}
            {canWrite && (
              <Button className="gap-1.5" onClick={() => setConnectorSelectOpen(true)}>
                <Plus size={16} />
                {t('accounts.connectBank')}
              </Button>
            )}
          </div>
        }
      />

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
        </div>
      ) : connectionsList && connectionsList.length > 0 ? (
        <div className="space-y-3">
          {connectionsList.map((conn) => {
            const connAccounts = (accountsList ?? []).filter(
              (a) => a.connection_id === conn.id && inActiveCollection(a.id),
            )
            const needsReconnect = conn.status !== 'active'
            // An error state does not always mean the token is dead: an
            // upstream auth issue can be fixed without re-pasting, so the
            // row offers a plain retry next to the reconnect action.
            const canRetrySync = conn.status === 'error'
            const syncPending = (syncMutation.isPending && syncMutation.variables === conn.id)
              || (syncAllPending && isSyncableConnection(conn))
            return (
              <div key={conn.id} className="bg-card rounded-xl border border-border shadow-sm">
                <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
                  <div className="flex items-center gap-3">
                    {/* One bank's favicon would misrepresent a multi-
                        institution link — fall back to the generic icon. */}
                    <ConnectionLogo
                      logoUrl={(conn.institutions?.length ?? 0) > 1 ? null : conn.logo_url}
                    />
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-foreground">{getConnectionName(conn, t)}</p>
                        <Badge
                          variant={conn.status === 'active' ? 'default' : 'secondary'}
                          className={
                            conn.status === 'active'
                              ? 'text-[10px] px-1.5 py-0 h-4'
                              : 'text-[10px] px-1.5 py-0 h-4 border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                          }
                        >
                          {t(`accounts.connectionStatus.${conn.status}`, conn.status)}
                        </Badge>
                      </div>
                      {conn.last_sync_at && (
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          {t('accounts.lastSync')}: {new Date(conn.last_sync_at).toLocaleString(dateLocale)}
                        </p>
                      )}
                    </div>
                  </div>
                  {canWrite && (
                    <div className="flex items-center gap-1.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                        onClick={() => setSettingsConnection(conn)}
                        title={t('connections.settings')}
                      >
                        <Settings size={14} />
                      </Button>
                      {canRetrySync && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                          onClick={() => syncMutation.mutate(conn.id)}
                          disabled={syncPending}
                          title={t('accounts.retrySync')}
                          aria-label={t('accounts.retrySync')}
                        >
                          <RefreshCw size={14} className={syncPending ? 'animate-spin' : ''} />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className={needsReconnect
                          ? 'relative h-8 w-8 p-0 text-amber-500 hover:bg-amber-500/10 hover:text-amber-600 dark:text-amber-400 dark:hover:text-amber-300'
                          : 'h-8 w-8 p-0 text-muted-foreground hover:text-foreground'}
                        onClick={() => needsReconnect ? handleReconnectClick(conn) : syncMutation.mutate(conn.id)}
                        disabled={syncPending}
                        title={needsReconnect
                          ? conn.status === 'expired'
                            ? t('accounts.connectionExpired')
                            : t('accounts.connectionError')
                          : t('accounts.sync')}
                        aria-label={needsReconnect ? t('accounts.reconnect') : t('accounts.sync')}
                      >
                        <RefreshCw size={14} className={syncPending ? 'animate-spin' : ''} />
                        {needsReconnect && (
                          <TriangleAlert
                            size={10}
                            className="absolute -right-0.5 -top-0.5 rounded-full bg-card text-amber-500"
                          />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0 text-muted-foreground hover:text-rose-500"
                        onClick={() => setDisconnectingConnection(conn)}
                        disabled={disconnectMutation.isPending}
                        title={t('accounts.disconnect')}
                      >
                        <Unlink size={14} />
                      </Button>
                    </div>
                  )}
                </div>
                {connAccounts.length > 0 ? (
                  <div className="divide-y divide-muted">
                    {connAccounts.map((acc) => (
                      <Link
                        key={acc.id}
                        to={acc.type === 'credit_card' ? '/cards' : `/accounts/${acc.id}`}
                        className="flex items-center gap-3 px-5 py-2.5 hover:bg-muted/50 transition-colors"
                      >
                        <AccountIcon account={acc} />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-foreground truncate">{getAccountName(acc)}</p>
                          <p className="text-xs text-muted-foreground">{t(getAccountTypeConfig(acc.type).label)}</p>
                        </div>
                      </Link>
                    ))}
                  </div>
                ) : (
                  <div className="px-5 py-4">
                    <p className="text-sm text-muted-foreground">
                      {t(activeAccountIds ? 'accounts.emptyFiltered' : 'accounts.noAccountsFound')}
                    </p>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <div className="bg-card rounded-xl border border-dashed border-border p-8 text-center">
          <p className="text-sm text-muted-foreground">{t('accounts.noBankConnections')}</p>
        </div>
      )}

      {/* Confirm disconnect dialog */}
      <Dialog open={!!disconnectingConnection} onOpenChange={() => setDisconnectingConnection(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('accounts.confirmDisconnectTitle')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t('accounts.confirmDisconnectDesc', { institution: disconnectingConnection ? getConnectionName(disconnectingConnection, t) : '' })}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisconnectingConnection(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => disconnectingConnection && disconnectMutation.mutate(disconnectingConnection.id)}
              disabled={disconnectMutation.isPending}
            >
              {disconnectMutation.isPending ? t('common.loading') : t('accounts.disconnect')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Connector Select Dialog */}
      <ConnectorSelectDialog
        open={connectorSelectOpen}
        onClose={() => setConnectorSelectOpen(false)}
        onSelect={(provider) => setSelectedProvider(provider)}
      />

      {/* Bank Connect Dialog — widget-based (Pluggy) */}
      <BankConnectDialog
        open={!!selectedProvider && selectedProvider.flow_type === 'widget'}
        onClose={() => setSelectedProvider(null)}
        provider={selectedProvider?.name}
        supportsAssetSync={selectedProvider?.supports_asset_sync ?? false}
      />

      {/* OAuth Connect Dialog — institution-pickers (Enable Banking) */}
      <OAuthConnectDialog
        open={!!selectedProvider && selectedProvider.flow_type === 'oauth'}
        onClose={() => setSelectedProvider(null)}
        provider={selectedProvider?.name ?? ''}
        supportsAssetSync={selectedProvider?.supports_asset_sync ?? false}
      />

      {/* Token Connect Dialog — paste-a-token flow (SimpleFIN) */}
      <TokenConnectDialog
        open={!!selectedProvider && selectedProvider.flow_type === 'token'}
        onClose={() => setSelectedProvider(null)}
        provider={selectedProvider?.name ?? ''}
        supportsAssetSync={selectedProvider?.supports_asset_sync ?? false}
      />

      {/* Reconnect Dialog — widget-based (Pluggy) */}
      <BankConnectDialog
        open={!!reconnectConnId}
        onClose={() => { setReconnectConnId(null); setReconnectItemId(null) }}
        reconnectConnectionId={reconnectConnId ?? undefined}
        updateItemId={reconnectItemId ?? undefined}
      />

      {/* Reconnect Dialog — paste-a-token flow (SimpleFIN) */}
      <TokenConnectDialog
        open={!!tokenReconnectConnection}
        onClose={() => setTokenReconnectConnection(null)}
        provider={tokenReconnectConnection?.provider ?? ''}
        reconnectConnectionId={tokenReconnectConnection?.id}
      />

      {/* Connection Settings Dialog */}
      <ConnectionSettingsDialog
        open={!!settingsConnection}
        onClose={() => setSettingsConnection(null)}
        connection={settingsConnection}
        supportsAssetSync={
          settingsConnection
            ? providersByName.get(settingsConnection.provider)?.supports_asset_sync ?? false
            : false
        }
      />
    </div>
  )
}
