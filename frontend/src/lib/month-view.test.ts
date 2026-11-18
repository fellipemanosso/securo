import { describe, expect, it } from 'vitest'

import type { Category, CreditCardTimelineItem, InstallmentForecast, RecurringMonthOccurrence, Transaction } from '../types'
import {
  billAnalytics,
  billSourceOf,
  billTotalOf,
  installmentForecastRow,
  monthFromParam,
  recurringTotals,
  sortOccurrences,
} from './month-view'

const TODAY = '2026-11-18'

function item(overrides: Partial<CreditCardTimelineItem>): CreditCardTimelineItem {
  return {
    account_id: 'card-1', due_month: '2026-11', kind: 'projection', cycle_key: 'cycle:2026-11-15',
    start: '2026-10-16', end: '2026-11-15', closing_date: '2026-11-15', due_date: '2026-11-25',
    amount: 0, primary_amount: null, source: null, record_id: null, status: null, editable: false,
    unavailable_reason: null, ...overrides,
  }
}

function tx(overrides: Partial<Transaction>): Transaction {
  return {
    id: overrides.id ?? 'tx', user_id: 'u', account_id: 'card-1', category_id: null, category: null,
    external_id: null, description: 'Row', original_description: null, amount: 0, currency: 'BRL',
    date: '2026-11-01', type: 'debit', source: 'sync', status: 'posted', payee: null, payee_id: null,
    payee_name: null, notes: null, transfer_pair_id: null, amount_primary: null, fx_rate_used: null,
    fx_fallback: false, installment_number: null, total_installments: null, installment_total_amount: null,
    installment_purchase_date: null, installment_series_id: null, bill_id: null, effective_bill_date: null,
    splits: [], is_ignored: false, ...overrides,
  }
}

const food = { id: 'food', name: 'Food', color: '#f00' } as Category
const travel = { id: 'travel', name: 'Travel', color: '#00f' } as Category

describe('monthFromParam', () => {
  it('accepts a YYYY-MM month and falls back on anything else', () => {
    expect(monthFromParam('2026-02', '2026-11')).toBe('2026-02')
    expect(monthFromParam('2026-13', '2026-11')).toBe('2026-11')
    expect(monthFromParam('feb', '2026-11')).toBe('2026-11')
    expect(monthFromParam(null, '2026-11')).toBe('2026-11')
  })
})

describe('bill source and total', () => {
  it('trusts a closed bank statement and a manual one', () => {
    const closed = item({ kind: 'statement', amount: 900, source: 'bank', closing_date: '2026-11-10' })
    expect(billSourceOf(closed, TODAY)).toBe('bank')
    expect(billTotalOf(closed, undefined, TODAY)).toBe(900)
    const manual = item({ kind: 'statement', amount: 700, source: 'manual', closing_date: '2026-11-30' })
    expect(billSourceOf(manual, TODAY)).toBe('manual')
    expect(billTotalOf(manual, undefined, TODAY)).toBe(700)
  })

  it('estimates an open statement and a projection from the cycle summary', () => {
    const open = item({ kind: 'statement', amount: 900, source: 'bank', closing_date: '2026-11-30' })
    expect(billSourceOf(open, TODAY)).toBe('estimate')
    expect(billTotalOf(open, undefined, TODAY)).toBeNull()
    expect(billTotalOf(open, { projected_expenses: 950, monthly_expenses: 800 }, TODAY)).toBe(950)
    expect(billTotalOf(item({}), { monthly_expenses: 120 }, TODAY)).toBe(120)
  })
})

describe('billAnalytics', () => {
  const forecast: InstallmentForecast = {
    key: 'f1', description: 'Sofa', amount: 100, currency: 'BRL', type: 'debit', purchase_date: '2026-06-02',
    due_date: '2026-11-25', installment_number: 6, total_installments: 10, category_id: 'travel', card_last4: '1111',
  }
  const rows = [
    tx({ id: 'a', description: 'Market', amount: 300, category: food, category_id: 'food', card_last4: '1111' }),
    tx({ id: 'b', description: 'Refund', amount: 50, type: 'credit', category: food, category_id: 'food', card_last4: '1111' }),
    tx({ id: 'c', description: 'Flight', amount: 200, category: travel, category_id: 'travel', card_last4: '2222', status: 'pending' }),
    tx({ id: 'd', description: 'TV', amount: 150, installment_number: 2, total_installments: 5, card_last4: '2222' }),
    tx({ id: 'e', description: 'Payment', amount: 500, type: 'credit', source: 'settlement', transfer_pair_id: 'p' }),
    tx({ id: 'f', description: 'Opening', amount: 999, source: 'opening_balance' }),
  ]
  const forecastRows = [installmentForecastRow(forecast, 'card-1', [food, travel])]
  const result = billAnalytics(rows, forecastRows, true, 'BRL')

  it('adds up to the same parts as the card page', () => {
    expect(result.parts).toEqual({
      purchases: 450, credits: 50, pending: 200, installments: 100, installmentCount: 1, net: 700,
    })
  })

  it('splits the net by category and by card without losing anything', () => {
    expect(result.byCategory).toEqual([
      { id: 'travel', name: 'Travel', color: '#00f', amount: 300 },
      { id: 'food', name: 'Food', color: '#f00', amount: 250 },
      { id: null, name: null, color: null, amount: 150 },
    ])
    expect(result.byCard).toEqual([
      { last4: '1111', amount: 350, count: 3 },
      { last4: '2222', amount: 350, count: 2 },
    ])
    const sum = (values: { amount: number }[]) => values.reduce((total, value) => total + value.amount, 0)
    expect(sum(result.byCategory)).toBe(result.parts.net)
    expect(sum(result.byCard)).toBe(result.parts.net)
  })

  it('lists running and forecast installments, and the largest charges', () => {
    expect(result.installments.map(({ row, amount }) => [row.description, amount, !!row.virtual])).toEqual([
      ['TV', 150, false],
      ['Sofa', 100, true],
    ])
    expect(result.topCharges.map(({ row }) => row.description)).toEqual(['Market', 'Flight', 'TV', 'Sofa'])
  })
})

describe('recurring totals', () => {
  const occurrence = (overrides: Partial<RecurringMonthOccurrence>): RecurringMonthOccurrence => ({
    recurring_id: 'r', description: 'Bill', account_id: null, category_id: null, category_name: null,
    category_icon: null, category_color: null, type: 'debit', frequency: 'monthly', currency: 'BRL',
    date: '2026-11-10', expected_amount: 100, expected_amount_primary: 100, status: 'pending',
    transaction_id: null, paid_amount: null, paid_amount_primary: null, ...overrides,
  })
  const items = [
    occurrence({ description: 'Rent', status: 'paid', expected_amount: 1500, expected_amount_primary: 1500, paid_amount: 1500, paid_amount_primary: 1500, date: '2026-11-05' }),
    occurrence({ description: 'Power', status: 'paid', expected_amount: 200, expected_amount_primary: 200, paid_amount: 230, paid_amount_primary: 230, date: '2026-11-08' }),
    occurrence({ description: 'Internet', status: 'overdue', expected_amount: 120, expected_amount_primary: 120, date: '2026-11-10' }),
    occurrence({ description: 'Gym', status: 'pending', expected_amount: 90, expected_amount_primary: 90, date: '2026-11-25' }),
    occurrence({ description: 'Cloud', status: 'pending', currency: 'USD', expected_amount: 10, expected_amount_primary: null, date: '2026-11-20' }),
    occurrence({ description: 'Salary', type: 'credit', status: 'paid', expected_amount: 5000, expected_amount_primary: 5000, paid_amount: 5000, paid_amount_primary: 5000 }),
  ]

  it('totals expected, paid and pending per direction', () => {
    expect(recurringTotals(items, 'debit')).toEqual({
      expected: 1910, paid: 1730, pending: 210, overdueCount: 1, pendingCount: 2, paidCount: 2, missingConversion: true,
    })
    expect(recurringTotals(items, 'credit')).toMatchObject({ expected: 5000, paid: 5000, pending: 0, missingConversion: false })
  })

  it('puts overdue first, then pending, then paid', () => {
    expect(sortOccurrences(items).map((item) => item.description)).toEqual([
      'Internet', 'Cloud', 'Gym', 'Rent', 'Power', 'Salary',
    ])
  })
})
