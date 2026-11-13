import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, CreditCard, Eye, EyeOff, Pencil, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { accountCardLabel } from '@/lib/account-utils'
import type { AccountCard } from '@/types'

interface Props {
  cards: AccountCard[]
  canWrite: boolean
  onToggleHidden: (card: AccountCard) => void
  onRename: (card: AccountCard, alias: string) => void
}

export function AccountCardsControl({ cards, canWrite, onToggleHidden, onRename }: Props) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const startEdit = (card: AccountCard) => {
    setEditing(card.last4)
    setDraft(card.alias ?? '')
  }
  const commit = (card: AccountCard) => {
    onRename(card, draft.trim())
    setEditing(null)
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 border border-border rounded-lg px-3 py-1.5 text-sm bg-card text-foreground hover:bg-muted/50 transition-all cursor-pointer"
        >
          <CreditCard className="h-4 w-4 text-muted-foreground" />
          {t('accountCards.title')} ({cards.length})
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-2 space-y-1">
        {cards.map((card) => (
          <div key={card.last4} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50">
            {editing === card.last4 ? (
              <>
                <Input
                  autoFocus
                  value={draft}
                  maxLength={100}
                  placeholder={`•••• ${card.last4}`}
                  aria-label={t('accountCards.aliasLabel')}
                  className="h-7 text-sm"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commit(card)
                    if (e.key === 'Escape') setEditing(null)
                  }}
                />
                <button
                  type="button"
                  title={t('accountCards.save')}
                  aria-label={t('accountCards.save')}
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => commit(card)}
                >
                  <Check className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  title={t('accountCards.cancel')}
                  aria-label={t('accountCards.cancel')}
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setEditing(null)}
                >
                  <X className="h-4 w-4" />
                </button>
              </>
            ) : (
              <>
                <div className={`min-w-0 flex-1 ${card.is_hidden ? 'opacity-60' : ''}`}>
                  <p className="truncate text-sm font-medium text-foreground">{accountCardLabel(card)}</p>
                  <p className="text-xs text-muted-foreground">{t('accountCards.transactionCount', { count: card.transaction_count })}</p>
                </div>
                {canWrite && (
                  <>
                    <button
                      type="button"
                      title={t('accountCards.editAlias')}
                      aria-label={t('accountCards.editAlias')}
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => startEdit(card)}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      title={card.is_hidden ? t('accountCards.show') : t('accountCards.hide')}
                      aria-label={card.is_hidden ? t('accountCards.show') : t('accountCards.hide')}
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => onToggleHidden(card)}
                    >
                      {card.is_hidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  )
}
