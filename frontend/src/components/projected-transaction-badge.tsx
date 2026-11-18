import { useTranslation } from 'react-i18next'

import { TransactionChip } from '@/components/transaction-chip'

/** Canonical badge for a virtual transaction projection. */
export function ProjectedTransactionBadge() {
  const { t } = useTranslation()

  return <TransactionChip tone="forecast">{t('transactions.projected')}</TransactionChip>
}
