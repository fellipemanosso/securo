import { getAccountName } from '@/lib/account-utils'
import { AccountIcon } from '@/components/account-icon'
import { CategorySplitBadge, TransactionCategoryIcon } from '@/components/category-lines-display'
import { ProjectedTransactionBadge } from '@/components/projected-transaction-badge'
import { TransactionChip, billChipLabel } from '@/components/transaction-chip'
import { isSplitByCategory } from '@/lib/category-lines'
import type { Transaction, Account } from '@/types'
import { AlertTriangle, ArrowLeftRight, CalendarClock, ChartNoAxesColumn, Clock, EyeClosed, Paperclip } from 'lucide-react'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { useTranslation } from 'react-i18next'
import { formatCurrency } from '@/lib/format'
import { shouldShowPendingBadge } from '@/lib/transaction-status'
import { isTransferTransaction } from '@/lib/transaction-transfer'
import { transactionDescription } from '@/lib/transaction-description'

/** Keep long merchant references on one line when there are no word breaks. */
function hasWordBreaks(text: string): boolean {
  return /\s/.test(text)
}

interface MobileTransactionRowProps {
  tx: Transaction
  account: Account | undefined
  groupName: string | undefined
  selected: boolean
  selectable: boolean
  canWrite: boolean
  highlighted: boolean
  highlightedRowRef?: React.Ref<HTMLDivElement>
  locale: string
  /** Regional date format for the row's accessible name; defaults to `locale`. */
  dateLocale?: string
  userCurrency: string
  onSelect: (id: string, shiftKey: boolean) => void
  onClick: (tx: Transaction) => void
  /** Show the payee instead of the account name in an account-scoped view. */
  showPayee?: boolean
  /** Localize synthetic opening-balance descriptions only in account detail. */
  localizeOpeningBalance?: boolean
}

export function MobileTransactionRow({
  tx,
  account,
  groupName,
  selected,
  selectable,
  canWrite,
  highlighted,
  highlightedRowRef,
  locale,
  dateLocale = locale,
  userCurrency,
  onSelect,
  onClick,
  showPayee = false,
  localizeOpeningBalance = false,
}: MobileTransactionRowProps) {
  const { mask } = usePrivacyMode()
  const { t, i18n } = useTranslation()
  const description = localizeOpeningBalance
    ? transactionDescription(tx.description, tx.source, t)
    : tx.description

  const displayAmount = tx.is_shared && tx.viewer_share != null
    ? Number(tx.viewer_share)
    : Number(tx.amount)

  const amountColor = tx.is_ignored
    ? 'text-gray-500'
    : tx.type === 'credit'
      ? 'text-emerald-600'
      : 'text-rose-500'

  const virtual = tx.virtual === true
  // Projections, rows shared from a group, a read-only workspace and the
  // synthetic opening balance have nothing to edit.
  const interactive = !virtual && !tx.is_shared && canWrite && tx.source !== 'opening_balance'
  const amountText = `${tx.is_ignored ? ' ' : tx.type === 'credit' ? '+' : '\u2212'}${formatCurrency(
    Math.abs(displayAmount),
    tx.currency,
    locale,
  )}`

  return (
    <div
      ref={highlighted ? highlightedRowRef : undefined}
      className={`flex items-center gap-3 pl-3 pr-3 py-3 border-b border-border last:border-0 transition-colors ${
        selected ? 'bg-primary/5' : 'bg-card'
      } ${highlighted ? 'securo-highlight-flash' : ''} ${
        virtual ? 'opacity-80' : ''
      } ${
        interactive ? 'cursor-pointer active:bg-muted/60' : 'cursor-default'
      }`}
      onClick={() => {
        if (interactive) onClick(tx)
      }}
    >
      {/* Checkbox */}
      {selectable && (
        <div className="shrink-0">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => {}}
            onClick={(e) => {
              e.stopPropagation()
              onSelect(tx.id, e.shiftKey)
            }}
            className="h-4 w-4 rounded border-border accent-primary cursor-pointer"
          />
        </div>
      )}
      {/* The row's content is the edit control: the checkbox beside it stays
          its own control instead of nesting inside a button. */}
      <div
        role={interactive ? 'button' : undefined}
        tabIndex={interactive ? 0 : undefined}
        aria-label={interactive
          ? t('transactions.editRowLabel', {
              description,
              date: new Date(tx.date + 'T00:00:00').toLocaleDateString(dateLocale),
              amount: mask(amountText),
            })
          : undefined}
        onKeyDown={interactive
          ? (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              onClick(tx)
            }
          : undefined}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
      >
        {/* Category Icon */}
        <div className="shrink-0">
          <TransactionCategoryIcon tx={tx} size="md" />
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          {/* Description row. The markers are the desktop row's chips, word
              for word; they wrap under a long description instead of
              squeezing it. */}
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <p className={`text-sm font-semibold text-foreground leading-tight min-w-0 ${hasWordBreaks(description) ? 'break-words whitespace-normal' : 'truncate'}`}>
              {description}
            </p>
            {tx.group_id && (
              <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wide text-violet-700 bg-violet-50 border border-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-900 px-1 py-0.5 rounded-full shrink-0">
                {tx.is_shared && tx.parent_owner_name ? tx.parent_owner_name : t('splitGroups.ownerRowBadge', { group: groupName ?? '' })}
              </span>
            )}
            {isSplitByCategory(tx) && <CategorySplitBadge tx={tx} compact className="shrink-0 text-[10px] px-1" />}
            {isTransferTransaction(tx) && (
              <TransactionChip>
                <ArrowLeftRight aria-hidden="true" />
                {t('transactions.transfer')}
              </TransactionChip>
            )}
            {tx.is_ignored && (
              <TransactionChip>
                <EyeClosed aria-hidden="true" />
                {t('transactions.ignored')}
              </TransactionChip>
            )}
            {virtual && <ProjectedTransactionBadge />}
            {tx.recurring_transaction_id != null && !virtual && (
              <TransactionChip>{t('transactions.recurringBadge')}</TransactionChip>
            )}
            {tx.installment_number != null && tx.total_installments != null && (
              <TransactionChip className="tabular-nums">
                {tx.installment_number}/{tx.total_installments}
              </TransactionChip>
            )}
            {tx.effective_bill_date && (
              <TransactionChip>
                <CalendarClock aria-hidden="true" />
                {billChipLabel(tx.effective_bill_date, t, i18n.resolvedLanguage ?? i18n.language)}
              </TransactionChip>
            )}
            {tx.exclude_from_pnl && !tx.is_ignored && (
              <ChartNoAxesColumn
                className="h-3 w-3 text-slate-500 shrink-0"
                aria-label={t('transactions.excludedFromReports')}
              />
            )}
            {(tx.attachment_count ?? 0) > 0 && (
              <Paperclip size={11} className="text-muted-foreground shrink-0" role="img" aria-label={t('transactions.attachments')} />
            )}
          </div>

          {/* Account row or payee row */}
          {showPayee ? (
            (tx.payee_name || tx.payee) && (tx.payee_name || tx.payee) !== tx.description ? (
              <p className="text-xs text-muted-foreground mt-0.5 truncate">
                {tx.payee_name || tx.payee}
              </p>
            ) : null
          ) : (
            account && (
              <div className="flex items-center gap-1.5 mt-0.5">
                <AccountIcon account={account} size="xs" />
                <span className="text-xs text-muted-foreground truncate">
                  {getAccountName(account)}
                </span>
                {tx.transfer_counterpart && (
                  <>
                    <ArrowLeftRight className="h-3 w-3 text-blue-600 shrink-0" aria-hidden="true" />
                    <span className="text-xs text-muted-foreground truncate">
                      {tx.transfer_counterpart.account_name}
                    </span>
                  </>
                )}
              </div>
            )
          )}
        </div>

        {/* Amount, and whether it has settled: said in words, not only by
            an icon. A projection is already marked as one. */}
        <div className="shrink-0 text-right">
          <span className={`text-sm font-bold tabular-nums ${amountColor}`}>
            {mask(amountText)}
          </span>
          {shouldShowPendingBadge(tx) && !virtual && (
            <div className="mt-0.5 flex items-center justify-end gap-1 text-[11px] font-medium text-muted-foreground">
              <Clock size={11} aria-hidden="true" />
              {t('transactions.pending')}
            </div>
          )}
          {tx.amount_primary != null && tx.currency !== userCurrency && (
            <div className="flex items-center justify-end gap-0.5 mt-0.5">
              {tx.fx_fallback && (
                <AlertTriangle size={10} className="text-amber-500 shrink-0" />
              )}
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {mask(formatCurrency(Math.abs(tx.amount_primary), userCurrency, locale))}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
