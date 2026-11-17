# Use a canonical credit-card timeline for statements

Status: accepted

The backend owns credit-card billing-cycle semantics through a deep timeline module. Its interface returns canonical Statement, Statement Projection, or unavailable items and an opaque cycle key reused by summaries and paginated transaction reads, so account detail and card overview cannot independently reinterpret statement priority, dates, fallback, or transaction membership.

## Considered options

A request-oriented snapshot would make each screen simpler, but its compact/detail variants would absorb transactions, charts, navigation, and presentation concerns into one growing interface. The canonical timeline preserves those existing read paths while giving them one shared seam and supports a batch read for card overview.

## Consequences

Bank Statements take precedence over manual Statements, which take precedence over Statement Projections; bank dates take precedence over configured dates. Generic user-selected date ranges remain outside the timeline. Existing public statement parameters are removed in a clean cutover, historical credit-card effective dates are recomputed in batches, and the existing bank-provider seam remains unchanged until a second real statement adapter exists.
