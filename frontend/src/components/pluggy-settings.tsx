import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Landmark, Save, TestTube2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { admin } from '@/lib/api'

export function PluggySettings() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [clientIdDraft, setClientIdDraft] = useState<string>()
  const [clientSecret, setClientSecret] = useState('')

  const settingQuery = useQuery({
    queryKey: ['admin', 'integrations', 'pluggy'],
    queryFn: admin.pluggySetting,
  })

  const saveMutation = useMutation({
    mutationFn: () => admin.updatePluggySetting({
      client_id: (clientIdDraft ?? settingQuery.data?.client_id ?? '').trim(),
      ...(clientSecret ? { client_secret: clientSecret } : {}),
    }),
    onSuccess: (setting) => {
      queryClient.setQueryData(['admin', 'integrations', 'pluggy'], setting)
      void queryClient.invalidateQueries({ queryKey: ['connections', 'providers'] })
      setClientSecret('')
      setClientIdDraft(undefined)
      toast.success(t('admin.settings.pluggySaved'))
    },
    onError: () => toast.error(t('admin.settings.pluggySaveError')),
  })

  const testMutation = useMutation({
    mutationFn: () => admin.testPluggySetting({
      client_id: (clientIdDraft ?? settingQuery.data?.client_id ?? '').trim(),
      ...(clientSecret ? { client_secret: clientSecret } : {}),
    }),
    onSuccess: () => toast.success(t('admin.settings.pluggyTestSuccess')),
    onError: () => toast.error(t('admin.settings.pluggyTestError')),
  })

  const setting = settingQuery.data
  const clientId = clientIdDraft ?? setting?.client_id ?? ''
  const busy = saveMutation.isPending || testMutation.isPending

  return (
    <section className="mb-8 rounded-xl border border-border/60 bg-card overflow-hidden">
      <div className="px-5 py-4 border-b border-border/40 flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 mb-0.5">
            <Landmark size={15} className="text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">
              {t('admin.settings.pluggyTitle')}
            </h2>
            {setting?.configured && (
              <Badge variant="secondary" className="gap-1 text-[10px]">
                <CheckCircle2 size={11} /> {t('admin.settings.pluggyConfigured')}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{t('admin.settings.pluggyDescription')}</p>
        </div>
      </div>
      <div className="p-5">
        {settingQuery.isError ? (
          <div role="alert" className="flex items-center gap-3 text-sm text-destructive">
            <span>{t('common.error')}</span>
            <Button variant="outline" size="sm" onClick={() => settingQuery.refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : !setting ? (
          <p role="status" className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : (
          <div className="space-y-4 max-w-2xl">
            {setting.source === 'environment' && (
              <p className="text-xs text-muted-foreground">{t('admin.settings.pluggyEnvironment')}</p>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="pluggy-client-id">{t('admin.settings.pluggyClientId')}</Label>
              <Input
                id="pluggy-client-id"
                value={clientId}
                onChange={(event) => setClientIdDraft(event.target.value)}
                autoComplete="off"
                disabled={busy}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pluggy-client-secret">{t('admin.settings.pluggyClientSecret')}</Label>
              <Input
                id="pluggy-client-secret"
                type="password"
                value={clientSecret}
                onChange={(event) => setClientSecret(event.target.value)}
                placeholder={setting.has_secret ? t('admin.settings.pluggySecretSaved') : ''}
                autoComplete="new-password"
                disabled={busy}
              />
              <p className="text-xs text-muted-foreground">{t('admin.settings.pluggySecretHelp')}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => saveMutation.mutate()}
                disabled={busy || !clientId.trim() || (!clientSecret && !setting.has_secret)}
              >
                <Save size={14} />
                {saveMutation.isPending ? t('common.loading') : t('common.save')}
              </Button>
              <Button
                variant="outline"
                onClick={() => testMutation.mutate()}
                disabled={busy || !clientId.trim() || (!clientSecret && !setting.has_secret)}
              >
                <TestTube2 size={14} />
                {testMutation.isPending ? t('common.loading') : t('admin.settings.pluggyTest')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
