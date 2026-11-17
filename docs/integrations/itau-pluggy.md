# Itaú credit card through Pluggy

What the Itaú connector sends, as observed in production, and how Securo reads
it. Observed on the `LATAM PASS ITAU MASTERCARD BLACK` card in November 2026,
right after connecting it (through a MeuPluggy connection).

## Card and cycle

- Closes on the 4th, due on the 11th. Closed bills match the bank app.

## Installments

- Billed installments carry a `billId` and the purchase's own `purchaseDate`
  (e.g. ZP*RAFAELA 9/12, purchased 2026-02-04, billed on the November bill).
- Future installments arrive ahead of billing as pending rows, dated on the
  due date of the bill they land on (ZP*RAFAELA 10/12 dated 2026-12-11) or
  near its close (MP *ALIEXPRESS 2/4 dated 2026-12-03), with
  `billForecastDate` naming that bill (`2026-12`). Since Itaú sends them,
  Securo forecasts no installments for this card (ADR 0003).
- Read by its own date, 10/12 landed a bill late. The forecast is now checked
  against the original purchase date, so it places 10/12 on December
  (ADR 0002, migration 116).
- `purchaseDate` on the pending future rows is three hours later than on the
  billed ones (`2026-02-05T00:19:24Z` against `2026-02-04T21:19:24Z`); both are
  2026-02-04 in Brasília.
