# Place unbilled charges on the bank's forecast bill

Status: accepted

Some charges are billed months after the purchase, such as a Pix no crédito, so cycle math puts them on the wrong statement. When the bank sends a charge's forecast bill (Pluggy `creditCardMetadata.billForecastDate`, read as a due month) without a `billId`, and that bill is later than the one cycle math gives the purchase, sync places the charge on it through `effective_bill_date`, the same due-date placement a user override uses, and records `effective_bill_date_source = "provider"`. A bank `billId` replaces the forecast once the charge is billed; a manual placement beats both and is never touched by sync.

## Considered options

A separate forecast column would keep the user's override field purely manual, but every statement, summary, report, and timeline query would then have to merge two placements. Reusing the placement field with a source keeps one membership rule.

Trusting every forecast was the first version (migration 112). Connectors disagree on what the field means: Nubank sends the due month, C6 a month whose bill had already closed when the purchase was made, which hid all of C6's open charges on a past bill. Accepting a forecast only when it falls after the bill cycle math gives the purchase holds for both, because no bill can carry a charge made after it closed; migration 113 dropped the forecasts that defer nothing. For an installment the purchase is its original purchase date, not the row's date: Itaú sends future installments dated on the due date of the bill they land on, which put each one a bill late until migration 116.

## Consequences

A placed charge belongs to the statement whose (previous due date, due date] range holds the placement, in statement projections as well as closed cycles. A placement past the open cycle therefore shows on its own future projection instead of the open cycle. A forecast that matches or precedes cycle math changes nothing, so the field only matters for deferred charges.

What the connectors actually send is recorded in [docs/integrations/nubank-pluggy.md](../integrations/nubank-pluggy.md) and [docs/integrations/c6-pluggy.md](../integrations/c6-pluggy.md).
