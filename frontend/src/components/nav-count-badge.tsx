import { cn } from '@/lib/utils'

/** Work waiting behind a link: amber like every other open question in the
 *  app, and absent at zero, because a badge announcing nothing is noise. */
export function NavCountBadge({ count, className }: { count: number | undefined; className?: string }) {
  if (!count) return null
  return (
    <span
      data-testid="nav-count-badge"
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-amber-100 px-1 text-[10px] font-semibold tabular-nums text-amber-800 dark:bg-amber-950 dark:text-amber-300',
        className,
      )}
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}
