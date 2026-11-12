import { useState, useEffect, useEffectEvent, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { PluggyConnect } from 'react-pluggy-connect'
import { connections } from '@/lib/api'
import { invalidateFinancialQueries } from '@/lib/invalidate-queries'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'

type ConnectPhase = 'idle' | 'processing' | 'success' | 'error'

interface BankConnectDialogProps {
  open: boolean
  onClose: () => void
  reconnectConnectionId?: string
  updateItemId?: string
  provider?: string
  supportsAssetSync?: boolean
}

export function BankConnectDialog({
  open,
  onClose,
  reconnectConnectionId,
  updateItemId,
  provider = 'pluggy',
  supportsAssetSync = false,
}: BankConnectDialogProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [connectToken, setConnectToken] = useState<string | null>(null)
  const [syncAssets, setSyncAssets] = useState(true)
  const [optionsConfirmed, setOptionsConfirmed] = useState(false)
  const [phase, setPhase] = useState<ConnectPhase>('idle')
  const [connectedInstitution, setConnectedInstitution] = useState('')
  const completingRef = useRef(false)
  // Only prompt for asset-sync when the provider actually imports holdings.
  const needsInitialOptions = !reconnectConnectionId && supportsAssetSync

  const onTokenError = useEffectEvent(() => {
    toast.error(t('accounts.connectError'))
    onClose()
  })

  useEffect(() => {
    if (!open) {
      // Reset the state machine between distinct dialog sessions.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConnectToken(null)
      setSyncAssets(true)
      setOptionsConfirmed(false)
      setPhase('idle')
      setConnectedInstitution('')
      completingRef.current = false
      return
    }

    if (needsInitialOptions && !optionsConfirmed) return

    let cancelled = false
    const fetchToken = async () => {
      try {
        const token = reconnectConnectionId
          ? await connections.getReconnectToken(reconnectConnectionId)
          : await connections.getConnectToken(provider)
        if (!cancelled) setConnectToken(token)
      } catch {
        if (!cancelled) {
          onTokenError()
        }
      }
    }
    fetchToken()

    return () => { cancelled = true }
  }, [open, reconnectConnectionId, provider, needsInitialOptions, optionsConfirmed])

  const handleSuccess = async (data: { item: { id: string } }) => {
    completingRef.current = true
    setConnectToken(null)
    setPhase('processing')
    try {
      let result
      if (reconnectConnectionId) {
        result = await connections.sync(reconnectConnectionId)
      } else {
        result = await connections.handleCallback(
          data.item.id,
          provider,
          undefined,
          supportsAssetSync ? { sync_assets: syncAssets } : undefined,
        )
      }
      invalidateFinancialQueries(queryClient)
      queryClient.invalidateQueries({ queryKey: ['connections'] })
      setConnectedInstitution(result.institution_name || '')
      setPhase('success')
    } catch {
      setPhase('error')
    }
  }

  const handleClose = () => {
    completingRef.current = false
    setConnectToken(null)
    setPhase('idle')
    onClose()
  }

  const handleWidgetClose = () => {
    if (!completingRef.current) handleClose()
  }

  if (open && needsInitialOptions && !optionsConfirmed) {
    return (
      <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('connections.initialSyncSettings')}</DialogTitle>
            <p className="text-sm text-muted-foreground">{t('connections.initialSyncSettingsDesc')}</p>
          </DialogHeader>
          <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
            <div className="space-y-1">
              <Label htmlFor="initial-sync-assets">{t('connections.syncAssets')}</Label>
              <p className="text-xs text-muted-foreground">{t('connections.syncAssetsHint')}</p>
            </div>
            <input
              id="initial-sync-assets"
              type="checkbox"
              checked={syncAssets}
              onChange={(e) => setSyncAssets(e.target.checked)}
              className="mt-1 h-4 w-4 rounded border-border text-primary focus:ring-primary"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleClose}>{t('common.cancel')}</Button>
            <Button onClick={() => setOptionsConfirmed(true)}>{t('connections.continueToConnector')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  if (open && phase !== 'idle') {
    const isProcessing = phase === 'processing'
    const isSuccess = phase === 'success'
    return (
      <Dialog open={open} onOpenChange={(value) => !value && !isProcessing && handleClose()}>
        <DialogContent className="sm:max-w-md" showCloseButton={!isProcessing}>
          <DialogHeader>
            <div className="flex items-center gap-3">
              {isProcessing ? (
                <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden="true" />
              ) : isSuccess ? (
                <CheckCircle2 className="h-6 w-6 text-emerald-500" aria-hidden="true" />
              ) : (
                <AlertCircle className="h-6 w-6 text-destructive" aria-hidden="true" />
              )}
              <DialogTitle>
                {t(`connections.connectStatus.${phase}Title`)}
              </DialogTitle>
            </div>
            <DialogDescription className="pt-2">
              {t(`connections.connectStatus.${phase}Description`, {
                institution: connectedInstitution,
              })}
            </DialogDescription>
          </DialogHeader>
          {!isProcessing && (
            <DialogFooter>
              <Button onClick={handleClose}>{t('common.close')}</Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    )
  }

  if (!open || !connectToken) return null

  return (
    <PluggyConnect
      connectToken={connectToken}
      updateItem={updateItemId}
      onSuccess={handleSuccess}
      onClose={handleWidgetClose}
      onError={() => {
        completingRef.current = true
        setConnectToken(null)
        setPhase('error')
      }}
    />
  )
}
