"""C6 through Pluggy: what its open statement holds that it has not sent.

The card closes around the 24th and is due on the 1st. On 2026-11-17 the
open statement (due 2026-12-01) holds three things the synced rows miss:
the next installment of older purchases, charges still pending when the
November statement closed, and the right calendar day for late purchases.
"""

import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.account import Account
from app.models.bank_connection import BankConnection
from app.models.credit_card_bill import CreditCardBill
from app.models.transaction import Transaction
from app.providers.pluggy import PluggyProvider
from app.services.connection_service import _carry_charges_past_closed_bill
from app.services.credit_card_timeline import CreditCardTimeline

TODAY = date(2026, 11, 17)
DECEMBER = "cycle:2026-11-24"


@pytest.fixture(autouse=True)
def _today(monkeypatch):
    monkeypatch.setattr("app.services.installment_forecast.app_today", lambda: TODAY)
    monkeypatch.setattr("app.services.connection_service.app_today", lambda: TODAY)


async def _c6(session, test_user, test_workspace) -> tuple[Account, list[CreditCardBill]]:
    conn = BankConnection(
        id=uuid.uuid4(), user_id=test_user.id, provider="pluggy", external_id="item",
        institution_name="C6", credentials={}, status="active",
        created_at=datetime.now(timezone.utc),
    )
    session.add(conn)
    card = Account(
        user_id=test_user.id, workspace_id=test_workspace.id, connection_id=conn.id,
        name="BANDEIRADO", type="credit_card", balance=Decimal("0"), currency="BRL",
        statement_close_day=24, payment_due_day=1,
    )
    session.add(card)
    await session.flush()
    bills = [
        CreditCardBill(
            user_id=test_user.id, workspace_id=test_workspace.id, account_id=card.id,
            external_id=external_id, due_date=due, closing_date=closing,
            total_amount=Decimal("100"), currency="BRL",
        )
        for external_id, closing, due in (
            ("bill-oct", date(2026, 9, 25), date(2026, 10, 1)),
            ("bill-nov", date(2026, 10, 24), date(2026, 11, 1)),
        )
    ]
    session.add_all(bills)
    await session.flush()
    return card, bills


def _charge(card, user_id, **fields) -> Transaction:
    defaults = dict(
        user_id=user_id, account_id=card.id, workspace_id=card.workspace_id,
        currency="BRL", type="debit", source="sync", status="posted",
    )
    return Transaction(**(defaults | fields))


@pytest.mark.asyncio
async def test_open_statement_holds_the_next_installment_of_older_purchases(
    client, auth_headers, session, test_user, test_workspace
):
    card, (_, november) = await _c6(session, test_user, test_workspace)
    session.add_all([
        # Installment 6/10 was billed in November: 7/10 goes on December.
        _charge(
            card, test_user.id, description="THIAGO PEREIRA", amount=Decimal("720"),
            date=date(2026, 10, 1), effective_date=november.due_date, bill_id=november.id,
            installment_number=6, total_installments=10,
            installment_purchase_date=date(2026, 5, 6),
        ),
        # A finished purchase forecasts nothing.
        _charge(
            card, test_user.id, description="SHEIN", amount=Decimal("50.47"),
            date=date(2026, 10, 1), effective_date=november.due_date, bill_id=november.id,
            installment_number=6, total_installments=6,
            installment_purchase_date=date(2026, 3, 25),
        ),
        # Open charge, in December by its purchase date.
        _charge(
            card, test_user.id, description="Mercado", amount=Decimal("100"),
            date=date(2026, 11, 10), effective_date=date(2026, 12, 1), status="pending",
        ),
    ])
    await session.commit()

    forecasts = await client.get(
        f"/api/accounts/{card.id}/installment-forecasts",
        params={"cycle_key": DECEMBER}, headers=auth_headers,
    )
    assert forecasts.status_code == 200
    assert [
        (item["description"], item["installment_number"], item["amount"])
        for item in forecasts.json()
    ] == [("THIAGO PEREIRA", 7, 720.0)]

    summary = await client.get(
        f"/api/accounts/{card.id}/summary",
        params={"cycle_key": DECEMBER}, headers=auth_headers,
    )
    assert summary.json()["projected_expenses"] == 820.0

    timelines = await CreditCardTimeline.index(
        session, test_workspace.id, [card.id],
        due_from=date(2026, 12, 1), due_to=date(2027, 3, 1), as_of=TODAY,
    )
    totals = {item.due_month: item.amount for item in timelines[card.id].items}
    # 7/10 in December, 8/10 in January, and so on.
    assert totals == {
        "2026-12": Decimal("820"),
        "2027-01": Decimal("720"),
        "2027-02": Decimal("720"),
        "2027-03": Decimal("720"),
    }

    # Once the bank sends 7/10, it is no longer a forecast.
    session.add(_charge(
        card, test_user.id, description="THIAGO PEREIRA", amount=Decimal("720"),
        date=date(2026, 11, 1), effective_date=date(2026, 12, 1), status="pending",
        installment_number=7, total_installments=10,
        installment_purchase_date=date(2026, 5, 6),
    ))
    await session.commit()
    forecasts = await client.get(
        f"/api/accounts/{card.id}/installment-forecasts",
        params={"cycle_key": DECEMBER}, headers=auth_headers,
    )
    assert forecasts.json() == []


@pytest.mark.asyncio
async def test_a_charge_left_out_of_the_closed_statement_goes_on_the_next(
    session, test_user, test_workspace
):
    card, (_, november) = await _c6(session, test_user, test_workspace)
    billed = _charge(
        card, test_user.id, description="Billed", amount=Decimal("10"),
        date=date(2026, 10, 20), effective_date=november.due_date, bill_id=november.id,
    )
    # Pending on the eve of the close; the bank bills it in December.
    left_out = _charge(
        card, test_user.id, description="PG *JAMBLE", amount=Decimal("94"),
        date=date(2026, 10, 23), effective_date=november.due_date, status="pending",
    )
    placed = _charge(
        card, test_user.id, description="Moved by hand", amount=Decimal("5"),
        date=date(2026, 10, 22), effective_date=date(2026, 10, 1),
        effective_bill_date=date(2026, 10, 1), effective_bill_date_source="manual",
    )
    session.add_all([billed, left_out, placed])
    await session.flush()

    await _carry_charges_past_closed_bill(session, card)

    assert (left_out.effective_bill_date, left_out.effective_bill_date_source) == (
        date(2026, 12, 1), "provider",
    )
    assert left_out.effective_date == date(2026, 12, 1)
    assert billed.effective_bill_date is None
    assert placed.effective_bill_date == date(2026, 10, 1)


@pytest.mark.asyncio
async def test_a_bank_that_links_no_charge_to_its_bills_moves_nothing(
    session, test_user, test_workspace
):
    card, (_, november) = await _c6(session, test_user, test_workspace)
    unlinked = _charge(
        card, test_user.id, description="Compra", amount=Decimal("94"),
        date=date(2026, 10, 10), effective_date=november.due_date,
    )
    session.add(unlinked)
    await session.flush()

    await _carry_charges_past_closed_bill(session, card)

    assert unlinked.effective_bill_date is None


@pytest.mark.asyncio
async def test_pluggy_dates_a_late_purchase_on_the_brazilian_day():
    def charge(tx_id: str, moment: str) -> dict:
        return {"id": tx_id, "description": "PG *JAMBLE", "amount": -129.01,
                "date": moment, "type": "DEBIT", "status": "PENDING"}

    response = MagicMock()
    response.raise_for_status = MagicMock()
    response.json = MagicMock(return_value={"results": [
        charge("late", "2026-10-24T01:12:00.000Z"),
        charge("day", "2026-10-24T15:00:00.000Z"),
        charge("bare", "2026-10-24T00:00:00.000Z"),
    ]})
    http = MagicMock()
    http.get = AsyncMock(return_value=response)
    http.__aenter__ = AsyncMock(return_value=http)
    http.__aexit__ = AsyncMock(return_value=None)
    with patch.object(PluggyProvider, "_ensure_api_key", new=AsyncMock(return_value="k")), \
         patch("app.providers.pluggy.httpx.AsyncClient", return_value=http):
        parsed = await PluggyProvider().get_transactions({"item_id": "i"}, "acc")

    assert [tx.date for tx in parsed] == [
        date(2026, 10, 23),
        date(2026, 10, 24),
        date(2026, 10, 24),
    ]


@pytest.mark.asyncio
async def test_pluggy_keeps_one_purchase_across_installment_timestamps():
    """Bradesco sends one purchase as 2026-06-16T00:43Z on some installments
    and 2026-06-15T03:00Z on others; both are 15/06 in Brasília, so it stays
    one purchase and its next installment is forecast once."""
    def installment(number: int, purchase: str) -> dict:
        return {
            "id": f"nova-{number}", "description": "NOVA *NOVA", "amount": -153.62,
            "date": "2026-07-15T03:00:00.000Z", "type": "DEBIT", "status": "POSTED",
            "creditCardMetadata": {
                "installmentNumber": number, "totalInstallments": 10,
                "purchaseDate": purchase,
            },
        }

    response = MagicMock()
    response.raise_for_status = MagicMock()
    response.json = MagicMock(return_value={"results": [
        installment(1, "2026-06-16T00:43:54.067Z"),
        installment(3, "2026-06-15T03:00:00.000Z"),
    ]})
    http = MagicMock()
    http.get = AsyncMock(return_value=response)
    http.__aenter__ = AsyncMock(return_value=http)
    http.__aexit__ = AsyncMock(return_value=None)
    with patch.object(PluggyProvider, "_ensure_api_key", new=AsyncMock(return_value="k")), \
         patch("app.providers.pluggy.httpx.AsyncClient", return_value=http):
        parsed = await PluggyProvider().get_transactions({"item_id": "i"}, "acc")

    assert [tx.installment_purchase_date for tx in parsed] == [date(2026, 6, 15)] * 2


@pytest.mark.asyncio
async def test_hidden_card_installments_are_not_forecast(
    client, auth_headers, session, test_user, test_workspace
):
    from app.models.account_card import AccountCard

    card, (_, november) = await _c6(session, test_user, test_workspace)
    session.add(AccountCard(
        workspace_id=test_workspace.id, account_id=card.id, last4="4522", is_hidden=True,
        created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc),
    ))
    session.add(_charge(
        card, test_user.id, description="Hidden card", amount=Decimal("99"),
        date=date(2026, 10, 1), effective_date=november.due_date, bill_id=november.id,
        installment_number=1, total_installments=3,
        installment_purchase_date=date(2026, 10, 1), card_last4="4522",
    ))
    await session.commit()

    forecasts = await client.get(
        f"/api/accounts/{card.id}/installment-forecasts",
        params={"cycle_key": DECEMBER}, headers=auth_headers,
    )
    assert forecasts.json() == []
