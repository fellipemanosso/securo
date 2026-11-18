import { useState, useMemo, useRef, useEffect, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { CATEGORY_ICONS, getCategoryIconLabel } from '@/lib/category-icons'
import { cn } from '@/lib/utils'

interface IconPickerProps {
  value: string
  color: string
  onChange: (iconName: string) => void
}

export function IconPicker({ value, color, onChange }: IconPickerProps) {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const gridRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    if (!search.trim()) return CATEGORY_ICONS
    const q = search.toLowerCase()
    return CATEGORY_ICONS.filter(
      (entry) =>
        entry.name.includes(q) ||
        getCategoryIconLabel(t, entry.name).toLowerCase().includes(q)
    )
  }, [search, t])

  // One Tab stop for the whole grid: the selected icon, or the first one when
  // the selection is filtered out. Arrow keys move between icons.
  const tabStopName = filtered.some((entry) => entry.name === value)
    ? value
    : filtered[0]?.name

  // The grid's own scroll position follows the selection, so a long list
  // opens with the chosen icon in view. Computed on the grid rather than with
  // scrollIntoView, which would also scroll the dialog and the page.
  useEffect(() => {
    const grid = gridRef.current
    const selected = grid?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')
    if (!grid || !selected) return
    const margin = 4
    const top = selected.offsetTop
    const bottom = top + selected.offsetHeight
    if (top - margin < grid.scrollTop) grid.scrollTop = Math.max(top - margin, 0)
    else if (bottom + margin > grid.scrollTop + grid.clientHeight) {
      grid.scrollTop = bottom + margin - grid.clientHeight
    }
  }, [value])

  function handleGridKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // The column count depends on the breakpoint, so read it off the grid.
    const grid = gridRef.current
    const columns = grid
      ? Math.max(getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length, 1)
      : 1
    const steps: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: columns,
      ArrowUp: -columns,
    }
    const buttons = Array.from(gridRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    const current = buttons.indexOf(event.target as HTMLButtonElement)
    if (current === -1) return
    let next: number
    if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = buttons.length - 1
    else if (event.key in steps) next = Math.min(Math.max(current + steps[event.key], 0), buttons.length - 1)
    else return
    event.preventDefault()
    buttons[next]?.focus()
  }

  return (
    <div className="space-y-2">
      <input
        type="text"
        placeholder={t('common.searchIcon')}
        aria-label={t('common.searchIcon')}
        className="w-full border border-border rounded-lg px-3 py-1.5 text-sm bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        // Inside a form, Enter would submit it while the user is only filtering.
        onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault() }}
      />
      <div
        ref={gridRef}
        role="group"
        aria-label={t('groups.icon')}
        onKeyDown={handleGridKeyDown}
        className="relative grid grid-cols-6 sm:grid-cols-8 gap-1 sm:gap-1.5 max-h-48 overflow-y-auto p-1"
      >
        {filtered.map((entry) => {
          const isSelected = value === entry.name
          const Icon = entry.icon
          return (
            <button
              key={entry.name}
              type="button"
              title={getCategoryIconLabel(t, entry.name)}
              aria-label={getCategoryIconLabel(t, entry.name)}
              aria-pressed={isSelected}
              tabIndex={entry.name === tabStopName ? 0 : -1}
              className={cn(
                'w-full h-11 sm:w-9 sm:h-9 rounded-lg flex items-center justify-center transition-all',
                isSelected
                  ? 'ring-2 ring-offset-1 ring-primary'
                  : 'hover:bg-muted'
              )}
              style={isSelected ? { backgroundColor: color || '#6B7280' } : undefined}
              onClick={() => onChange(entry.name)}
            >
              <Icon
                size={18}
                className={isSelected ? 'text-white' : 'text-muted-foreground'}
                strokeWidth={2}
              />
            </button>
          )
        })}
        {filtered.length === 0 && (
          <p className="col-span-full text-xs text-muted-foreground text-center py-4">
            {t('common.noIconsFound')}
          </p>
        )}
      </div>
    </div>
  )
}
