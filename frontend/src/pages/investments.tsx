/** Investimentos: what is invested, how it is split and how much it earned.
 *
 *  A read-only view over the same assets Patrimônio manages, limited to
 *  investments (see `lib/investments-view.ts` for what counts and why).
 *  Editing stays on Patrimônio: a position opens there, expanded, instead
 *  of this page growing a second set of forms.
 */
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ChevronRight, Landmark, Plug, TrendingUp, Upload } from 'lucide-react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis } from 'recharts'

import { assets as assetsApi, assetGroups as assetGroupsApi } from '@/lib/api'
import { formatCurrency } from '@/lib/format'
import { getAssetProfit } from '@/lib/asset-profit'
import {
  buildInvestmentsView,
  investmentTrend,
  type AllocationSlice,
  type InvestmentPosition,
  type InvestmentsView,
} from '@/lib/investments-view'
import { useDisplayLocale, useDateLocale } from '@/hooks/use-display-locale'
import { useIsMobile } from '@/hooks/use-mobile'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { useAuth } from '@/contexts/auth-context'
import { useWorkspace } from '@/contexts/workspace-context'
import { useCollectionFilter } from '@/contexts/collection-filter-context'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import type { AssetGroup, InvestmentClass } from '@/types'

// Kept clear of the app's reserved hues: rose (spend), emerald (gain),
// violet (forecast), amber (warnings). Close to Patrimônio's type colours.
const CLASS_COLOR: Record<InvestmentClass, string> = {
  fixed_income: 'bg-blue-600',
  pension: 'bg-fuchsia-500',
  funds: 'bg-indigo-500',
  stocks: 'bg-sky-500',
  real_estate_funds: 'bg-cyan-600',
  etfs: 'bg-teal-500',
  structured: 'bg-lime-600',
  crypto: 'bg-orange-500',
  other: 'bg-slate-400',
}

const WALLET_FALLBACK_COLOR = '#94A3B8'

type Formatters = {
  money: (value: number, currency?: string) => string
  pct: (value: number) => string
  date: (iso: string) => string
  /** Axis ticks: "R$ 12 mil", "$12K". */
  compact: (value: number) => string
}

export default function InvestmentsPage() {
  const { t } = useTranslation()
  const locale = useDisplayLocale()
  const dateLocale = useDateLocale()
  const isMobile = useIsMobile()
  const { mask } = usePrivacyMode()
  const { user } = useAuth()
  const { canWrite, hasModule } = useWorkspace()
  const { activeWalletIds } = useCollectionFilter()
  const primaryCurrency = user?.preferences?.currency_display ?? 'USD'

  // Same keys and calls as Patrimônio, so the two pages share one cache.
  const assetsQuery = useQuery({ queryKey: ['assets'], queryFn: () => assetsApi.list(false) })
  const walletsQuery = useQuery({ queryKey: ['asset-groups'], queryFn: () => assetGroupsApi.list() })
  const trendQuery = useQuery({ queryKey: ['portfolio-trend'], queryFn: () => assetsApi.portfolioTrend() })

  // Under a collection, only the assets in its wallets, as on Patrimônio.
  const view = useMemo(() => {
    if (!assetsQuery.data) return null
    const allowed = activeWalletIds ? new Set(activeWalletIds) : null
    const scoped = allowed
      ? assetsQuery.data.filter((a) => a.group_id != null && allowed.has(a.group_id))
      : assetsQuery.data
    return buildInvestmentsView(scoped, walletsQuery.data ?? [], primaryCurrency)
  }, [assetsQuery.data, walletsQuery.data, activeWalletIds, primaryCurrency])
  const trend = useMemo(() => investmentTrend(trendQuery.data, activeWalletIds), [trendQuery.data, activeWalletIds])

  const thisYear = String(new Date().getFullYear())
  const fmt: Formatters = {
    money: (value, currency = primaryCurrency) => mask(formatCurrency(value, currency, locale)),
    pct: (value) => `${value.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`,
    compact: (value) => mask(new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: primaryCurrency,
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value)),
    date: (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString(dateLocale, {
      day: '2-digit',
      month: '2-digit',
      ...(iso.startsWith(thisYear) ? {} : { year: '2-digit' }),
    }),
  }

  const canImport = canWrite && hasModule('import')
  const empty = view != null && view.positions.length === 0

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t('nav.investments')}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{t('investments.subtitle')}</p>
        </div>
        {!empty && (
          <div className="flex flex-wrap items-center gap-2">
            {canImport && (
              <Button asChild variant="outline" size="sm" className="h-10">
                <Link to="/import?tab=investments">
                  <Upload size={14} aria-hidden="true" />
                  {t('investments.import')}
                </Link>
              </Button>
            )}
            <Button asChild variant="outline" size="sm" className="h-10">
              <Link to="/assets">
                <Landmark size={14} aria-hidden="true" />
                {t('investments.manage', { page: t('nav.assets') })}
              </Link>
            </Button>
          </div>
        )}
      </div>

      {assetsQuery.isError ? (
        <section role="alert" className="rounded-xl border border-border bg-card px-5 py-10 text-center shadow-sm">
          <p className="text-sm font-medium">{t('investments.error')}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void assetsQuery.refetch()}>
            {t('common.retry')}
          </Button>
        </section>
      ) : view == null ? (
        <div className="space-y-6" aria-busy="true" aria-label={t('common.loading')}>
          <Skeleton className="h-36 rounded-xl" />
          <div className="grid gap-6 lg:grid-cols-2">
            <Skeleton className="h-48 rounded-xl" />
            <Skeleton className="h-48 rounded-xl" />
          </div>
          <Skeleton className="h-64 rounded-xl" />
        </div>
      ) : empty ? (
        <EmptyState
          canImport={canImport}
          canConnect={canWrite && hasModule('accounts')}
        />
      ) : (
        <>
          <Warnings view={view} primaryCurrency={primaryCurrency} fmt={fmt} />
          <Summary view={view} fmt={fmt} />
          <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
            <Allocation
              id="investments-by-class"
              title={t('investments.allocation.byClass')}
              slices={view.byClass.map((slice) => ({
                ...slice,
                label: t(`investments.class.${slice.cls}`),
                swatch: { className: CLASS_COLOR[slice.cls] },
              }))}
              fmt={fmt}
            />
            <Allocation
              id="investments-by-wallet"
              title={t('investments.allocation.byWallet')}
              slices={view.byWallet.map((slice) => ({
                ...slice,
                label: slice.wallet?.name ?? t('investments.allocation.noWallet'),
                // A synced wallet keeps its institution even after a rename.
                detail: slice.wallet?.institution_name && slice.wallet.institution_name !== slice.wallet.name
                  ? slice.wallet.institution_name
                  : undefined,
                swatch: { color: slice.wallet?.color ?? WALLET_FALLBACK_COLOR },
              }))}
              fmt={fmt}
            />
          </div>
          {trend.length >= 2 && <Evolution points={trend} currency={primaryCurrency} fmt={fmt} />}
          <Positions
            view={view}
            wallets={walletsQuery.data ?? []}
            primaryCurrency={primaryCurrency}
            isMobile={isMobile}
            locale={locale}
            mask={mask}
            fmt={fmt}
          />
        </>
      )}
    </div>
  )
}

function EmptyState({ canImport, canConnect }: { canImport: boolean; canConnect: boolean }) {
  const { t } = useTranslation()
  return (
    <section className="rounded-xl border border-border bg-card px-5 py-12 text-center shadow-sm">
      <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <TrendingUp size={20} aria-hidden="true" />
      </div>
      <h2 className="mt-4 text-base font-semibold">{t('investments.empty.title')}</h2>
      <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-muted-foreground">{t('investments.empty.body', { page: t('nav.assets') })}</p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {canConnect && (
          <Button asChild size="sm">
            <Link to="/connections">
              <Plug size={14} aria-hidden="true" />
              {t('investments.empty.connect')}
            </Link>
          </Button>
        )}
        {canImport && (
          <Button asChild variant="outline" size="sm">
            <Link to="/import?tab=investments">
              <Upload size={14} aria-hidden="true" />
              {t('investments.empty.import')}
            </Link>
          </Button>
        )}
        <Button asChild variant="outline" size="sm">
          <Link to="/assets">
            <Landmark size={14} aria-hidden="true" />
            {t('investments.empty.add', { page: t('nav.assets') })}
          </Link>
        </Button>
      </div>
    </section>
  )
}

function Warnings({ view, primaryCurrency, fmt }: { view: InvestmentsView; primaryCurrency: string; fmt: Formatters }) {
  const { t } = useTranslation()
  if (view.noPrice.length === 0 && view.unconverted.length === 0) return null
  return (
    <div role="status" className="space-y-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
      {view.noPrice.length > 0 && (
        <p className="flex items-start gap-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{t('investments.warnings.noPrice', { names: view.noPrice.map((p) => p.asset.name).join(', ') })}</span>
        </p>
      )}
      {view.unconverted.map((sum) => (
        <p key={sum.currency} className="flex items-start gap-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            {t('investments.warnings.noFx', {
              currency: sum.currency,
              primary: primaryCurrency,
              amount: fmt.money(sum.amount, sum.currency),
            })}
          </span>
        </p>
      ))}
    </div>
  )
}

function Summary({ view, fmt }: { view: InvestmentsView; fmt: Formatters }) {
  const { t } = useTranslation()
  const gainTone = view.gain > 0
    ? 'text-emerald-700 dark:text-emerald-400'
    : view.gain < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'
  const provenance = [
    view.oldestValueDate && view.newestValueDate
      ? view.oldestValueDate === view.newestValueDate
        ? t('investments.provenance.valuesOn', { date: fmt.date(view.newestValueDate) })
        : t('investments.provenance.valuesBetween', { from: fmt.date(view.oldestValueDate), to: fmt.date(view.newestValueDate) })
      : null,
    view.syncedCount > 0 ? t('investments.provenance.synced', { count: view.syncedCount }) : null,
    view.manualCount > 0 ? t('investments.provenance.manual', { count: view.manualCount }) : null,
    view.atCostCount > 0 ? t('investments.provenance.atCost', { count: view.atCostCount }) : null,
  ].filter((line): line is string => line != null)

  return (
    <section aria-labelledby="investments-summary-title" className="rounded-xl border border-border bg-card shadow-sm">
      <h2 id="investments-summary-title" className="sr-only">{t('investments.summary.title')}</h2>
      <dl className="grid divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <div className="px-4 py-4 sm:px-5">
          <dt className="text-sm text-muted-foreground">{t('investments.summary.value')}</dt>
          <dd>
            <p className="mt-0.5 text-2xl font-semibold tracking-tight tabular-nums" data-testid="investments-total">
              {fmt.money(view.total)}
            </p>
            <p className="text-xs text-muted-foreground">{t('investments.summary.valueHint', { count: view.valuedCount })}</p>
          </dd>
        </div>
        <div className="px-4 py-4 sm:px-5">
          <dt className="text-sm text-muted-foreground">{t('investments.summary.cost')}</dt>
          <dd>
            <p className="mt-0.5 text-2xl font-semibold tracking-tight tabular-nums" data-testid="investments-cost">
              {view.returnCount > 0 ? fmt.money(view.cost) : '—'}
            </p>
            <p className="text-xs text-muted-foreground">{t('investments.summary.costHint')}</p>
          </dd>
        </div>
        <div className="px-4 py-4 sm:px-5">
          <dt className="text-sm text-muted-foreground">{t('investments.summary.return')}</dt>
          <dd>
            {view.returnCount > 0 ? (
              <p className={cn('mt-0.5 text-2xl font-semibold tracking-tight tabular-nums', gainTone)} data-testid="investments-return">
                {view.gain > 0 ? '+' : ''}{fmt.money(view.gain)}
                {view.gainPct != null && (
                  <span className="ml-2 text-sm font-medium">{view.gainPct > 0 ? '+' : ''}{fmt.pct(view.gainPct)}</span>
                )}
              </p>
            ) : (
              <p className="mt-0.5 text-2xl font-semibold tracking-tight text-muted-foreground" data-testid="investments-return">—</p>
            )}
            <p className="text-xs text-muted-foreground">
              {view.returnCount < view.valuedCount
                ? t('investments.summary.returnCoverage', { counted: view.returnCount, total: view.valuedCount })
                : t('investments.summary.returnHint')}
            </p>
          </dd>
        </div>
      </dl>
      {provenance.length > 0 && (
        <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground sm:px-5" data-testid="investments-provenance">
          {provenance.join(' · ')}
        </p>
      )}
    </section>
  )
}

type SliceRow = AllocationSlice & {
  label: string
  detail?: string
  swatch: { className?: string; color?: string }
}

function Allocation({ id, title, slices, fmt }: { id: string; title: string; slices: SliceRow[]; fmt: Formatters }) {
  const shown = slices.filter((slice) => slice.value > 0)
  return (
    <section aria-labelledby={`${id}-title`} className="rounded-xl border border-border bg-card shadow-sm">
      <h2 id={`${id}-title`} className="border-b border-border px-4 py-4 font-semibold sm:px-5">{title}</h2>
      <div className="space-y-4 px-4 py-4 sm:px-5">
        {/* The list below carries the numbers; the bar is the shape of them. */}
        <div className="flex h-2.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
          {shown.map((slice) => (
            <div
              key={slice.key}
              className={cn('h-full', slice.swatch.className)}
              style={{ width: `${slice.share}%`, backgroundColor: slice.swatch.color }}
            />
          ))}
        </div>
        <ul className="space-y-2.5" data-testid={id}>
          {slices.map((slice) => (
            <li key={slice.key} className="flex items-center gap-3 text-sm">
              <span
                className={cn('h-2.5 w-2.5 shrink-0 rounded-full', slice.swatch.className)}
                style={{ backgroundColor: slice.swatch.color }}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{slice.label}</span>
                {slice.detail && <span className="block truncate text-xs text-muted-foreground">{slice.detail}</span>}
              </span>
              <span className="shrink-0 tabular-nums font-medium">{fmt.money(slice.value)}</span>
              <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">{fmt.pct(slice.share)}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function Evolution({ points, currency, fmt }: { points: { date: string; value: number }[]; currency: string; fmt: Formatters }) {
  const { t } = useTranslation()
  return (
    <section aria-labelledby="investments-evolution-title" className="rounded-xl border border-border bg-card shadow-sm">
      <div className="border-b border-border px-4 py-4 sm:px-5">
        <h2 id="investments-evolution-title" className="font-semibold">{t('investments.evolution.title')}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('investments.evolution.hint', { currency })}</p>
      </div>
      <div className="h-56 px-2 py-4 sm:px-3">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="investments-evolution-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.3} />
                <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" strokeOpacity={0.5} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
              axisLine={false}
              tickLine={false}
              minTickGap={24}
              tickFormatter={fmt.date}
            />
            <YAxis
              tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
              axisLine={false}
              tickLine={false}
              width={72}
              tickFormatter={fmt.compact}
            />
            <RechartsTooltip
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null
                return (
                  <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-md">
                    <p className="text-muted-foreground">{fmt.date(String(label))}</p>
                    <p className="font-semibold tabular-nums">{fmt.money(Number(payload[0].value))}</p>
                  </div>
                )
              }}
            />
            <Area type="monotone" dataKey="value" stroke="var(--chart-1)" strokeWidth={2} fill="url(#investments-evolution-fill)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </section>
  )
}

type PositionsProps = {
  view: InvestmentsView
  wallets: AssetGroup[]
  primaryCurrency: string
  isMobile: boolean
  locale: string
  mask: (value: string) => string
  fmt: Formatters
}

function Positions({ view, wallets, primaryCurrency, isMobile, locale, mask, fmt }: PositionsProps) {
  const { t } = useTranslation()
  const walletById = new Map(wallets.map((w) => [w.id, w]))
  const rowProps = (position: InvestmentPosition) => {
    const wallet = position.asset.group_id ? walletById.get(position.asset.group_id) ?? null : null
    const { ticker, name } = position.asset
    return {
      position,
      // Tesouro bonds carry an internal TD:* symbol; their name reads better.
      name: ticker && !ticker.startsWith('TD:') ? ticker : name,
      institution: wallet ? wallet.name : t('investments.allocation.noWallet'),
      primaryCurrency,
      quantity: position.asset.units != null
        ? mask(position.asset.units.toLocaleString(locale, { maximumFractionDigits: 8 }))
        : null,
      fmt,
    }
  }

  return (
    <section aria-labelledby="investments-positions-title" className="space-y-4">
      <h2 id="investments-positions-title" className="text-lg font-semibold">{t('investments.positions.title')}</h2>
      {view.byClass.map((group) => (
        <div key={group.cls} className="overflow-hidden rounded-xl border border-border bg-card shadow-sm" data-testid={`investments-class-${group.cls}`}>
          <div className="flex items-center gap-3 border-b border-border px-4 py-3 sm:px-5">
            <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', CLASS_COLOR[group.cls])} aria-hidden="true" />
            <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{t(`investments.class.${group.cls}`)}</h3>
            <span className="text-sm font-semibold tabular-nums">{fmt.money(group.value)}</span>
            <span className="w-14 text-right text-xs tabular-nums text-muted-foreground">{fmt.pct(group.share)}</span>
          </div>
          {isMobile ? (
            <ul className="divide-y divide-border">
              {group.positions.map((position) => (
                <li key={position.asset.id}><PositionCard {...rowProps(position)} /></li>
              ))}
            </ul>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="whitespace-nowrap border-b border-border text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th scope="col" className="px-5 py-2 text-left font-medium">{t('investments.positions.asset')}</th>
                    <th scope="col" className="px-3 py-2 text-left font-medium">{t('investments.positions.institution')}</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">{t('investments.positions.quantity')}</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">{t('investments.positions.price')}</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">{t('investments.positions.value')}</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">{t('investments.positions.return')}</th>
                    <th scope="col" className="px-5 py-2 text-right font-medium">{t('investments.positions.share')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {group.positions.map((position) => <PositionRow key={position.asset.id} {...rowProps(position)} />)}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </section>
  )
}

type PositionProps = {
  position: InvestmentPosition
  name: string
  institution: string
  primaryCurrency: string
  quantity: string | null
  fmt: Formatters
}

/** "Synced · 16/11", "Quote · 17/11", "At purchase price". */
function Provenance({ position, fmt }: { position: InvestmentPosition; fmt: Formatters }) {
  const { t } = useTranslation()
  const { asset } = position
  if (position.status === 'no_price') return null
  if (position.atCost) return <>{t('investments.positions.atCost')}</>
  const source = asset.valuation_method === 'market_price'
    ? t('investments.positions.quote')
    : position.synced ? t('investments.positions.synced') : t('investments.positions.manual')
  return <>{asset.value_as_of ? `${source} · ${fmt.date(asset.value_as_of)}` : source}</>
}

function ValueCell({ position, primaryCurrency, fmt }: Pick<PositionProps, 'position' | 'primaryCurrency' | 'fmt'>) {
  const { t } = useTranslation()
  const { asset } = position
  if (position.status === 'no_price') {
    return <span className="text-amber-700 dark:text-amber-400">{t('investments.positions.noPrice')}</span>
  }
  return (
    <>
      <span className="block font-semibold">{fmt.money(Number(asset.current_value), asset.currency)}</span>
      {position.status === 'no_fx' ? (
        <span className="block text-[11px] text-amber-700 dark:text-amber-400">{t('investments.positions.noFx')}</span>
      ) : asset.currency !== primaryCurrency && position.valuePrimary != null ? (
        <span className="block text-[11px] text-muted-foreground">{fmt.money(position.valuePrimary)}</span>
      ) : null}
    </>
  )
}

function ReturnCell({ position, fmt }: { position: InvestmentPosition; fmt: Formatters }) {
  const profit = position.status === 'no_price' ? null : getAssetProfit(position.asset)
  if (!profit) return <span className="text-muted-foreground">—</span>
  const tone = profit.amount > 0
    ? 'text-emerald-700 dark:text-emerald-400'
    : profit.amount < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-muted-foreground'
  return (
    <span className={tone}>
      <span className="block">{profit.amount > 0 ? '+' : ''}{fmt.money(profit.amount, position.asset.currency)}</span>
      {profit.percentage != null && (
        <span className="block text-[11px]">{profit.percentage > 0 ? '+' : ''}{fmt.pct(profit.percentage)}</span>
      )}
    </span>
  )
}

function PositionRow({ position, name, institution, primaryCurrency, quantity, fmt }: PositionProps) {
  const { t } = useTranslation()
  const { asset } = position
  return (
    <tr className="align-top transition-colors hover:bg-muted/40">
      <td className="w-full max-w-0 px-5 py-3">
        <Link
          to={`/assets?asset=${asset.id}`}
          aria-label={t('investments.positions.open', { name, page: t('nav.assets') })}
          className="block truncate rounded-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {name}
        </Link>
        <span className="block truncate text-xs text-muted-foreground">
          {name !== asset.name ? `${asset.name} · ` : ''}<Provenance position={position} fmt={fmt} />
        </span>
      </td>
      <td className="max-w-[12rem] truncate px-3 py-3 text-muted-foreground">{institution}</td>
      <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">{quantity ?? '—'}</td>
      <td className="px-3 py-3 text-right tabular-nums">
        {asset.last_price != null ? fmt.money(asset.last_price, asset.currency) : <span className="text-muted-foreground">—</span>}
        {asset.average_price != null && (
          <span className="block text-[11px] text-muted-foreground">
            {t('investments.positions.avgPrice', { price: fmt.money(asset.average_price, asset.currency) })}
          </span>
        )}
      </td>
      <td className="px-3 py-3 text-right tabular-nums"><ValueCell position={position} primaryCurrency={primaryCurrency} fmt={fmt} /></td>
      <td className="px-3 py-3 text-right tabular-nums"><ReturnCell position={position} fmt={fmt} /></td>
      <td className="px-5 py-3 text-right tabular-nums text-muted-foreground">{position.share != null ? fmt.pct(position.share) : '—'}</td>
    </tr>
  )
}

function PositionCard({ position, name, institution, primaryCurrency, quantity, fmt }: PositionProps) {
  const { t } = useTranslation()
  const { asset } = position
  return (
    <Link
      to={`/assets?asset=${asset.id}`}
      aria-label={t('investments.positions.open', { name, page: t('nav.assets') })}
      className="flex items-start gap-3 px-4 py-3.5 transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <div className="min-w-0 flex-1 space-y-0.5 text-xs text-muted-foreground">
        <p className="truncate text-sm font-semibold text-foreground">{name}</p>
        <p className="truncate">{institution}</p>
        {quantity != null && asset.last_price != null && (
          <p className="truncate tabular-nums">{quantity} × {fmt.money(asset.last_price, asset.currency)}</p>
        )}
        {position.status !== 'no_price' && <p className="truncate"><Provenance position={position} fmt={fmt} /></p>}
      </div>
      <div className="shrink-0 text-right text-sm tabular-nums">
        <ValueCell position={position} primaryCurrency={primaryCurrency} fmt={fmt} />
        <span className="mt-0.5 block text-xs"><ReturnCell position={position} fmt={fmt} /></span>
        {position.share != null && <span className="block text-[11px] text-muted-foreground">{fmt.pct(position.share)}</span>}
      </div>
      <ChevronRight size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    </Link>
  )
}
