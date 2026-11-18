import { describe, expect, it } from 'vitest'

import { buildInvestmentsView, investmentTrend } from '@/lib/investments-view'
import { makeAsset, makeWallet } from '@/test/asset-fixture'
import type { Asset } from '@/types'

const wallets = [makeWallet('w-bank', 'Banco X', { source: 'pluggy', institution_name: 'Banco X' }), makeWallet('w-broker', 'Corretora')]

// A synced CDB, a BRL stock, a converted USD ETF, a EUR fund with no FX rate,
// a fund with no price, plus a house, a sold stock and an archived fund that
// must not show up at all.
const portfolio: Asset[] = [
  makeAsset({
    id: 'cdb', name: 'CDB Banco X', investment_class: 'fixed_income', source: 'pluggy', group_id: 'w-bank',
    current_value: 1000, purchase_price: 900, gain_loss: 100, value_count: 3, value_as_of: '2026-11-16',
  }),
  makeAsset({
    id: 'petr', name: 'Petrobras', ticker: 'PETR4.SA', type: 'stock', investment_class: 'stocks', group_id: 'w-broker',
    valuation_method: 'market_price', units: 10, last_price: 50, current_value: 500, purchase_price: 450,
    total_invested: 450, average_price: 45, gain_loss: 50, value_count: 2, value_as_of: '2026-11-17',
  }),
  makeAsset({
    id: 'ivv', name: 'iShares S&P 500', ticker: 'IVV', type: 'etf', investment_class: 'etfs', group_id: 'w-broker',
    currency: 'USD', current_value: 100, current_value_primary: 500, gain_loss: 10, gain_loss_primary: 50,
    purchase_price: 90, value_count: 2, value_as_of: '2026-11-10',
  }),
  makeAsset({
    id: 'eur-fund', name: 'Fundo Europa', type: 'fund', investment_class: 'funds', currency: 'EUR',
    current_value: 200, current_value_primary: null, gain_loss: 20, purchase_price: 180,
  }),
  makeAsset({ id: 'no-price', name: 'Fundo sem cota', type: 'fund', investment_class: 'funds', current_value: null, value_as_of: null }),
  makeAsset({ id: 'house', name: 'Casa', type: 'real_estate', investment_class: null, current_value: 300000 }),
  makeAsset({ id: 'sold', name: 'Vale', type: 'stock', investment_class: 'stocks', current_value: 0, sell_date: '2026-10-01' }),
  makeAsset({ id: 'archived', name: 'Antigo', type: 'fund', investment_class: 'funds', current_value: 10, is_archived: true }),
]

describe('buildInvestmentsView', () => {
  const view = buildInvestmentsView(portfolio, wallets, 'BRL')

  it('keeps only active investments', () => {
    expect(view.positions.map((p) => p.asset.id).sort()).toEqual(['cdb', 'eur-fund', 'ivv', 'no-price', 'petr'])
  })

  it('totals the positions with a value in the display currency and flags the rest', () => {
    // 1000 (CDB) + 500 (PETR4) + 500 (IVV converted); the EUR fund and the
    // fund with no price are out.
    expect(view.total).toBe(2000)
    expect(view.valuedCount).toBe(3)
    expect(view.noPrice.map((p) => p.asset.id)).toEqual(['no-price'])
    expect(view.noFx.map((p) => p.asset.id)).toEqual(['eur-fund'])
    expect(view.unconverted).toEqual([{ currency: 'EUR', amount: 200, count: 1 }])
    const excluded = view.positions.filter((p) => p.status !== 'valued')
    expect(excluded.every((p) => p.valuePrimary == null && p.share == null)).toBe(true)
  })

  it('makes shares, class and wallet allocations add up to the total', () => {
    const shares = view.positions.reduce((sum, p) => sum + (p.share ?? 0), 0)
    expect(shares).toBeCloseTo(100)
    expect(view.byClass.reduce((sum, c) => sum + c.value, 0)).toBeCloseTo(view.total)
    expect(view.byClass.reduce((sum, c) => sum + c.share, 0)).toBeCloseTo(100)
    expect(view.byWallet.reduce((sum, w) => sum + w.value, 0)).toBeCloseTo(view.total)
    expect(view.byWallet.reduce((sum, w) => sum + w.share, 0)).toBeCloseTo(100)
  })

  it('groups positions by class, largest class first, excluded positions still listed', () => {
    expect(view.byClass.map((c) => [c.cls, c.value, c.count])).toEqual([
      ['fixed_income', 1000, 1],
      ['stocks', 500, 1],
      ['etfs', 500, 1],
      ['funds', 0, 2],
    ])
    expect(view.byClass.find((c) => c.cls === 'funds')?.positions.map((p) => p.asset.id).sort()).toEqual(['eur-fund', 'no-price'])
  })

  it('splits by wallet, with unassigned positions last', () => {
    expect(view.byWallet.map((w) => [w.walletId, w.wallet?.name ?? null, w.value, w.count])).toEqual([
      ['w-bank', 'Banco X', 1000, 1],
      ['w-broker', 'Corretora', 1000, 2],
      [null, null, 0, 2],
    ])
  })

  it('computes the return in the display currency over the positions with a known cost', () => {
    // Gains 100 + 50 + 50 (IVV converted); costs 900 + 450 + 450.
    expect(view.gain).toBe(200)
    expect(view.cost).toBe(1800)
    expect(view.gainPct).toBeCloseTo((200 / 1800) * 100)
    expect(view.returnCount).toBe(3)
  })

  it('leaves positions without a recorded cost out of the return but in the total', () => {
    const noCost = makeAsset({ id: 'nocost', investment_class: 'funds', current_value: 300, purchase_price: null, gain_loss: null })
    // Valued only at its purchase price (no valuations yet): no return either.
    const atCost = makeAsset({ id: 'atcost', investment_class: 'funds', current_value: 200, purchase_price: 200, gain_loss: 0, value_count: 0, value_as_of: null })
    const v = buildInvestmentsView([...portfolio, noCost, atCost], wallets, 'BRL')
    expect(v.total).toBe(2500)
    expect(v.gain).toBe(200)
    expect(v.cost).toBe(1800)
    expect(v.returnCount).toBe(3)
    expect(v.valuedCount).toBe(5)
    expect(v.atCostCount).toBe(1)
  })

  it('reports where the values come from', () => {
    expect(view.syncedCount).toBe(1)
    expect(view.manualCount).toBe(4)
    expect(view.oldestValueDate).toBe('2026-11-10')
    expect(view.newestValueDate).toBe('2026-11-17')
  })

  it('is empty when there are no investments', () => {
    const v = buildInvestmentsView([portfolio[5]], wallets, 'BRL')
    expect(v.positions).toEqual([])
    expect(v.total).toBe(0)
    expect(v.gainPct).toBeNull()
    expect(v.byClass).toEqual([])
  })
})

describe('investmentTrend', () => {
  const trend = {
    assets: [
      { id: 'cdb', type: 'investment', group_id: 'w-bank' },
      { id: 'petr', type: 'stock', group_id: 'w-broker' },
      { id: 'house', type: 'real_estate', group_id: null },
    ],
    trend: [
      { date: '2026-01-01', cdb: 0, petr: 0, house: 300000, _total: 300000 },
      { date: '2026-02-01', cdb: 1000, petr: 0, house: 300000, _total: 301000 },
      { date: '2026-03-01', cdb: 1010.5, petr: 480, house: 300000, _total: 301490.5 },
    ],
  }

  it('sums the investment columns per date, from the first investment on', () => {
    expect(investmentTrend(trend, null)).toEqual([
      { date: '2026-02-01', value: 1000 },
      { date: '2026-03-01', value: 1490.5 },
    ])
  })

  it('keeps only the wallets of the active collection', () => {
    expect(investmentTrend(trend, ['w-broker'])).toEqual([{ date: '2026-03-01', value: 480 }])
  })

  it('is empty without investments', () => {
    expect(investmentTrend(undefined, null)).toEqual([])
    expect(investmentTrend({ assets: [trend.assets[2]], trend: trend.trend }, null)).toEqual([])
  })
})
