import type { Asset, AssetGroup } from '@/types'

/** An `Asset` as `GET /api/assets` returns it, with only what a test cares about set. */
export function makeAsset(overrides: Partial<Asset>): Asset {
  return {
    id: 'a', user_id: 'u', name: 'Asset', type: 'investment', currency: 'BRL', units: null,
    valuation_method: 'manual', purchase_date: null, purchase_price: null, sell_date: null, sell_price: null,
    growth_type: null, growth_rate: null, growth_frequency: null, growth_start_date: null, is_archived: false,
    position: 0, current_value: null, current_value_primary: null, gain_loss: null, gain_loss_primary: null,
    value_count: 1, source: 'manual', connection_id: null, isin: null, maturity_date: null, group_id: null,
    ticker: null, ticker_exchange: null, last_price: null, last_price_at: null, logo_url: null,
    average_price: null, total_invested: null, realized_gain: null, transaction_count: 0,
    investment_class: 'other', value_as_of: '2026-11-16',
    ...overrides,
  }
}

export function makeWallet(id: string, name: string, overrides: Partial<AssetGroup> = {}): AssetGroup {
  return {
    id, user_id: 'u', name, icon: 'wallet', color: '#0EA5E9', position: 0, source: 'manual',
    connection_id: null, institution_name: null, asset_count: 0, current_value: 0, current_value_primary: 0,
    ...overrides,
  }
}
