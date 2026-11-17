# Nubank credit card through Pluggy

What the Nubank Open Finance connector sends, as observed in production, and
how Securo reads it. Observed on the `ultraviolet-black` card in November 2026.

## Card and cycle

- One account holds several physical and virtual cards. Pluggy sends the last
  digits in `creditCardMetadata.cardNumber` (seen: `0339`, `8888`, `3004`);
  Securo stores them in `transactions.card_last4` and lists them in
  `account_cards`.
- The bill closes on the 2nd and is due on the 9th, so closing and due date fall
  in the same month. A bank bill may still be due a day later than the
  configured due day (the August 2026 bill was due on the 10th).

## Bill placement

- A billed charge carries `creditCardMetadata.billId`, linked to
  `credit_card_bills` at sync. That bill always wins.
- A charge not billed yet carries no `billId` but does carry
  `billForecastDate` (`YYYY-MM`). Securo reads it as the bill's due month and
  places the charge on that month's due day (ADR 0002,
  `effective_bill_date_source = 'provider'`).
- Of 1270 billed charges carrying both fields, 1264 had a forecast equal to the
  bill's due month. Because this card closes and is due in the same month, the
  same 1264 also matched the closing month: the data does not tell the two
  readings apart. Recheck with the query below on any card that closes in one
  month and is due in the next.
- The other 6 had a stale forecast: four May 2026 charges billed in June with a
  forecast of July, a refund billed in August with a forecast of September, and
  two identical iFood charges of R$ 116.07 billed in March and April with a
  forecast of July. Their `billId` places them correctly.

## Pix no crédito

- The connector sends it as a card charge: `operationType`
  `OPERACOES_CREDITO_CONTRATADAS_CARTAO`, `paymentType` `SINGLE`, status
  `PENDING`, no `billId`, the purchase timestamp as `date`, plus
  `billPostDate` (the day Nubank posts it to a bill) and `billForecastDate`.
- Nubank bills it months after the purchase. A Pix on 2026-10-31 had
  `billPostDate` 2026-12-11 and `billForecastDate` 2027-01; the bank app shows
  it on the January 2027 bill. Cycle math alone put it on the November 2026
  bill, which is why the forecast is read.
- The amount includes Nubank's fee. The same day's
  `Transferência enviada | 99 FOOD LTDA` on the Nu Pagamentos account was a
  separate Pix, not the funding leg of this one.

## Diagnostic queries

Run with `psql` inside the `securo_db` container
(`psql -U "$POSTGRES_USER" -d "${POSTGRES_DB:-$POSTGRES_USER}"`).

Does the forecast name the due month or the closing month?

```sql
SELECT count(*) FILTER (WHERE f = to_char(b.due_date, 'YYYY-MM'))     AS matches_due,
       count(*) FILTER (WHERE f = to_char(b.closing_date, 'YYYY-MM')) AS matches_closing,
       count(*) AS total
FROM (SELECT bill_id, raw_data::jsonb -> 'creditCardMetadata' ->> 'billForecastDate' AS f
      FROM transactions WHERE bill_id IS NOT NULL) x
JOIN credit_card_bills b ON b.id = x.bill_id
WHERE f IS NOT NULL;
```

Which charges sit on a forecast bill?

```sql
SELECT a.name, t.date, t.description, t.amount, t.status, t.effective_bill_date
FROM transactions t JOIN accounts a ON a.id = t.account_id
WHERE t.effective_bill_date_source = 'provider'
ORDER BY t.effective_bill_date, t.date;
```

What did the bank send for one charge?

```sql
SELECT raw_data->>'date', raw_data->>'status', raw_data->>'operationType',
       raw_data->'creditCardMetadata'
FROM transactions
WHERE description = '99 FOOD LTDA' AND amount = 146.08;
```
