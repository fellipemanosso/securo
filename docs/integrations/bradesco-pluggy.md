# Bradesco credit card through Pluggy

What the Bradesco connector sends, as observed in production, and how Securo
reads it. Observed on card `5407` in November 2026, right after connecting it.

## Installments

- Every installment carries `creditCardMetadata.purchaseDate` as a UTC
  timestamp, and the time differs between installments of one purchase: the
  NOVA *NOVA 10x purchase came as `2026-06-16T00:43:54Z` (1/10),
  `2026-06-16T00:29:51Z` (2/10), `2026-06-15T03:00:00Z` (3/10) and
  `2026-06-16T00:3x/00:4xZ` (4/10, 5/10). All are 15/06 in Brasília.
- Read as the UTC day, the purchase split in two (15/06 and 16/06) and its
  next installment was forecast twice (ADR 0003). The purchase date is now
  taken in Brasília time like the transaction date (migration 115 fixed
  stored rows).
- Billed installments carry a `billId` and a `date` of local midnight
  (`T03:00:00Z`), the day the installment was charged.
