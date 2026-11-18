import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import axios from 'axios'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { categories as categoriesApi, categoryGroups as groupsApi } from '@/lib/api'
import { extractApiError } from '@/lib/api-errors'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { DeleteConfirmationDialog } from '@/components/delete-confirmation-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { Category, CategoryGroup, CategoryUsage } from '@/types'
import {
  Pencil,
  Trash2,
  Plus,
  FolderPlus,
  FolderX,
  MoreHorizontal,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  CircleAlert,
  Eye,
  EyeOff,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/page-header'
import { PageRefreshButton } from '@/components/page-refresh-button'
import { invalidateCategoryQueries } from '@/lib/invalidate-queries'
import { CategoryIcon } from '@/components/category-icon'
import { CategorySelect } from '@/components/category-select'
import { IconPicker } from '@/components/icon-picker'
import { useWorkspace } from '@/contexts/workspace-context'

// Stands in for a group id so "no group" collapses with the real groups.
const UNGROUPED = '__ungrouped__'

// Tailwind's `sm` breakpoint: from here up rows show three buttons, below it one menu.
const SM_QUERY = '(min-width: 640px)'

const COLLAPSED_STORAGE_KEY = 'securo:categories:collapsed'

const BADGE_CLASS =
  'text-[11px] font-medium px-1.5 py-0.5 rounded bg-muted text-foreground/80 border border-border shrink-0'

const FOCUS_RING = 'outline-none focus-visible:ring-2 focus-visible:ring-primary'

const FLASH_MS = 2400

function loadCollapsed(workspaceId: string): Set<string> {
  try {
    const raw = localStorage.getItem(`${COLLAPSED_STORAGE_KEY}:${workspaceId}`)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(
      Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [],
    )
  } catch {
    // Storage can be unavailable or hold something else: start expanded.
    return new Set()
  }
}

function saveCollapsed(workspaceId: string, collapsed: Set<string>) {
  try {
    localStorage.setItem(`${COLLAPSED_STORAGE_KEY}:${workspaceId}`, JSON.stringify([...collapsed]))
  } catch {
    // Not persisting the collapsed sections is not worth an error.
  }
}

function SectionCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
      {children}
    </div>
  )
}

type RowAction = {
  key: 'edit' | 'visibility' | 'delete'
  label: string
  /** Name for assistive tech; says which row the control acts on. */
  ariaLabel: string
  icon: React.ReactNode
  onSelect: () => void
  disabled?: boolean
  destructive?: boolean
}

// Edit, hide and delete each keep one slot, so a row without the hide button
// still lines its pencil and bin up with the rows that have it.
const ACTION_SLOTS: RowAction['key'][] = ['edit', 'visibility', 'delete']

/**
 * Edit / hide / delete for one row. From `sm` up they are three buttons; on a
 * phone three 25px targets side by side are a mis-tap away from deleting, so
 * they collapse into one 44px menu. Every control names the row it acts on.
 * `setOpener` receives the control that was used, so closing the dialog it
 * opened can hand focus back to it. `focusKey` marks the primary control so
 * focus can be sent to a row after a neighbouring one is deleted.
 */
function RowActions({
  actions,
  menuAriaLabel,
  focusKey,
  setOpener,
}: {
  actions: RowAction[]
  menuAriaLabel: string
  focusKey?: string
  setOpener: (element: HTMLElement | null) => void
}) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  return (
    <div className="flex items-center shrink-0 ml-2">
      <div className="hidden sm:flex w-[104px] items-center justify-end gap-1">
        {ACTION_SLOTS.map((slot, index) => {
          const action = actions.find((candidate) => candidate.key === slot)
          if (!action) return <span key={slot} aria-hidden="true" className="size-8 shrink-0" />
          return (
            <button
              key={slot}
              type="button"
              title={action.label}
              aria-label={action.ariaLabel}
              disabled={action.disabled}
              data-focus={index === 0 ? focusKey : undefined}
              onClick={(event) => {
                setOpener(event.currentTarget)
                action.onSelect()
              }}
              className={cn(
                'inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors cursor-pointer disabled:cursor-default disabled:opacity-50',
                FOCUS_RING,
                action.destructive
                  ? 'hover:bg-rose-500/10 hover:text-rose-500'
                  : 'hover:bg-primary/5 hover:text-primary',
              )}
            >
              {action.icon}
            </button>
          )
        })}
      </div>
      <div className="sm:hidden">
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              ref={triggerRef}
              type="button"
              aria-label={menuAriaLabel}
              data-focus-touch={focusKey}
              className={cn(
                'inline-flex size-11 items-center justify-center rounded-md text-muted-foreground transition-colors cursor-pointer hover:bg-muted',
                FOCUS_RING,
              )}
            >
              <MoreHorizontal size={18} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {actions.map((action) => (
              <DropdownMenuItem
                key={action.key}
                disabled={action.disabled}
                className={cn('min-h-11 gap-2', action.destructive && 'text-rose-500 focus:text-rose-500')}
                onSelect={() => {
                  setOpener(triggerRef.current)
                  action.onSelect()
                }}
              >
                {action.icon}
                {action.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

/**
 * A badge that explains itself. A `title` never reaches keyboard or touch, so
 * this is a button: focus opens the tooltip, and a tap toggles it (Radix
 * leaves taps to the trigger's own click, which would otherwise do nothing).
 */
function BadgeHint({ label, description }: { label: string; description: string }) {
  const [open, setOpen] = useState(false)
  return (
    <TooltipProvider>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault()
              setOpen((current) => !current)
            }}
            className={cn(
              BADGE_CLASS,
              'relative cursor-help before:absolute before:-inset-x-1 before:-inset-y-3 before:content-[""]',
              FOCUS_RING,
            )}
          >
            {label}
          </button>
        </TooltipTrigger>
        <TooltipContent>{description}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

// The picker renders a grid of every icon; typing in the name field should not redraw it.
const MemoIconPicker = memo(IconPicker)

function ColorField({
  id,
  name,
  value,
  onChange,
}: {
  id: string
  name: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className="flex items-center gap-3">
      <Input
        id={id}
        name={name}
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required
        className="h-11 w-16 shrink-0 px-1.5 py-1 sm:h-9"
      />
      <span className="font-mono text-sm uppercase tabular-nums text-muted-foreground">{value}</span>
    </div>
  )
}

function DialogError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="mt-3 flex shrink-0 items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-foreground"
    >
      <CircleAlert size={16} className="mt-0.5 shrink-0 text-rose-600 dark:text-rose-400" />
      <span className="min-w-0 break-words">{message}</span>
    </div>
  )
}

function LoadingSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      {[3, 2, 3].map((rows, section) => (
        <div key={section}>
          <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-3 sm:px-5">
            <Skeleton className="size-3.5" />
            <Skeleton className="size-8 rounded-lg" />
            <Skeleton className="h-4 w-32" />
          </div>
          {Array.from({ length: rows }, (_, row) => (
            <div
              key={row}
              className="flex items-center gap-3 border-b border-border py-2.5 pl-11 pr-4 last:border-0 sm:pl-12 sm:pr-5"
            >
              <Skeleton className="size-8 shrink-0 rounded-lg" />
              <Skeleton className="h-4 w-40 max-w-[50%]" />
              <Skeleton className="ml-auto h-3.5 w-20" />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

type CategoryFormValues = Pick<Category, 'name' | 'icon' | 'color' | 'treat_as_transfer' | 'is_ignored'> & {
  group_id: string | null
}

/**
 * The category fields. They hold their own state so that typing a name
 * re-renders the form and not the whole list behind the dialog.
 */
function CategoryForm({
  category,
  groups,
  error,
  pending,
  onSubmit,
  onCancel,
}: {
  category: Category | null
  groups: CategoryGroup[] | undefined
  error: unknown
  pending: boolean
  onSubmit: (values: CategoryFormValues) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(category?.name ?? '')
  const [groupId, setGroupId] = useState(category?.group_id ?? '')
  const [icon, setIcon] = useState(category?.icon ?? 'circle-help')
  const [color, setColor] = useState(category?.color ?? '#6366f1')
  const [treatAsTransfer, setTreatAsTransfer] = useState(category?.treat_as_transfer ?? false)
  const [ignoreTransfer, setIgnoreTransfer] = useState(category?.is_ignored ?? false)
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit({
          name,
          icon,
          color,
          group_id: groupId || null,
          treat_as_transfer: treatAsTransfer,
          is_ignored: ignoreTransfer,
        })
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      {/* The negative margin and matching padding keep focus rings from
          being clipped by the scroll area while the fields still line up
          with the footer. */}
      <div className="-mx-1 min-h-0 flex-1 space-y-4 overflow-y-auto px-1">
        <div aria-hidden="true" className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
          <CategoryIcon icon={icon} color={color} size="md" />
          <span className={cn('min-w-0 truncate text-sm font-medium', name.trim() ? 'text-foreground' : 'text-muted-foreground')}>
            {name.trim() || t('groups.name')}
          </span>
        </div>
        <div className="space-y-2">
          <Label htmlFor="category-name">{t('groups.name')}</Label>
          <Input
            id="category-name"
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="h-11 sm:h-9"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="category-group">{t('categories.group')}</Label>
          <select
            id="category-group"
            name="group_id"
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
            className="h-11 w-full rounded-lg border border-border bg-card px-3 text-base text-foreground focus:outline-none focus:ring-2 focus:ring-primary sm:h-9 sm:text-sm"
          >
            <option value="">{t('categories.noGroup')}</option>
            {groups?.filter((g) => !g.is_hidden || g.id === category?.group_id).map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}{g.is_hidden ? ` (${t('groups.hiddenBadge')})` : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="category-color">{t('groups.color')}</Label>
          <ColorField id="category-color" name="color" value={color} onChange={setColor} />
        </div>
        <div className="space-y-2">
          <Label>{t('groups.icon')}</Label>
          <MemoIconPicker value={icon} color={color} onChange={setIcon} />
        </div>
        <div className="divide-y divide-border border-t border-border">
          <label className="flex min-h-11 cursor-pointer items-start gap-3 py-3">
            <input
              type="checkbox"
              checked={treatAsTransfer}
              onChange={(e) => setTreatAsTransfer(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-primary"
            />
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-foreground">{t('categories.treatAsTransfer')}</span>
              <p className="text-xs text-muted-foreground mt-0.5">{t('categories.treatAsTransferDesc')}</p>
            </div>
          </label>
          <label className="flex min-h-11 cursor-pointer items-start gap-3 py-3">
            <input
              type="checkbox"
              checked={ignoreTransfer}
              onChange={(e) => setIgnoreTransfer(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-primary"
            />
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-foreground">{t('categories.ignoreTransfer')}</span>
              <p className="text-xs text-muted-foreground mt-0.5">{t('categories.ignoreTransferDesc')}</p>
            </div>
          </label>
        </div>
      </div>
      {error != null && <DialogError message={extractApiError(error, t('common.error'))} />}
      <DialogFooter className="mt-2 shrink-0 border-t pt-4">
        <Button type="button" variant="outline" className="h-11 sm:h-9" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" className="h-11 sm:h-9" disabled={pending}>
          {pending ? t('common.saving') : t('common.save')}
        </Button>
      </DialogFooter>
    </form>
  )
}

type GroupFormValues = Pick<CategoryGroup, 'name' | 'icon' | 'color' | 'position'>

function GroupForm({
  group,
  error,
  pending,
  onSubmit,
  onCancel,
}: {
  group: CategoryGroup | null
  error: unknown
  pending: boolean
  onSubmit: (values: GroupFormValues) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [icon, setIcon] = useState(group?.icon ?? 'folder')
  const [color, setColor] = useState(group?.color ?? '#6B7280')
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        const formData = new FormData(e.currentTarget)
        onSubmit({
          name: formData.get('name') as string,
          icon,
          color,
          position: parseInt(formData.get('position') as string) || 0,
        })
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="-mx-1 min-h-0 flex-1 space-y-4 overflow-y-auto px-1">
        <div className="space-y-2">
          <Label htmlFor="group-name">{t('groups.name')}</Label>
          <Input id="group-name" name="name" defaultValue={group?.name ?? ''} required className="h-11 sm:h-9" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="group-position">{t('groups.position')}</Label>
          <Input
            id="group-position"
            name="position"
            type="number"
            defaultValue={group?.position?.toString() ?? '0'}
            aria-describedby="group-position-help"
            className="h-11 sm:h-9"
          />
          <p id="group-position-help" className="text-xs text-muted-foreground">{t('groups.positionHelp')}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="group-color">{t('groups.color')}</Label>
          <ColorField id="group-color" name="color" value={color} onChange={setColor} />
        </div>
        <div className="space-y-2">
          <Label>{t('groups.icon')}</Label>
          <MemoIconPicker value={icon} color={color} onChange={setIcon} />
        </div>
      </div>
      {error != null && <DialogError message={extractApiError(error, t('common.error'))} />}
      <DialogFooter className="mt-2 shrink-0 border-t pt-4">
        <Button type="button" variant="outline" className="h-11 sm:h-9" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" className="h-11 sm:h-9" disabled={pending}>
          {pending ? t('common.saving') : t('common.save')}
        </Button>
      </DialogFooter>
    </form>
  )
}

export default function CategoriesPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { canWrite, current } = useWorkspace()
  const workspaceId = current?.id ?? 'default'
  const pageRef = useRef<HTMLDivElement>(null)
  const [catDialogOpen, setCatDialogOpen] = useState(false)
  const [editingCat, setEditingCat] = useState<Category | null>(null)
  const [groupDialogOpen, setGroupDialogOpen] = useState(false)
  const [editingGroup, setEditingGroup] = useState<CategoryGroup | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => loadCollapsed(workspaceId))
  const [collapsedWorkspaceId, setCollapsedWorkspaceId] = useState(workspaceId)
  const [deletingCategory, setDeletingCategory] = useState<Category | null>(null)
  const [deletingGroup, setDeletingGroup] = useState<CategoryGroup | null>(null)
  const [hidingCategory, setHidingCategory] = useState<
    { category: Category; rules: { id: string; name: string }[] } | null
  >(null)
  // Set when the category being deleted still holds something. The deletion
  // then waits for a destination instead of going through.
  const [transferringCategory, setTransferringCategory] = useState<
    { category: Category; usage: CategoryUsage } | null
  >(null)
  const [transferTargetId, setTransferTargetId] = useState('')
  // The row or group just created or edited: scrolled into view and flashed.
  const [flash, setFlash] = useState<string | null>(null)
  const pendingFlashRef = useRef<{ id: string; section: string } | null>(null)
  const flashTimerRef = useRef<number | undefined>(undefined)

  // Each workspace keeps its own set of collapsed sections.
  if (collapsedWorkspaceId !== workspaceId) {
    setCollapsedWorkspaceId(workspaceId)
    setCollapsedGroups(loadCollapsed(workspaceId))
  }

  // The control that opened a dialog. Dialogs here are driven by state, not by
  // a trigger, so Radix has nothing to return focus to when they close.
  const openerRef = useRef<HTMLElement | null>(null)
  const setOpener = (element: HTMLElement | null) => {
    openerRef.current = element
  }
  // Where focus goes when the opener is about to disappear (a deleted row):
  // candidates in order of preference, each a `data-focus` key.
  const successorRef = useRef<string[] | null>(null)
  const focusFirst = (keys: string[]) => {
    const root = pageRef.current
    if (!root) return false
    const wide = window.matchMedia(SM_QUERY).matches
    for (const key of keys) {
      const selectors = wide
        ? [`[data-focus="${key}"]`]
        : [`[data-focus-touch="${key}"]`, `[data-focus="${key}"]`]
      for (const selector of selectors) {
        const element = root.querySelector<HTMLElement>(selector)
        if (element) {
          element.focus()
          return true
        }
      }
    }
    return false
  }
  const restoreFocus = (event: Event) => {
    // The dialog that saved the row has just released the page scroll lock.
    requestAnimationFrame(startFlash)
    const successors = successorRef.current
    if (successors) {
      successorRef.current = null
      event.preventDefault()
      if (focusFirst(successors)) return
    }
    const opener = openerRef.current
    if (opener?.isConnected) {
      event.preventDefault()
      opener.focus()
    }
  }

  const {
    data: groups,
    isPending: groupsPending,
    isError: groupsError,
    refetch: refetchGroups,
  } = useQuery({
    queryKey: ['category-groups', 'management'],
    queryFn: groupsApi.listIncludingHidden,
  })

  const {
    data: categoriesList,
    isFetching: categoriesFetching,
    isPending: categoriesPending,
    isError: categoriesError,
    refetch: refetchCategories,
  } = useQuery({
    queryKey: ['categories', 'management'],
    queryFn: categoriesApi.listIncludingHidden,
  })

  const invalidateAll = () => {
    invalidateCategoryQueries(queryClient)
  }

  const ungrouped = useMemo(() => categoriesList?.filter((c) => !c.group_id) ?? [], [categoriesList])
  const sectionIds = useMemo(
    () => [...(groups ?? []).map((g) => g.id), ...(ungrouped.length > 0 ? [UNGROUPED] : [])],
    [groups, ungrouped],
  )
  // Saved with the collapsed set: sections that no longer exist are dropped, so
  // storage does not keep ids of deleted groups.
  const updateCollapsed = useCallback(
    (next: Set<string>) => {
      const known = new Set(sectionIds)
      const kept = groups && categoriesList ? new Set([...next].filter((id) => known.has(id))) : next
      setCollapsedGroups(kept)
      saveCollapsed(workspaceId, kept)
    },
    [workspaceId, sectionIds, groups, categoriesList],
  )
  // Usage comes with the categories list; the groups' nested copies carry none.
  const transactionCounts = useMemo(
    () => new Map((categoriesList ?? []).map((cat) => [cat.id, cat.transaction_count])),
    [categoriesList],
  )

  // After a create or edit: open the section holding the row, then scroll to it
  // and flash it once the refreshed list has put it there and the dialog that
  // saved it has let go of the page scroll (which it locks while it is open).
  const revealRow = (id: string, section: string, expand: boolean) => {
    if (expand && collapsedGroups.has(section)) {
      const next = new Set(collapsedGroups)
      next.delete(section)
      updateCollapsed(next)
    }
    window.clearTimeout(flashTimerRef.current)
    setFlash(null)
    pendingFlashRef.current = { id, section }
  }
  const startFlash = useCallback(() => {
    const pending = pendingFlashRef.current
    if (!pending || document.body.hasAttribute('data-scroll-locked')) return
    const element = pageRef.current?.querySelector<HTMLElement>(`[data-row-id="${pending.id}"]`)
    if (!element || element.closest<HTMLElement>('[data-section]')?.dataset.section !== pending.section) return
    pendingFlashRef.current = null
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    element.scrollIntoView?.({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' })
    setFlash(pending.id)
    flashTimerRef.current = window.setTimeout(() => setFlash(null), FLASH_MS)
  }, [])
  useEffect(() => {
    startFlash()
  }, [startFlash, groups, categoriesList, collapsedGroups, catDialogOpen, groupDialogOpen])
  useEffect(() => () => window.clearTimeout(flashTimerRef.current), [])

  const categorySavedMessage = (cat: Category, verb: 'created' | 'updated') => {
    const groupName = cat.group_id ? groups?.find((g) => g.id === cat.group_id)?.name : undefined
    return groupName
      ? t(`categories.${verb}In`, { name: cat.name, group: groupName })
      : t(`categories.${verb}Ungrouped`, { name: cat.name })
  }

  const createCatMutation = useMutation({
    mutationFn: (cat: Partial<Category>) => categoriesApi.create(cat),
    onSuccess: (cat) => {
      invalidateAll()
      setCatDialogOpen(false)
      revealRow(cat.id, cat.group_id ?? UNGROUPED, true)
      toast.success(categorySavedMessage(cat, 'created'))
    },
    onError: (err: unknown) => toast.error(extractApiError(err, t('common.error'))),
  })
  const updateCatMutation = useMutation({
    mutationFn: ({ id, ...data }: Partial<Category> & { id: string }) => categoriesApi.update(id, data),
    onSuccess: (cat) => {
      invalidateAll()
      setCatDialogOpen(false)
      setEditingCat(null)
      revealRow(cat.id, cat.group_id ?? UNGROUPED, true)
      toast.success(categorySavedMessage(cat, 'updated'))
    },
    onError: (err: unknown) => toast.error(extractApiError(err, t('common.error'))),
  })
  const showCatMutation = useMutation({
    mutationFn: (id: string) => categoriesApi.update(id, { is_hidden: false }),
    onSuccess: () => {
      invalidateAll()
      toast.success(t('categories.updated'))
    },
    onError: (err: unknown) => toast.error(extractApiError(err, t('common.error'))),
  })

  // Hiding is its own mutation: it can also retire the rules that assign the
  // category, and it must refresh the rule list rather than the category form.
  const hideCatMutation = useMutation({
    mutationFn: ({ id, deactivateRules }: { id: string; deactivateRules: boolean }) =>
      categoriesApi.update(id, { is_hidden: true }, { deactivateRules }),
    onSuccess: (_data, variables) => {
      invalidateAll()
      if (variables.deactivateRules) queryClient.invalidateQueries({ queryKey: ['rules'] })
      setHidingCategory(null)
      toast.success(t('categories.updated'))
    },
    onError: (err: unknown) => toast.error(extractApiError(err, t('common.error'))),
  })

  // Rules that still file transactions into a category outlive hiding it, so
  // check for them first and only interrupt the user when there are any.
  async function handleToggleHidden(cat: Category) {
    if (cat.is_hidden) {
      showCatMutation.mutate(cat.id)
      return
    }
    try {
      const usage = await queryClient.fetchQuery({
        queryKey: ['category-rule-usage', cat.id],
        queryFn: () => categoriesApi.ruleUsage(cat.id),
        staleTime: 0,
      })
      if (usage.rules.length === 0) {
        hideCatMutation.mutate({ id: cat.id, deactivateRules: false })
        return
      }
      setHidingCategory({ category: cat, rules: usage.rules })
    } catch (err) {
      toast.error(extractApiError(err, t('common.error')))
    }
  }

  // The row that will hold focus once this one is gone: the next row in its
  // section, else the previous, else the section header, else the add button.
  const successorsAfterRemovingCategory = (id: string) => {
    const section = (groups ?? []).find((g) => g.categories.some((c) => c.id === id))
    const siblings = section ? section.categories : ungrouped
    const index = siblings.findIndex((c) => c.id === id)
    const keys: string[] = []
    if (siblings[index + 1]) keys.push(`row:${siblings[index + 1].id}`)
    if (siblings[index - 1]) keys.push(`row:${siblings[index - 1].id}`)
    keys.push(`header:${section?.id ?? UNGROUPED}`, 'add-category')
    return keys
  }
  const successorsAfterRemovingGroup = (id: string) => {
    const index = sectionIds.indexOf(id)
    const keys: string[] = []
    if (sectionIds[index + 1]) keys.push(`header:${sectionIds[index + 1]}`)
    if (sectionIds[index - 1]) keys.push(`header:${sectionIds[index - 1]}`)
    keys.push('add-group')
    return keys
  }

  const deleteCatMutation = useMutation({
    mutationFn: ({ id, transferToId }: { id: string; name: string; transferToId?: string }) =>
      categoriesApi.delete(id, transferToId),
    onSuccess: (_data, variables) => {
      successorRef.current = successorsAfterRemovingCategory(variables.id)
      invalidateAll()
      setDeletingCategory(null)
      setTransferringCategory(null)
      // A transfer rewrites transactions, budgets, recurring entries and
      // rules, so the screens built on them are all stale now.
      if (variables.transferToId) {
        for (const key of ['transactions', 'budgets', 'recurring-transactions', 'rules']) {
          queryClient.invalidateQueries({ queryKey: [key] })
        }
      }
      toast.success(t('categories.deletedNamed', { name: variables.name }))
    },
    onError: (err: unknown) => {
      // The API answers 409 with an English sentence; show the translated one instead.
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        toast.error(t('categories.deleteInUse'))
        return
      }
      toast.error(extractApiError(err, t('common.error')))
    },
  })

  // Deleting used to be refused whenever anything pointed at the category.
  // Now the references are counted first, and the user is only interrupted
  // when there is something to decide.
  async function handleDeleteCategory(cat: Category) {
    try {
      const usage = await queryClient.fetchQuery({
        queryKey: ['category-usage', cat.id],
        queryFn: () => categoriesApi.usage(cat.id),
        staleTime: 0,
      })
      const isUsed =
        usage.transactions > 0
        || usage.budgets > 0
        || usage.recurring_transactions > 0
        || usage.rules.length > 0
      if (!isUsed) {
        setDeletingCategory(cat)
        return
      }
      setTransferTargetId('')
      setTransferringCategory({ category: cat, usage })
    } catch (err) {
      toast.error(extractApiError(err, t('common.error')))
    }
  }

  // What the destination picker offers: every visible category except the one
  // on its way out, kept in its groups so it reads like the pickers elsewhere.
  const transferOptions = useMemo(() => {
    const sourceId = transferringCategory?.category.id
    const available = (categoriesList ?? []).filter(
      (cat) => !cat.is_hidden && cat.id !== sourceId,
    )
    const availableIds = new Set(available.map((cat) => cat.id))
    return {
      categories: available,
      groups: (groups ?? [])
        .filter((group) => !group.is_hidden)
        .map((group) => ({
          ...group,
          categories: (group.categories ?? []).filter((cat) => availableIds.has(cat.id)),
        }))
        .filter((group) => group.categories.length > 0),
    }
  }, [categoriesList, groups, transferringCategory])

  const createGroupMutation = useMutation({
    mutationFn: (g: Partial<CategoryGroup>) => groupsApi.create(g),
    onSuccess: (group) => {
      invalidateAll()
      setGroupDialogOpen(false)
      revealRow(group.id, group.id, false)
      toast.success(t('groups.createdNamed', { name: group.name }))
    },
    onError: (err: unknown) => toast.error(extractApiError(err, t('common.error'))),
  })
  const updateGroupMutation = useMutation({
    mutationFn: ({ id, ...data }: Partial<CategoryGroup> & { id: string }) => groupsApi.update(id, data),
    onSuccess: (group) => {
      invalidateAll()
      setGroupDialogOpen(false)
      setEditingGroup(null)
      revealRow(group.id, group.id, false)
      toast.success(t('groups.updatedNamed', { name: group.name }))
    },
    onError: (err: unknown) => toast.error(extractApiError(err, t('common.error'))),
  })
  const toggleGroupHiddenMutation = useMutation({
    mutationFn: (group: CategoryGroup) => groupsApi.update(group.id, { is_hidden: !group.is_hidden }),
    onSuccess: (group) => {
      invalidateAll()
      toast.success(t('groups.updatedNamed', { name: group.name }))
    },
    onError: (err: unknown) => toast.error(extractApiError(err, t('common.error'))),
  })
  const deleteGroupMutation = useMutation({
    mutationFn: (group: CategoryGroup) => groupsApi.delete(group.id),
    onSuccess: (_data, group) => {
      successorRef.current = successorsAfterRemovingGroup(group.id)
      invalidateAll()
      setDeletingGroup(null)
      toast.success(t('groups.deletedNamed', { name: group.name }))
    },
    onError: (err: unknown) => {
      toast.error(extractApiError(err, t('common.error')))
    },
  })

  const toggleCollapse = (groupId: string) => {
    const next = new Set(collapsedGroups)
    if (next.has(groupId)) next.delete(groupId)
    else next.add(groupId)
    updateCollapsed(next)
  }

  // Collapse while anything is open; only when every section is closed does the
  // same button offer to open them all again.
  const allCollapsed = sectionIds.length > 0 && sectionIds.every((id) => collapsedGroups.has(id))
  const hasHidden =
    (categoriesList ?? []).some((c) => c.is_hidden) || (groups ?? []).some((g) => g.is_hidden)
  const isLoading = groupsPending || categoriesPending
  // A failed background refetch keeps the rows on screen; only a load with
  // nothing to show is an error state.
  const loadFailed = (groupsError || categoriesError) && (!groups || !categoriesList)
  const isEmpty = !isLoading && !loadFailed && (groups?.length ?? 0) === 0 && ungrouped.length === 0

  const catDialogError = (editingCat ? updateCatMutation : createCatMutation).error
  const groupDialogError = (editingGroup ? updateGroupMutation : createGroupMutation).error

  useEffect(() => {
    const previous = document.title
    document.title = `${t('categories.title')} · Securo`
    return () => {
      document.title = previous
    }
  }, [t])

  const openCatDialog = (cat: Category | null) => {
    createCatMutation.reset()
    updateCatMutation.reset()
    setEditingCat(cat)
    setCatDialogOpen(true)
  }

  const openGroupDialog = (group: CategoryGroup | null) => {
    createGroupMutation.reset()
    updateGroupMutation.reset()
    setEditingGroup(group)
    setGroupDialogOpen(true)
  }

  const renderBadge = (label: string) => <span className={BADGE_CLASS}>{label}</span>

  const renderCategoryItem = (cat: Category, groupHidden = false) => {
    const dimmed = cat.is_hidden || groupHidden
    const count = transactionCounts.get(cat.id) ?? cat.transaction_count
    const hasBadges = cat.is_system || cat.is_hidden || cat.treat_as_transfer || cat.is_ignored
    const actions: RowAction[] = [
      {
        key: 'edit',
        label: t('common.edit'),
        ariaLabel: `${t('common.edit')}: ${cat.name}`,
        icon: <Pencil size={14} />,
        onSelect: () => openCatDialog(cat),
      },
      ...(cat.is_system
        ? [{
            key: 'visibility' as const,
            label: cat.is_hidden ? t('categories.showDefault') : t('categories.hideDefault'),
            ariaLabel: `${cat.is_hidden ? t('categories.showDefault') : t('categories.hideDefault')}: ${cat.name}`,
            icon: cat.is_hidden ? <Eye size={14} /> : <EyeOff size={14} />,
            onSelect: () => { void handleToggleHidden(cat) },
            disabled: showCatMutation.isPending || hideCatMutation.isPending,
          }]
        : []),
      {
        key: 'delete',
        label: t('common.delete'),
        ariaLabel: `${t('common.delete')}: ${cat.name}`,
        icon: <Trash2 size={14} />,
        onSelect: () => { void handleDeleteCategory(cat) },
        disabled: deleteCatMutation.isPending,
        destructive: true,
      },
    ]
    return (
      <div
        key={cat.id}
        data-row-id={cat.id}
        className={cn(
          'flex items-center gap-3 pl-11 pr-2 sm:pl-12 sm:pr-5 py-2 sm:py-2.5 border-b border-border last:border-0 hover:bg-muted transition-colors',
          flash === cat.id && 'securo-highlight-flash',
        )}
      >
        <CategoryIcon icon={cat.icon} color={cat.color} size="md" className={dimmed ? 'opacity-60' : undefined} />
        {/* On a phone the name gets its own (wrapping) line with the badges and
            usage under it; from `sm` the wrappers vanish and everything is one
            line with the usage in a right-aligned column. */}
        <div className="flex min-w-0 flex-1 flex-col gap-1 sm:contents">
          <span
            title={cat.name}
            className={cn(
              'text-sm font-medium break-words line-clamp-2 sm:line-clamp-none sm:min-w-0 sm:truncate',
              dimmed ? 'text-muted-foreground' : 'text-foreground',
            )}
          >
            {cat.name}
          </span>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 sm:contents">
            {hasBadges && (
              <div className="flex flex-wrap items-center gap-1.5 sm:shrink-0 sm:flex-nowrap">
                {cat.is_system && renderBadge(t('categories.defaultBadge'))}
                {cat.is_hidden && renderBadge(t('categories.hiddenBadge'))}
                {cat.treat_as_transfer && (
                  <BadgeHint label={t('categories.treatAsTransferBadge')} description={t('categories.treatAsTransferDesc')} />
                )}
                {cat.is_ignored && (
                  <BadgeHint label={t('categories.ignoreTransferBadge')} description={t('categories.ignoreTransferDesc')} />
                )}
              </div>
            )}
            {typeof count === 'number' && (
              <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground sm:ml-auto sm:min-w-32 sm:text-right">
                {count === 0 ? t('categories.noTransactions') : t('categories.transactionCount', { count })}
              </span>
            )}
          </div>
        </div>
        {canWrite && (
          <RowActions
            actions={actions}
            menuAriaLabel={`${t('common.more')}: ${cat.name}`}
            focusKey={`row:${cat.id}`}
            setOpener={setOpener}
          />
        )}
      </div>
    )
  }

  const chevron = (collapsed: boolean) => {
    const Chevron = collapsed ? ChevronRight : ChevronDown
    return <Chevron size={14} className="text-muted-foreground shrink-0" />
  }

  return (
    <div ref={pageRef} className={cn(canWrite && 'pb-24 sm:pb-0')}>
      <PageHeader
        section={t('nav.groupSetup')}
        title={t('categories.title')}
        action={
          <PageRefreshButton
            onRefresh={() => queryClient.refetchQueries({ type: 'active' })}
            refreshing={categoriesFetching}
          />
        }
      />

      {hasHidden && (
        <p className="mb-4 max-w-prose text-pretty text-sm text-muted-foreground">
          {t('categories.hiddenScopeDescription')}
        </p>
      )}

      <SectionCard>
        <div className={cn(
          'flex items-center justify-between gap-2 border-b border-border bg-card px-4 py-2 sm:px-5 sm:py-3',
          sectionIds.length === 0 && 'max-sm:border-0 max-sm:p-0',
        )}>
          {sectionIds.length > 0 ? (
            <button
              type="button"
              className={cn(
                'inline-flex min-h-11 items-center gap-1.5 -ml-2 rounded-md px-2 text-xs text-muted-foreground hover:text-foreground transition-colors sm:min-h-9',
                FOCUS_RING,
              )}
              onClick={() => updateCollapsed(allCollapsed ? new Set() : new Set(sectionIds))}
            >
              <ChevronsUpDown size={14} />
              {allCollapsed ? t('categories.expandAll') : t('categories.collapseAll')}
            </button>
          ) : (
            <span />
          )}
          {canWrite && (
            // On a phone the add actions float at the bottom right, under the
            // thumb, whatever part of a long list is on screen; `main` clips
            // overflow, so a sticky toolbar would not stay put.
            <div className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-30 flex gap-2 rounded-2xl border border-border bg-card p-2 shadow-lg sm:static sm:z-auto sm:rounded-none sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none">
              <Button
                variant="outline"
                size="sm"
                className="h-11 min-w-11 gap-1.5 sm:h-9"
                aria-label={t('groups.add')}
                data-focus="add-group"
                onClick={(event) => { setOpener(event.currentTarget); openGroupDialog(null) }}
              >
                <FolderPlus size={14} /> <span className="hidden sm:inline">{t('groups.add')}</span>
              </Button>
              <Button
                size="sm"
                className="h-11 min-w-11 gap-1.5 sm:h-9"
                aria-label={t('categories.addCategory')}
                data-focus="add-category"
                onClick={(event) => { setOpener(event.currentTarget); openCatDialog(null) }}
              >
                <Plus size={14} /> <span className="hidden sm:inline">{t('categories.addCategory')}</span>
              </Button>
            </div>
          )}
        </div>
        {isLoading ? (
          <LoadingSkeleton label={t('common.loading')} />
        ) : loadFailed ? (
          <div className="flex flex-col items-center gap-3 px-5 py-10 text-center">
            <p role="alert" className="text-sm text-muted-foreground">{t('categories.loadError')}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => { void refetchGroups(); void refetchCategories() }}
            >
              {t('common.retry')}
            </Button>
          </div>
        ) : isEmpty ? (
          <div className="flex flex-col items-center gap-4 px-5 py-10 text-center">
            <p className="text-sm text-muted-foreground">{t('categories.empty')}</p>
            {canWrite && (
              <Button
                className="h-11 gap-1.5 sm:h-9"
                onClick={(event) => { setOpener(event.currentTarget); openCatDialog(null) }}
              >
                <Plus size={14} /> {t('categories.addCategory')}
              </Button>
            )}
          </div>
        ) : (
          <div>
            {groups?.map((group) => {
              const isCollapsed = collapsedGroups.has(group.id)
              const groupActions: RowAction[] = [
                {
                  key: 'edit',
                  label: t('common.edit'),
                  ariaLabel: t('groups.editAria', { name: group.name }),
                  icon: <Pencil size={14} />,
                  onSelect: () => openGroupDialog(group),
                },
                ...(group.is_system
                  ? [{
                      key: 'visibility' as const,
                      label: group.is_hidden ? t('groups.showDefault') : t('groups.hideDefault'),
                      ariaLabel: `${group.is_hidden ? t('groups.showDefault') : t('groups.hideDefault')}: ${group.name}`,
                      icon: group.is_hidden ? <Eye size={14} /> : <EyeOff size={14} />,
                      onSelect: () => toggleGroupHiddenMutation.mutate(group),
                      disabled: toggleGroupHiddenMutation.isPending,
                    }]
                  : []),
                {
                  key: 'delete',
                  label: t('common.delete'),
                  ariaLabel: t('groups.deleteAria', { name: group.name }),
                  icon: <Trash2 size={14} />,
                  onSelect: () => setDeletingGroup(group),
                  disabled: deleteGroupMutation.isPending,
                  destructive: true,
                },
              ]
              return (
                <div key={group.id} data-section={group.id}>
                  <div
                    data-row-id={group.id}
                    className={cn(
                      'flex items-center gap-2 pl-4 pr-2 sm:px-5 py-1 sm:py-2 border-b border-border bg-muted/40',
                      flash === group.id && 'securo-highlight-flash',
                    )}
                  >
                    <button
                      type="button"
                      aria-expanded={!isCollapsed}
                      aria-label={t('groups.toggleAria', { name: group.name, count: group.categories.length })}
                      data-focus={`header:${group.id}`}
                      className={cn('flex items-center gap-2 flex-1 min-w-0 min-h-11 sm:min-h-9 text-left rounded-md', FOCUS_RING)}
                      onClick={() => toggleCollapse(group.id)}
                    >
                      {chevron(isCollapsed)}
                      <CategoryIcon icon={group.icon} color={group.color} size="md" className={group.is_hidden ? 'opacity-60' : undefined} />
                      <span className={cn('min-w-0 truncate text-sm font-semibold', group.is_hidden ? 'text-muted-foreground' : 'text-foreground')}>
                        {group.name}
                      </span>
                      {group.is_hidden && renderBadge(t('groups.hiddenBadge'))}
                      <span className="text-xs text-muted-foreground">({group.categories.length})</span>
                    </button>
                    {canWrite && (
                      <RowActions
                        actions={groupActions}
                        menuAriaLabel={t('groups.moreAria', { name: group.name })}
                        setOpener={setOpener}
                      />
                    )}
                  </div>
                  {!isCollapsed && group.categories.map((cat) => renderCategoryItem(cat, group.is_hidden))}
                </div>
              )
            })}
            {ungrouped.length > 0 && (
              <div data-section={UNGROUPED}>
                <div className="flex items-center gap-2 pl-4 pr-2 sm:px-5 py-1 sm:py-2 border-b border-border bg-muted/40">
                  <button
                    type="button"
                    aria-expanded={!collapsedGroups.has(UNGROUPED)}
                    aria-label={t('groups.toggleAria', { name: t('groups.noGroup'), count: ungrouped.length })}
                    data-focus={`header:${UNGROUPED}`}
                    className={cn('flex items-center gap-2 flex-1 min-w-0 min-h-11 sm:min-h-9 text-left rounded-md', FOCUS_RING)}
                    onClick={() => toggleCollapse(UNGROUPED)}
                  >
                    {chevron(collapsedGroups.has(UNGROUPED))}
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <FolderX size={16} />
                    </span>
                    <span className="text-sm font-semibold text-muted-foreground">{t('groups.noGroup')}</span>
                    <span className="text-xs text-muted-foreground">({ungrouped.length})</span>
                  </button>
                </div>
                {!collapsedGroups.has(UNGROUPED) && ungrouped.map((cat) => renderCategoryItem(cat))}
              </div>
            )}
          </div>
        )}
      </SectionCard>

      {/* Category Dialog */}
      <Dialog open={catDialogOpen} onOpenChange={() => { setCatDialogOpen(false); setEditingCat(null) }}>
        <DialogContent
          className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden"
          aria-describedby={undefined}
          onCloseAutoFocus={restoreFocus}
        >
          <DialogHeader>
            <DialogTitle>{editingCat ? t('categories.editCategory') : t('categories.newCategory')}</DialogTitle>
          </DialogHeader>
          <CategoryForm
            key={editingCat?.id ?? 'new'}
            category={editingCat}
            groups={groups}
            error={catDialogError}
            pending={createCatMutation.isPending || updateCatMutation.isPending}
            onSubmit={(values) =>
              editingCat
                ? updateCatMutation.mutate({ id: editingCat.id, ...values })
                : createCatMutation.mutate(values)
            }
            onCancel={() => { setCatDialogOpen(false); setEditingCat(null) }}
          />
        </DialogContent>
      </Dialog>

      {/* Group Dialog */}
      <Dialog open={groupDialogOpen} onOpenChange={() => { setGroupDialogOpen(false); setEditingGroup(null) }}>
        <DialogContent
          className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden"
          aria-describedby={undefined}
          onCloseAutoFocus={restoreFocus}
        >
          <DialogHeader>
            <DialogTitle>{editingGroup ? t('groups.edit') : t('groups.new')}</DialogTitle>
          </DialogHeader>
          <GroupForm
            key={editingGroup?.id ?? 'new-group'}
            group={editingGroup}
            error={groupDialogError}
            pending={createGroupMutation.isPending || updateGroupMutation.isPending}
            onSubmit={(values) =>
              editingGroup
                ? updateGroupMutation.mutate({ id: editingGroup.id, ...values })
                : createGroupMutation.mutate(values)
            }
            onCancel={() => { setGroupDialogOpen(false); setEditingGroup(null) }}
          />
        </DialogContent>
      </Dialog>

      <DeleteConfirmationDialog
        open={!!deletingCategory}
        title={t('categories.confirmDeleteTitle')}
        description={t('categories.confirmDeleteDescription', { name: deletingCategory?.name })}
        isPending={deleteCatMutation.isPending}
        onCloseAutoFocus={restoreFocus}
        onClose={() => setDeletingCategory(null)}
        onConfirm={() =>
          deletingCategory && deleteCatMutation.mutate({ id: deletingCategory.id, name: deletingCategory.name })
        }
      />

      <DeleteConfirmationDialog
        open={!!deletingGroup}
        title={t('groups.confirmDeleteTitle')}
        description={t('groups.confirmDeleteDescription', { name: deletingGroup?.name })}
        isPending={deleteGroupMutation.isPending}
        onCloseAutoFocus={restoreFocus}
        onClose={() => setDeletingGroup(null)}
        onConfirm={() => deletingGroup && deleteGroupMutation.mutate(deletingGroup)}
      />

      <Dialog
        open={!!transferringCategory}
        onOpenChange={(open) => {
          if (!open && !deleteCatMutation.isPending) setTransferringCategory(null)
        }}
      >
        <DialogContent className="sm:max-w-md" showCloseButton={!deleteCatMutation.isPending} onCloseAutoFocus={restoreFocus}>
          <DialogHeader>
            <DialogTitle>
              {t('categories.deleteInUseTitle', { name: transferringCategory?.category.name })}
            </DialogTitle>
            <DialogDescription>{t('categories.deleteInUseDescription')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <ul className="rounded-lg border border-border divide-y divide-border">
              {([
                ['nav.transactions', transferringCategory?.usage.transactions ?? 0],
                ['nav.budgets', transferringCategory?.usage.budgets ?? 0],
                ['nav.recurring', transferringCategory?.usage.recurring_transactions ?? 0],
                ['nav.rules', transferringCategory?.usage.rules.length ?? 0],
              ] as const)
                .filter(([, count]) => count > 0)
                .map(([label, count]) => (
                  <li
                    key={label}
                    className="flex items-center justify-between px-3 py-2 text-sm"
                  >
                    <span className="text-muted-foreground">{t(label)}</span>
                    <span className="font-medium text-foreground tabular-nums">{count}</span>
                  </li>
                ))}
            </ul>
            <div className="space-y-2">
              <Label>{t('categories.deleteTransferLabel')}</Label>
              <CategorySelect
                value={transferTargetId}
                onChange={setTransferTargetId}
                categories={transferOptions.categories}
                groups={transferOptions.groups}
                autoHighlightFirst={false}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              className="h-11 sm:h-9"
              onClick={() => setTransferringCategory(null)}
              disabled={deleteCatMutation.isPending}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              className="h-11 sm:h-9"
              disabled={!transferTargetId || deleteCatMutation.isPending}
              onClick={() =>
                transferringCategory
                && deleteCatMutation.mutate({
                  id: transferringCategory.category.id,
                  name: transferringCategory.category.name,
                  transferToId: transferTargetId,
                })
              }
            >
              <Trash2 size={14} className="mr-1" />
              {t('categories.deleteAndTransfer')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!hidingCategory} onOpenChange={(open) => !open && setHidingCategory(null)}>
        <DialogContent className="sm:max-w-xl" onCloseAutoFocus={restoreFocus}>
          <DialogHeader>
            <DialogTitle>
              {t('categories.hideWithRulesTitle', { name: hidingCategory?.category.name })}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <DialogDescription>
              {t('categories.hideWithRulesDescription', { count: hidingCategory?.rules.length ?? 0 })}
            </DialogDescription>
            <ul className="max-h-40 overflow-y-auto rounded-lg border border-border divide-y divide-border">
              {hidingCategory?.rules.map((rule) => (
                <li key={rule.id} className="px-3 py-2 text-sm text-foreground truncate">
                  {rule.name}
                </li>
              ))}
            </ul>
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button
              variant="ghost"
              className="h-11 w-full sm:h-9 sm:w-auto"
              onClick={() => setHidingCategory(null)}
              disabled={hideCatMutation.isPending}
            >
              {t('common.cancel')}
            </Button>
            <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
              <Button
                variant="outline"
                className="h-11 w-full sm:h-9 sm:w-auto"
                onClick={() =>
                  hidingCategory
                  && hideCatMutation.mutate({ id: hidingCategory.category.id, deactivateRules: false })
                }
                disabled={hideCatMutation.isPending}
              >
                {t('categories.hideKeepRules')}
              </Button>
              <Button
                className="h-11 w-full sm:h-9 sm:w-auto"
                onClick={() =>
                  hidingCategory
                  && hideCatMutation.mutate({ id: hidingCategory.category.id, deactivateRules: true })
                }
                disabled={hideCatMutation.isPending}
              >
                {t('categories.hideAndTurnOffRules')}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
