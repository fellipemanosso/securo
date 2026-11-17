# Place unbilled charges on the bank's forecast bill

Status: accepted

Some charges are billed months after the purchase, such as a Pix no crédito, so cycle math puts them on the wrong statement. When the bank sends a charge's forecast bill (Pluggy `creditCardMetadata.billForecastDate`, a due month) without a `billId`, sync places the charge on that bill through `effective_bill_date`, the same due-date placement a user override uses, and records `effective_bill_date_source = "provider"`. A bank `billId` replaces the forecast once the charge is billed; a manual placement beats both and is never touched by sync.

## Considered options

A separate forecast column would keep the user's override field purely manual, but every statement, summary, report, and timeline query would then have to merge two placements. Reusing the placement field with a source keeps one membership rule.

## Consequences

A placed charge belongs to the statement whose (previous due date, due date] range holds the placement, in statement projections as well as closed cycles. A placement past the open cycle therefore shows on its own future projection instead of the open cycle. The forecast month is read as the due month, which matches the bank app for the observed Nubank Pix no crédito. Existing synced charges are placed from their stored provider payload by migration 112.
