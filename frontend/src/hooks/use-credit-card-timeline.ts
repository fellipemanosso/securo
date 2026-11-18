import { useQuery } from '@tanstack/react-query'
import { addMonths, endOfMonth, format, parseISO, startOfMonth, subMonths } from 'date-fns'
import type { TFunction } from 'i18next'

import { accounts } from '@/lib/api'
import { resolveDateFnsLocale } from '@/lib/date-fns-locale'
import type { CreditCardTimelineItem } from '@/types'

/** A card's statements from two years back to a year ahead. The card page
 *  and the transaction dialog read the same query, so opening the dialog
 *  from the page costs no extra request. */
export function useCreditCardTimeline(accountId: string | undefined, enabled = true) {
  const from = format(startOfMonth(subMonths(new Date(), 24)), 'yyyy-MM-dd')
  const to = format(endOfMonth(addMonths(new Date(), 12)), 'yyyy-MM-dd')
  return useQuery({
    queryKey: ['credit-card-timeline', accountId, from, to],
    queryFn: () => accounts.creditCardTimeline([accountId!], from, to),
    enabled: !!accountId && enabled,
  })
}

/** Day and month only ("24/10" or "10/24", following the regional setting):
 *  enough to place a closing or due date next to the bill it belongs to. */
export function formatDayMonth(dateStr: string, dateLocale: string) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString(dateLocale, {
    day: '2-digit',
    month: '2-digit',
  })
}

/** A statement is named after the month it falls due: "Dez 2026". */
export function statementMonthLabel(item: Pick<CreditCardTimelineItem, 'due_date' | 'due_month'>, language: string) {
  const label = format(
    parseISO((item.due_date ?? `${item.due_month}-01`) + 'T00:00:00'),
    'MMM yyyy',
    { locale: resolveDateFnsLocale(language) },
  )
  return label.charAt(0).toUpperCase() + label.slice(1)
}

/** "Dez 2026 · Vence 10/12": which bill, and the date that identifies it. */
export function statementOptionLabel(
  item: Pick<CreditCardTimelineItem, 'due_date' | 'due_month'>,
  t: TFunction,
  language: string,
  dateLocale: string,
) {
  const month = statementMonthLabel(item, language)
  return item.due_date
    ? `${month} · ${t('accounts.billHeader.due', { date: formatDayMonth(item.due_date, dateLocale) })}`
    : month
}
