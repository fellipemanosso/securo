import { ArrowLeftRight, Ban } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Category } from '@/types'
import { cn } from '@/lib/utils'

/**
 * What changes how a category counts in reports: a transfer is money moving
 * between the user's own accounts, an ignored category is left out entirely.
 * Both are the rare, consequential marks, so they get a glyph and a tint of
 * their own, apart from the neutral badges (hidden, custom).
 */
export type ReportFlag = 'transfer' | 'ignored'

const FLAG_ICON = { transfer: ArrowLeftRight, ignored: Ban } as const

// Text is the 900 (light) / 200 (dark) step of the hue on a 15% wash of it, so
// the label clears 4.5:1 on the card in both themes.
const FLAG_TONE: Record<ReportFlag, string> = {
  transfer:
    'border-sky-600/40 bg-sky-500/15 text-sky-900 dark:border-sky-400/40 dark:bg-sky-400/15 dark:text-sky-200',
  ignored:
    'border-amber-600/40 bg-amber-500/15 text-amber-900 dark:border-amber-400/40 dark:bg-amber-400/15 dark:text-amber-200',
}

const FLAG_LABEL_KEY = {
  transfer: 'categories.treatAsTransferBadge',
  ignored: 'categories.ignoreTransferBadge',
} as const

const FLAG_DESCRIPTION_KEY = {
  transfer: 'categories.treatAsTransferDesc',
  ignored: 'categories.ignoreTransferDesc',
} as const

export function categoryReportFlags(
  category: Pick<Category, 'treat_as_transfer' | 'is_ignored'>,
): ReportFlag[] {
  const flags: ReportFlag[] = []
  if (category.treat_as_transfer) flags.push('transfer')
  if (category.is_ignored) flags.push('ignored')
  return flags
}

export function useReportFlagText(flag: ReportFlag) {
  const { t } = useTranslation()
  return { label: t(FLAG_LABEL_KEY[flag]), description: t(FLAG_DESCRIPTION_KEY[flag]) }
}

export function ReportFlagIcon({ flag, className }: { flag: ReportFlag; className?: string }) {
  const Icon = FLAG_ICON[flag]
  return <Icon aria-hidden="true" className={cn('size-3 shrink-0', className)} />
}

/** The class set shared by every placement of the mark. */
export function reportFlagClass(flag: ReportFlag) {
  return cn(
    'inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium',
    FLAG_TONE[flag],
  )
}

/** The mark as plain text with its glyph, for lists that cannot hold a tooltip. */
export function ReportFlagChip({ flag }: { flag: ReportFlag }) {
  const { label } = useReportFlagText(flag)
  return (
    <span className={reportFlagClass(flag)}>
      <ReportFlagIcon flag={flag} />
      {label}
    </span>
  )
}
