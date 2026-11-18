/** Conciliações: the one home for the questions matching could not answer.
 *
 *  The queue used to be a tab on the Rules page, which meant only people
 *  who came to configure something discovered they had work waiting. Here
 *  it opens on what needs a decision, and the history of what matching did
 *  sits one tab away, for checking an answer after giving it.
 *
 *  The rules themselves stay on the Rules page: they are configuration,
 *  visited to change behaviour, and the link in the header goes there for
 *  the day the same question keeps coming back.
 */
import { Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { SlidersHorizontal } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/invoice-ui'
import { NavCountBadge } from '@/components/nav-count-badge'
import { ReconciliationQueue } from '@/components/reconciliation-queue'
import { ReconciliationHistory } from '@/components/reconciliation-history'
import { useWorkspace } from '@/contexts/workspace-context'
import { usePendingReconciliationCount } from '@/hooks/use-pending-reconciliation-count'

type View = 'pending' | 'history'

export default function ReconciliationPage() {
  const { t } = useTranslation()
  const { canWrite, hasModule } = useWorkspace()
  const { data: pendingCount } = usePendingReconciliationCount()

  // In the URL so the history can be linked to, and `replace` so the back
  // button leaves the page instead of walking back through tab clicks.
  const [searchParams, setSearchParams] = useSearchParams()
  const view: View = searchParams.get('tab') === 'history' ? 'history' : 'pending'
  const setView = (next: View) =>
    setSearchParams(next === 'history' ? { tab: 'history' } : {}, { replace: true })

  return (
    <div className="mx-auto max-w-4xl space-y-5 pb-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t('nav.reconciliation')}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{t('reconciliation.page.subtitle')}</p>
        </div>
        {hasModule('rules') && (
          <Button asChild variant="outline" size="sm" className="h-10 self-start sm:self-auto">
            <Link to="/rules">
              <SlidersHorizontal size={14} aria-hidden="true" />
              {t('reconciliation.page.adjustRules')}
            </Link>
          </Button>
        )}
      </div>

      <Segmented
        value={view}
        onChange={setView}
        testIdPrefix="reconciliation-tab"
        options={[
          {
            value: 'pending',
            // Not Segmented's muted `count`, which suits "Overdue 2" beside a
            // filter. This is work waiting on somebody, so it carries the same
            // badge as the navigation, and disappears rather than show a zero.
            label: (
              <span className="inline-flex items-center gap-1.5">
                {t('reconciliation.page.pending')}
                <NavCountBadge count={pendingCount} />
              </span>
            ),
          },
          { value: 'history', label: t('reconciliation.page.history') },
        ]}
      />

      {view === 'history' ? <ReconciliationHistory /> : <ReconciliationQueue canWrite={canWrite} />}
    </div>
  )
}
