/**
 * The numbers behind the Investimentos page, kept out of the component so
 * the rules are testable: what counts, what is left out, and why.
 *
 * - A position is an active (not sold, not archived) asset the API classes
 *   as an investment (`investment_class` set). Real estate, vehicles and
 *   valuables stay on Patrimônio only.
 * - The total is the sum of every position with a value in the display
 *   currency. A position with no value at all (no price) or in a currency
 *   with no FX rate is left out of the total and of the shares, and listed
 *   apart, never summed at a fake 1:1 rate (same rule as Patrimônio, #574).
 * - The return is the unrealized gain of the positions whose cost is known
 *   (same rule as Patrimônio's "Rentab." column); the cost shown next to it
 *   covers those same positions, so return % = return / cost.
 */
import type { Asset, AssetGroup, InvestmentClass } from '@/types'
import { getAssetProfit } from '@/lib/asset-profit'
import { getAssetValuePrimary } from '@/lib/asset-portfolio-share'

/** Asset types the backend can class as investments (services/investment_class.py). */
export const INVESTMENT_ASSET_TYPES: Record<string, true> = { investment: true, stock: true, etf: true, fund: true, crypto: true }

/** Tie-break order for classes of equal value; also the legend's colour key. */
export const INVESTMENT_CLASSES: readonly InvestmentClass[] = [
  'fixed_income',
  'pension',
  'funds',
  'stocks',
  'real_estate_funds',
  'etfs',
  'structured',
  'crypto',
  'other',
]

export type PositionStatus = 'valued' | 'no_price' | 'no_fx'

export interface InvestmentPosition {
  asset: Asset
  cls: InvestmentClass
  status: PositionStatus
  /** Value in the display currency; null when left out of the total. */
  valuePrimary: number | null
  /** Unrealized return in the display currency; null when the cost is unknown. */
  gainPrimary: number | null
  costPrimary: number | null
  /** Share of the total, in percent; null when left out of the total. */
  share: number | null
  synced: boolean
  /** Has a value but no valuation date: carried at its purchase price. */
  atCost: boolean
}

export interface AllocationSlice {
  key: string
  value: number
  share: number
  count: number
}

export interface ClassGroup extends AllocationSlice {
  cls: InvestmentClass
  positions: InvestmentPosition[]
}

export interface WalletSlice extends AllocationSlice {
  walletId: string | null
  wallet: AssetGroup | null
}

export interface UnconvertedSum {
  currency: string
  amount: number
  count: number
}

export interface InvestmentsView {
  positions: InvestmentPosition[]
  total: number
  /** Cost of the positions whose return is known. */
  cost: number
  gain: number
  gainPct: number | null
  /** Positions in the total, and how many of them have a known return. */
  valuedCount: number
  returnCount: number
  byClass: ClassGroup[]
  byWallet: WalletSlice[]
  noPrice: InvestmentPosition[]
  noFx: InvestmentPosition[]
  unconverted: UnconvertedSum[]
  syncedCount: number
  manualCount: number
  atCostCount: number
  oldestValueDate: string | null
  newestValueDate: string | null
}

export function isInvestmentPosition(asset: Asset): boolean {
  return asset.investment_class != null && !asset.sell_date && !asset.is_archived
}

function toPosition(asset: Asset, displayCurrency: string): InvestmentPosition {
  const valuePrimary = getAssetValuePrimary(asset, displayCurrency)
  const status: PositionStatus = asset.current_value == null
    ? 'no_price'
    : valuePrimary == null ? 'no_fx' : 'valued'
  // Same rule as Patrimônio's return column; the primary amount is the
  // native one when the asset already is in the display currency.
  const profit = status === 'valued' ? getAssetProfit(asset) : null
  const gainPrimary = profit == null
    ? null
    : asset.currency === displayCurrency ? profit.amount : asset.gain_loss_primary
  const costPrimary = gainPrimary != null && valuePrimary != null ? valuePrimary - gainPrimary : null
  return {
    asset,
    cls: asset.investment_class ?? 'other',
    status,
    valuePrimary: status === 'valued' ? valuePrimary : null,
    gainPrimary,
    costPrimary,
    share: null,
    synced: asset.source !== 'manual',
    atCost: asset.current_value != null && asset.value_as_of == null,
  }
}

export function buildInvestmentsView(
  assets: Asset[],
  wallets: AssetGroup[],
  displayCurrency: string,
): InvestmentsView {
  const positions = assets.filter(isInvestmentPosition).map((asset) => toPosition(asset, displayCurrency))
  const valued = positions.filter((p) => p.status === 'valued')
  const total = valued.reduce((sum, p) => sum + (p.valuePrimary ?? 0), 0)
  for (const p of valued) p.share = total > 0 ? ((p.valuePrimary ?? 0) / total) * 100 : null

  const withReturn = valued.filter((p) => p.gainPrimary != null)
  const gain = withReturn.reduce((sum, p) => sum + (p.gainPrimary ?? 0), 0)
  const cost = withReturn.reduce((sum, p) => sum + (p.costPrimary ?? 0), 0)

  const classGroups = new Map<InvestmentClass, InvestmentPosition[]>()
  for (const p of positions) classGroups.set(p.cls, [...(classGroups.get(p.cls) ?? []), p])
  const byClass: ClassGroup[] = [...classGroups.entries()]
    .map(([cls, items]) => {
      const value = items.reduce((sum, p) => sum + (p.valuePrimary ?? 0), 0)
      return {
        key: cls,
        cls,
        value,
        share: total > 0 ? (value / total) * 100 : 0,
        count: items.length,
        positions: [...items].sort((a, b) =>
          (b.valuePrimary ?? -Infinity) - (a.valuePrimary ?? -Infinity) || a.asset.name.localeCompare(b.asset.name)),
      }
    })
    .sort((a, b) => b.value - a.value || INVESTMENT_CLASSES.indexOf(a.cls) - INVESTMENT_CLASSES.indexOf(b.cls))

  const walletById = new Map(wallets.map((w) => [w.id, w]))
  const walletGroups = new Map<string | null, InvestmentPosition[]>()
  for (const p of positions) {
    const id = p.asset.group_id ?? null
    walletGroups.set(id, [...(walletGroups.get(id) ?? []), p])
  }
  const byWallet: WalletSlice[] = [...walletGroups.entries()]
    .map(([walletId, items]) => {
      const value = items.reduce((sum, p) => sum + (p.valuePrimary ?? 0), 0)
      return {
        key: walletId ?? 'none',
        walletId,
        wallet: walletId ? walletById.get(walletId) ?? null : null,
        value,
        share: total > 0 ? (value / total) * 100 : 0,
        count: items.length,
      }
    })
    // "No wallet" goes last whatever its size: it is the leftovers bucket.
    .sort((a, b) => Number(a.walletId == null) - Number(b.walletId == null) || b.value - a.value)

  const noFx = positions.filter((p) => p.status === 'no_fx')
  const unconvertedMap = new Map<string, UnconvertedSum>()
  for (const p of noFx) {
    const entry = unconvertedMap.get(p.asset.currency) ?? { currency: p.asset.currency, amount: 0, count: 0 }
    entry.amount += Number(p.asset.current_value ?? 0)
    entry.count += 1
    unconvertedMap.set(p.asset.currency, entry)
  }

  const valueDates = valued.map((p) => p.asset.value_as_of).filter((d): d is string => !!d).sort()

  return {
    positions,
    total,
    cost,
    gain,
    gainPct: cost > 0 ? (gain / cost) * 100 : null,
    valuedCount: valued.length,
    returnCount: withReturn.length,
    byClass,
    byWallet,
    noPrice: positions.filter((p) => p.status === 'no_price'),
    noFx,
    unconverted: [...unconvertedMap.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    syncedCount: positions.filter((p) => p.synced).length,
    manualCount: positions.filter((p) => !p.synced).length,
    atCostCount: valued.filter((p) => p.atCost).length,
    oldestValueDate: valueDates[0] ?? null,
    newestValueDate: valueDates[valueDates.length - 1] ?? null,
  }
}

type PortfolioTrend = {
  assets: { id: string; type: string; group_id: string | null }[]
  trend: Record<string, unknown>[]
}

/**
 * Value of the investments over time, from the portfolio trend Patrimônio
 * charts: only investment-type columns (and, under a collection, only its
 * wallets), summed per date. Leading dates before the first investment are
 * dropped. The backend already leaves out assets with no FX rate and keeps
 * sold ones until their sale date.
 */
export function investmentTrend(
  data: PortfolioTrend | undefined,
  allowedWalletIds: string[] | null,
): { date: string; value: number }[] {
  if (!data) return []
  const allowed = allowedWalletIds ? new Set(allowedWalletIds) : null
  const ids = data.assets
    .filter((a) => INVESTMENT_ASSET_TYPES[a.type] && (!allowed || (a.group_id != null && allowed.has(a.group_id))))
    .map((a) => a.id)
  if (ids.length === 0) return []
  const points = data.trend.map((row) => ({
    date: String(row.date),
    value: Math.round(ids.reduce((sum, id) => sum + (Number(row[id]) || 0), 0) * 100) / 100,
  }))
  const first = points.findIndex((p) => p.value !== 0)
  return first === -1 ? [] : points.slice(first)
}
