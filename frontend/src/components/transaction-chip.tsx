import type { ComponentProps } from 'react'
import { format, parseISO } from 'date-fns'
import type { TFunction } from 'i18next'

import { resolveDateFnsLocale } from '@/lib/date-fns-locale'
import { cn } from '@/lib/utils'

/** Neutral states a fact about the row (a transfer, an installment, the bill
 *  it sits on); forecast marks a row Securo projects and the bank has not
 *  sent. Warnings are not chips: they keep their own amber treatment. */
export type TransactionChipTone = 'neutral' | 'forecast'

const TONES: Record<TransactionChipTone, string> = {
  neutral: 'border-border bg-muted text-foreground/75',
  forecast: 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-300',
}

/** Classes for an element that has to be its own control (a help trigger)
 *  but still reads as a chip. */
export function transactionChipClass(tone: TransactionChipTone = 'neutral') {
  return cn(
    'inline-flex h-5 max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-1.5 text-[10px] font-semibold uppercase leading-none tracking-wide [&_svg]:size-3 [&_svg]:shrink-0',
    TONES[tone],
  )
}

/** The one marker shape for transaction rows, on desktop and mobile alike. */
export function TransactionChip({
  tone = 'neutral',
  className,
  ...props
}: ComponentProps<'span'> & { tone?: TransactionChipTone }) {
  return <span data-tone={tone} className={cn(transactionChipClass(tone), className)} {...props} />
}

/** "Fatura dez": the bill a charge was moved to, named like the bill header
 *  names it, by the month it falls due. */
export function billChipLabel(dueDate: string, t: TFunction, language: string) {
  const month = format(parseISO(dueDate + 'T00:00:00'), 'MMM', { locale: resolveDateFnsLocale(language) })
  return t('transactions.billChip', { month })
}
