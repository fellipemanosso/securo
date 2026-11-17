# C6 credit card through Pluggy

What the C6 connector sends, as observed in production, and how Securo reads
it. Observed on the `C6 Carbon Black` card (account name `BANDEIRADO`) in
November 2026, right after connecting it.

## Card and cycle

- The account's `creditData` carries the due day (`balanceDueDate`, the 1st)
  but no closing day (`balanceCloseDate`). Without a closing day the card has no
  open cycle and no statement projections.
- The bills carry both bank dates. The bill closes in the month before it is
  due, around a week earlier, and the closing day moves with the calendar:
  21st to 26th across January–November 2026 (e.g. closed 2026-10-24, due
  2026-11-01).
- Sync fills a missing closing or due day from the latest bank bill and places
  the charges imported without a cycle again
  (`_fill_cycle_days_from_bills`). Days the provider or the user set are kept.

## Bills

- Closed bills match the bank app to the cent (January–November 2026).
- `billForecastDate` on bills was empty in the first sync.

## Charge forecasts

- `billForecastDate` on charges is neither the due month nor reliably the
  closing month. Of 1091 billed charges carrying it, none matched the bill's
  due month and 886 matched its closing month; open charges made from
  2026-10-24 on, which go on the bill closing 2026-11-24, carried `2026-10`.
- Read as a due month, that names a bill that closed before the purchase.
  Placing charges on it (migration 112) emptied the open December 2026 bill;
  a forecast now only counts when it defers a charge past its cycle-math bill
  (ADR 0002, migration 113), so C6 charges follow cycle math and `billId`.

## Open statement

Compared with the bank app's December 2026 statement (open on 2026-11-17,
R$ 12.789,93), the synced rows lacked three things:

- Installments of older purchases. C6 sends installment k only once it is
  billed, so installment k+1 never arrives ahead of time (THIAGO 7/10, CEA
  2/3, BAGATELLE 5/6 and others, R$ 1.437,25). Securo derives them
  (ADR 0003).
- Charges still pending at the November close (purchases of 2026-10-23,
  R$ 475,90, and two refunds of 2026-10-18). C6 bills them on the next
  statement. When a closed bank statement leaves out a charge from its window,
  sync places it on the next statement (`_carry_charges_past_closed_bill`,
  latest closed statement only, and only when the bank links its charges to
  bills).
- The calendar day. Pluggy sends timestamps in UTC; a purchase after 21:00 in
  Brasília was dated a day late. Dates are now taken in Brasília time
  (migration 114 fixed stored rows).
