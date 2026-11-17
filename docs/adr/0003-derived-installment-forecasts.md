# Derive installment forecasts instead of storing them

Status: accepted

Some banks send an installment only once it is billed: C6 through Pluggy sends installment k when it lands on a statement and never k+1 ahead of time, so a statement projection built from synced rows misses every installment of an older purchase. Securo derives the missing installments on read (`installment_forecast`): for each synced purchase, identified by card, purchase date and installment count, the latest installment k fixes the statement it is on, and installment k + j goes on the statement j months later. Statement projection totals, the timeline and the open statement's list count them; closed statements never do.

## Considered options

Storing the forecasts as pending transactions would put them in every list and report for free, but each one would then need deleting when the bank's own installment arrives, and synced-row machinery (duplicate detection, phantom cleanup, opening-balance reconciliation) would have to learn to skip them. A forecast derived from the latest synced installment disappears by construction as soon as the bank sends the next one, and the bank's rows stay the only stored truth.

## Consequences

Forecasts are not transactions: they cannot be categorized, edited or reported on their own, and their category is the purchase's. A purchase whose next installment the bank never sends (an early payoff) keeps forecasting until its statement closes; closed statements are excluded because a missing installment there is the bank's record. Two purchases on the same card and day with the same installment count are told apart only by their latest synced rows.
