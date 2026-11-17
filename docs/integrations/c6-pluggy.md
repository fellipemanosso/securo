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
