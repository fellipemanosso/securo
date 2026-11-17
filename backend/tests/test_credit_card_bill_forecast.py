"""A charge the bank bills months after the purchase (Pix no crédito) sits on
the bill the bank forecasts, until the bank bills it.

The card closes on the 2nd and is due on the 9th. A purchase on 2026-10-31
falls in the November bill by cycle math, but the bank reports
billForecastDate "2027-01": it is billed in January 2027.
"""

import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.account import Account
from app.models.bank_connection import BankConnection
from app.models.transaction import Transaction
from app.providers.base import AccountData, BillData, TransactionData
from app.providers.pluggy import PluggyProvider
from app.services.connection_service import sync_connection
from app.services.credit_card_timeline import CreditCardTimeline

PURCHASE = date(2026, 10, 31)
FORECAST_DUE = date(2027, 1, 9)
JANUARY_CYCLE = "cycle:2027-01-02"
DECEMBER_CYCLE = "cycle:2026-12-02"
NOVEMBER_CYCLE = "cycle:2026-11-02"


async def _pluggy_transactions(raw: list[dict]) -> list[TransactionData]:
    response = MagicMock()
    response.raise_for_status = MagicMock()
    response.json = MagicMock(return_value={"results": raw, "totalPages": 1})
    client = MagicMock()
    client.get = AsyncMock(return_value=response)
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=None)
    with patch.object(
        PluggyProvider, "_ensure_api_key", new=AsyncMock(return_value="fake-key")
    ), patch("app.providers.pluggy.httpx.AsyncClient", return_value=client):
        return await PluggyProvider().get_transactions({"item_id": "i"}, "acc")


@pytest.mark.asyncio
async def test_pluggy_reads_the_forecast_month_and_ignores_malformed_ones():
    def charge(tx_id: str, forecast) -> dict:
        return {
            "id": tx_id,
            "description": "99 FOOD LTDA",
            "amount": 146.08,
            "date": "2026-10-31T22:30:23.498Z",
            "type": "DEBIT",
            "status": "PENDING",
            "creditCardMetadata": {"billForecastDate": forecast},
        }

    parsed = await _pluggy_transactions(
        [charge("ok", "2027-01"), charge("bad", "2027-13"), charge("none", None)]
    )

    assert [tx.bill_forecast_month for tx in parsed] == [date(2027, 1, 1), None, None]


async def _sync(session, test_user, test_workspace, conn, txn, bills=()):
    provider = AsyncMock()
    provider.refresh_credentials = AsyncMock(return_value={"token": "t"})
    provider.get_accounts = AsyncMock(return_value=[
        AccountData(
            external_id="card", name="Card", type="credit_card",
            balance=Decimal("0"), currency="BRL",
            statement_close_day=2, payment_due_day=9,
        )
    ])
    provider.get_transactions = AsyncMock(return_value=[txn])
    provider.get_bills = AsyncMock(return_value=list(bills))
    with patch("app.services.connection_service.get_provider", return_value=provider), \
         patch("app.services.connection_service.detect_transfer_pairs", new_callable=AsyncMock), \
         patch("app.services.connection_service.stamp_primary_amount", new_callable=AsyncMock), \
         patch("app.services.connection_service.apply_rules_to_transaction", new_callable=AsyncMock):
        await sync_connection(session, conn.id, test_workspace.id, test_user.id)
    return (
        await session.execute(select(Transaction).where(Transaction.external_id == txn.external_id))
    ).scalar_one()


@pytest.mark.asyncio
async def test_sync_places_an_unbilled_charge_on_the_forecast_bill_until_it_is_billed(
    session: AsyncSession, test_user, test_workspace
):
    conn = BankConnection(
        id=uuid.uuid4(), user_id=test_user.id, provider="test",
        external_id="item", institution_name="Bank", credentials={"token": "t"},
        status="active", created_at=datetime.now(timezone.utc),
    )
    session.add(conn)
    await session.commit()
    pending = TransactionData(
        external_id="pix", description="99 FOOD LTDA", amount=Decimal("146.08"),
        date=PURCHASE, type="debit", currency="BRL", status="pending",
        bill_forecast_month=date(2027, 1, 1),
    )

    row = await _sync(session, test_user, test_workspace, conn, pending)

    assert row.effective_bill_date == FORECAST_DUE
    assert row.effective_bill_date_source == "provider"
    assert row.effective_date == FORECAST_DUE

    # The bank bills it: its bill wins over the forecast.
    billed = TransactionData(
        external_id="pix", description="99 FOOD LTDA", amount=Decimal("146.08"),
        date=PURCHASE, type="debit", currency="BRL", status="posted",
        bill_external_id="bill-jan", bill_forecast_month=date(2027, 1, 1),
    )
    bill = BillData(
        external_id="bill-jan", due_date=date(2027, 1, 11),
        total_amount=Decimal("146.08"), currency="BRL",
    )

    row = await _sync(session, test_user, test_workspace, conn, billed, [bill])

    assert row.bill_id is not None
    assert row.effective_bill_date is None
    assert row.effective_bill_date_source is None
    assert row.effective_date == date(2027, 1, 11)


@pytest.mark.asyncio
async def test_sync_ignores_a_forecast_naming_a_bill_closed_before_the_purchase(
    session: AsyncSession, test_user, test_workspace
):
    """C6 forecasts an open charge of 2026-10-27 on "2026-10", whose bill
    closed on 2026-10-02 here. Cycle math puts it on the November bill."""
    conn = BankConnection(
        id=uuid.uuid4(), user_id=test_user.id, provider="test",
        external_id="item", institution_name="Bank", credentials={"token": "t"},
        status="active", created_at=datetime.now(timezone.utc),
    )
    session.add(conn)
    await session.commit()
    charge = TransactionData(
        external_id="open", description="Mercado", amount=Decimal("50"),
        date=date(2026, 10, 27), type="debit", currency="BRL", status="pending",
        bill_forecast_month=date(2026, 10, 1),
    )

    row = await _sync(session, test_user, test_workspace, conn, charge)

    assert row.effective_bill_date is None
    assert row.effective_date == date(2026, 11, 9)

    # A placement left by an earlier, laxer sync goes back to cycle math.
    row.effective_bill_date = date(2026, 10, 9)
    row.effective_bill_date_source = "provider"
    await session.commit()

    row = await _sync(session, test_user, test_workspace, conn, charge)

    assert row.effective_bill_date is None
    assert row.effective_bill_date_source is None
    assert row.effective_date == date(2026, 11, 9)


@pytest.mark.asyncio
async def test_sync_keeps_a_users_own_placement_over_the_forecast(
    session: AsyncSession, test_user, test_workspace
):
    conn = BankConnection(
        id=uuid.uuid4(), user_id=test_user.id, provider="test",
        external_id="item", institution_name="Bank", credentials={"token": "t"},
        status="active", created_at=datetime.now(timezone.utc),
    )
    session.add(conn)
    await session.commit()
    charge = TransactionData(
        external_id="pix", description="99 FOOD LTDA", amount=Decimal("146.08"),
        date=PURCHASE, type="debit", currency="BRL", status="pending",
    )
    row = await _sync(session, test_user, test_workspace, conn, charge)
    row.effective_bill_date = date(2026, 12, 9)
    row.effective_bill_date_source = "manual"
    await session.commit()

    charge.bill_forecast_month = date(2027, 1, 1)
    row = await _sync(session, test_user, test_workspace, conn, charge)

    assert row.effective_bill_date == date(2026, 12, 9)
    assert row.effective_bill_date_source == "manual"


async def _card_with_forecast_charge(session, test_user, test_workspace):
    card = Account(
        user_id=test_user.id, workspace_id=test_workspace.id, name="Card",
        type="credit_card", balance=Decimal("0"), currency="BRL",
        statement_close_day=2, payment_due_day=9,
    )
    session.add(card)
    await session.flush()
    charge = Transaction(
        user_id=test_user.id, workspace_id=test_workspace.id, account_id=card.id,
        description="99 FOOD LTDA", amount=Decimal("146.08"), currency="BRL",
        date=PURCHASE, effective_date=FORECAST_DUE, type="debit",
        source="sync", status="pending",
        effective_bill_date=FORECAST_DUE, effective_bill_date_source="provider",
    )
    session.add(charge)
    await session.commit()
    return card, charge


@pytest.mark.asyncio
async def test_forecast_charge_shows_only_on_its_forecast_bill(
    client, auth_headers, session, test_user, test_workspace
):
    card, charge = await _card_with_forecast_charge(session, test_user, test_workspace)

    async def listed(cycle_key: str) -> list[str]:
        response = await client.get(
            "/api/transactions",
            params={"account_id": str(card.id), "cycle_key": cycle_key},
            headers=auth_headers,
        )
        assert response.status_code == 200
        return [item["id"] for item in response.json()["items"]]

    async def expenses(cycle_key: str) -> float:
        response = await client.get(
            f"/api/accounts/{card.id}/summary",
            params={"cycle_key": cycle_key},
            headers=auth_headers,
        )
        assert response.status_code == 200
        return response.json()["projected_expenses"]

    for cycle_key in (NOVEMBER_CYCLE, DECEMBER_CYCLE):
        assert await listed(cycle_key) == []
        assert await expenses(cycle_key) == 0
    assert await listed(JANUARY_CYCLE) == [str(charge.id)]
    assert await expenses(JANUARY_CYCLE) == 146.08

    timelines = await CreditCardTimeline.index(
        session, test_workspace.id, [card.id],
        due_from=date(2026, 11, 1), due_to=date(2027, 2, 28), as_of=date(2026, 11, 1),
    )
    totals = {item.due_month: item.amount for item in timelines[card.id].items}
    assert totals == {
        "2026-11": Decimal("0"),
        "2026-12": Decimal("0"),
        "2027-01": Decimal("146.08"),
        "2027-02": Decimal("0"),
    }


@pytest.mark.asyncio
async def test_saving_the_form_unchanged_keeps_the_bank_forecast(
    client, auth_headers, session, test_user, test_workspace
):
    _, charge = await _card_with_forecast_charge(session, test_user, test_workspace)

    async def save(effective_bill_date: str) -> dict:
        response = await client.patch(
            f"/api/transactions/{charge.id}",
            json={"effective_bill_date": effective_bill_date, "notes": "jantar"},
            headers=auth_headers,
        )
        assert response.status_code == 200
        return response.json()

    unchanged = await save(FORECAST_DUE.isoformat())
    assert unchanged["effective_bill_date_source"] == "provider"

    moved = await save("2027-02-09")
    assert moved["effective_bill_date"] == "2027-02-09"
    assert moved["effective_bill_date_source"] == "manual"
