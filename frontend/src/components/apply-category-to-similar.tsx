import { useCallback, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { transactions as transactionsApi } from '@/lib/api'
import { extractApiError } from '@/lib/api-errors'
import { invalidateFinancialQueries } from '@/lib/invalidate-queries'
import type { SimilarTransaction, Transaction } from '@/types'

interface FollowUpOffer {
  categoryId: string
  categoryName: string
  /** What the look-alikes have in common, named once in the title. */
  keyName: string
  byPayee: boolean
  uncategorized: string[]
  recategorized: string[]
}

/** A look-alike is either free to take the category or already has another one. */
export function splitLookalikes(similar: SimilarTransaction[], categoryId: string) {
  const uncategorized: string[] = []
  const recategorized: string[] = []
  for (const row of similar) {
    if (row.category_id === categoryId) continue
    if (row.category_id === null) uncategorized.push(row.id)
    else recategorized.push(row.id)
  }
  return { uncategorized, recategorized }
}

/** Only a saved change to a single, non-null category on a row that is neither
 *  half of a transfer nor split across categories deserves the question. */
function isOfferable(previous: Transaction, saved: Transaction): boolean {
  return (
    !!saved.category_id &&
    saved.category_id !== previous.category_id &&
    !saved.transfer_pair_id &&
    !saved.has_category_lines
  )
}

/** Hand focus to the page once the prompt closes: the edit dialog that led
 *  here is gone, so Radix would otherwise drop it on <body>. */
function focusPageRegion() {
  const target = document.querySelector<HTMLElement>('main h1') ?? document.querySelector<HTMLElement>('main')
  if (!target) return
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1')
  target.focus({ preventScroll: true })
}

/**
 * After an edit has been saved with a new category, offers to give the same
 * category to the payee's other transactions (or those with the same
 * description). The save is already persisted: nothing here waits for it or
 * undoes it, and no prompt appears when there is nothing to change.
 */
export function useApplyCategoryToSimilar(): {
  offer: (previous: Transaction, saved: Transaction) => Promise<void>
  dialog: ReactNode
} {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [current, setCurrent] = useState<FollowUpOffer | null>(null)
  const latestOffer = useRef(0)
  const dismissRef = useRef<HTMLButtonElement>(null)

  const applyMutation = useMutation({
    mutationFn: ({ ids, categoryId }: { ids: string[]; categoryId: string }) =>
      transactionsApi.bulkCategorize(ids, categoryId, 'manual'),
    onSuccess: (result) => {
      toast.success(t('categorization.followUp.applied', { count: result.updated }))
      setCurrent(null)
    },
    onError: (error) => toast.error(extractApiError(error)),
    onSettled: () => invalidateFinancialQueries(queryClient),
  })

  const offer = useCallback(async (previous: Transaction, saved: Transaction) => {
    if (!isOfferable(previous, saved) || !saved.category_id || !saved.category) return
    const request = ++latestOffer.current
    let similar: SimilarTransaction[]
    try {
      similar = await queryClient.fetchQuery({
        queryKey: ['transactions', 'similar', saved.id],
        queryFn: () => transactionsApi.similar(saved.id),
        staleTime: 0,
      })
    } catch {
      // The look-alike lookup is an optional follow-up to a change that is
      // already saved; failing to fetch it must not add an error to that save.
      return
    }
    if (request !== latestOffer.current) return
    const { uncategorized, recategorized } = splitLookalikes(similar, saved.category_id)
    if (uncategorized.length + recategorized.length === 0) return
    const byPayee = !!saved.payee_id
    setCurrent({
      categoryId: saved.category_id,
      categoryName: saved.category.name,
      keyName: byPayee ? saved.payee_name ?? saved.payee ?? saved.description : saved.description,
      byPayee,
      uncategorized,
      recategorized,
    })
  }, [queryClient])

  const close = () => {
    if (!applyMutation.isPending) setCurrent(null)
  }

  const total = current ? current.uncategorized.length + current.recategorized.length : 0
  const mixed = !!current && current.uncategorized.length > 0 && current.recategorized.length > 0
  const apply = (ids: string[]) => {
    if (current) applyMutation.mutate({ ids, categoryId: current.categoryId })
  }
  const pending = applyMutation.isPending

  const dialog = (
    <Dialog open={!!current} onOpenChange={(open) => { if (!open) close() }}>
      {current && (
        <DialogContent
          onOpenAutoFocus={(event) => {
            // Start on the one action that changes nothing.
            event.preventDefault()
            dismissRef.current?.focus()
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            focusPageRegion()
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {t(current.byPayee ? 'transactions.categoryFollowUp.titlePayee' : 'transactions.categoryFollowUp.titleDescription', {
                category: current.categoryName,
                name: current.keyName,
              })}
            </DialogTitle>
            <DialogDescription>
              {t('transactions.categoryFollowUp.summary', { count: total })}
            </DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-1 pl-5 text-sm marker:text-muted-foreground">
            {current.uncategorized.length > 0 && (
              <li>{t('transactions.categoryFollowUp.uncategorized', { count: current.uncategorized.length })}</li>
            )}
            {current.recategorized.length > 0 && (
              <li>{t('transactions.categoryFollowUp.otherCategory', { count: current.recategorized.length })}</li>
            )}
          </ul>
          <DialogFooter className="sm:flex-wrap">
            <Button ref={dismissRef} variant="ghost" className="h-11 w-full sm:w-auto" disabled={pending} onClick={close}>
              {t('transactions.categoryFollowUp.thisOnly')}
            </Button>
            {mixed && (
              <Button variant="outline" className="h-11 w-full sm:w-auto" disabled={pending} onClick={() => apply(current.uncategorized)}>
                {t('transactions.categoryFollowUp.applyUncategorized', { count: current.uncategorized.length })}
              </Button>
            )}
            <Button
              className="h-11 w-full sm:w-auto"
              disabled={pending}
              onClick={() => apply([...current.uncategorized, ...current.recategorized])}
            >
              {pending ? t('common.saving') : t('transactions.categoryFollowUp.applyAll', { count: total })}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  )

  return { offer, dialog }
}
