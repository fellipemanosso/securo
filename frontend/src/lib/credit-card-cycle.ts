import { addDays, addMonths, differenceInCalendarMonths, format, isSameMonth, parseISO } from 'date-fns'

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

function dateInMonth(year: number, month: number, day: number): Date {
  return new Date(year, month, Math.min(day, daysInMonth(year, month)))
}

/** Build the purchase window for the bill due in `month`.
 *
 * Brazilian cards assign a purchase made on the closing day to the next
 * statement, so a cycle is [previous closing day, current closing day - 1].
 * This is the local fallback used while the provider has not published an
 * official bill yet.
 */
export function billCycleForMonth(
  month: Date,
  closeDay: number | null | undefined,
  dueDay: number | null | undefined,
): { start: string; end: string; dueDate: string } | null {
  if (!closeDay || !dueDay) return null

  const year = month.getFullYear()
  const monthIndex = month.getMonth()
  const due = dateInMonth(year, monthIndex, dueDay)
  const closeInDueMonth = dateInMonth(year, monthIndex, closeDay)
  const close = closeInDueMonth <= due
    ? closeInDueMonth
    : dateInMonth(monthIndex === 0 ? year - 1 : year, monthIndex === 0 ? 11 : monthIndex - 1, closeDay)

  const previousMonth = close.getMonth() === 0 ? 11 : close.getMonth() - 1
  const previousYear = close.getMonth() === 0 ? close.getFullYear() - 1 : close.getFullYear()
  const previousClose = dateInMonth(previousYear, previousMonth, closeDay)

  return {
    start: format(previousClose, 'yyyy-MM-dd'),
    end: format(addDays(close, -1), 'yyyy-MM-dd'),
    dueDate: format(due, 'yyyy-MM-dd'),
  }
}

type KnownBillDate = {
  due_date: string
  closing_date: string | null
}

/** Infer a missing open cycle from dates the bank has already supplied.
 *
 * Some Pluggy accounts expose bill dates but leave the account-level close
 * and due days empty. Prefer the provider's explicit next dates when they
 * match the selected month; otherwise project the latest known cycle by whole
 * months. The result remains an estimate and is replaced as soon as /bills
 * publishes the official statement.
 */
export function billCycleFromKnownDates(
  month: Date,
  bills: KnownBillDate[],
  nextCloseDate?: string | null,
  nextDueDate?: string | null,
): { start: string; end: string; dueDate: string } | null {
  const knownBills = [...bills].sort((a, b) => b.due_date.localeCompare(a.due_date))
  const datedBills = bills
    .filter((bill): bill is KnownBillDate & { closing_date: string } => !!bill.closing_date)
    .sort((a, b) => b.due_date.localeCompare(a.due_date))

  let close: Date | null = null
  let due: Date | null = null

  if (nextDueDate && isSameMonth(parseISO(nextDueDate), month)) {
    due = parseISO(nextDueDate)
    // Some connectors publish only the next due date. Seven days is a
    // conservative Brazilian-card fallback until a real close date arrives.
    close = nextCloseDate ? parseISO(nextCloseDate) : addDays(due, -7)
  } else {
    const reference = knownBills.find((bill) => parseISO(bill.due_date) < month)
    if (!reference) return null
    const referenceDue = parseISO(reference.due_date)
    const monthDelta = differenceInCalendarMonths(month, referenceDue)
    if (monthDelta < 1) return null
    due = addMonths(referenceDue, monthDelta)
    close = reference.closing_date
      ? addMonths(parseISO(reference.closing_date), monthDelta)
      : addDays(due, -7)
  }

  const previousClose = datedBills
    .map((bill) => parseISO(bill.closing_date))
    .filter((candidate) => candidate < close)
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? addMonths(close, -1)

  return {
    start: format(previousClose, 'yyyy-MM-dd'),
    end: format(addDays(close, -1), 'yyyy-MM-dd'),
    dueDate: format(due, 'yyyy-MM-dd'),
  }
}

/** Derive a bill's cycle close date from the account's statement_close_day.
 * Pluggy doesn't expose the close date directly, but it's recoverable: the
 * close is the most recent occurrence of close_day on or before the bill's
 * due_date. Falls back to due_date when close_day is not configured. */
export function closeDateForBill(billDueDate: string, closeDay: number | null | undefined): string {
  if (!closeDay) return billDueDate
  const due = parseISO(billDueDate + 'T00:00:00')
  const y = due.getFullYear()
  const m = due.getMonth()
  const lastThis = new Date(y, m + 1, 0).getDate()
  const sameMonth = new Date(y, m, Math.min(closeDay, lastThis))
  if (sameMonth.getTime() <= due.getTime()) {
    return format(sameMonth, 'yyyy-MM-dd')
  }
  const py = m === 0 ? y - 1 : y
  const pm = m === 0 ? 11 : m - 1
  const lastPrev = new Date(py, pm + 1, 0).getDate()
  return format(new Date(py, pm, Math.min(closeDay, lastPrev)), 'yyyy-MM-dd')
}

/** True when `windowStart` falls inside the cycle that is still open, meaning
 * every transaction in the window is by definition unbilled.
 *
 * This is the question `unbilled_only` answers on the backend: it drops every
 * transaction already linked to a bill, which is right for the open cycle
 * (whose window overlaps the newest closed bill's range, so without it the
 * closed bill's charges would double-count) and wrong for anything else.
 *
 * The open cycle starts on the newest bill's close day, since the close day
 * itself opens the next cycle. A window starting before that covers billed
 * history, and the caller must not ask for unbilled transactions only, or the
 * history disappears.
 *
 * Both arguments are `yyyy-MM-dd`, which compares chronologically as a string.
 */
export function isOpenCycleWindow(
  windowStart: string,
  newestBillDueDate: string,
  closeDay: number | null | undefined,
): boolean {
  if (!windowStart) return false
  return windowStart >= closeDateForBill(newestBillDueDate, closeDay)
}
