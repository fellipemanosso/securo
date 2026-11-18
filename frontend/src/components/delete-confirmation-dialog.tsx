import { useTranslation } from 'react-i18next'
import { Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

type DeleteConfirmationDialogProps = {
  open: boolean
  title: string
  description: string
  isPending: boolean
  onClose: () => void
  onCancel?: () => void
  onConfirm: () => void
  /** Where focus goes after the dialog closes; see Radix `onCloseAutoFocus`. */
  onCloseAutoFocus?: (event: Event) => void
}

export function DeleteConfirmationDialog({
  open,
  title,
  description,
  isPending,
  onClose,
  onCancel = onClose,
  onConfirm,
  onCloseAutoFocus,
}: DeleteConfirmationDialogProps) {
  const { t } = useTranslation()

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isPending) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={!isPending} onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" className="h-11 sm:h-9" onClick={onCancel} disabled={isPending}>
            {t('common.cancel')}
          </Button>
          <Button variant="destructive" className="h-11 sm:h-9" onClick={onConfirm} disabled={isPending}>
            <Trash2 size={14} className="mr-1" />
            {t('common.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
