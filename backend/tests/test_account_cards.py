import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.transaction import Transaction


async def _create_card_account(client: AsyncClient, auth_headers) -> str:
    response = await client.post(
        "/api/accounts",
        headers=auth_headers,
        json={"name": "Nubank", "type": "credit_card", "balance": "0.00", "currency": "BRL"},
    )
    assert response.status_code == 201
    return response.json()["id"]


async def _add_charges(
    session: AsyncSession, user, account_id: str, charges: list[tuple[str | None, str, int]]
) -> None:
    """Posted debits dated `days_ago` days back, charged to the given card."""
    today = date.today()
    for card_last4, amount, days_ago in charges:
        session.add(
            Transaction(
                id=uuid.uuid4(),
                user_id=user.id,
                account_id=uuid.UUID(account_id),
                description=f"Charge {card_last4} {amount}",
                amount=Decimal(amount),
                currency="BRL",
                date=today - timedelta(days=days_ago),
                type="debit",
                source="manual",
                card_last4=card_last4,
                created_at=datetime.now(timezone.utc),
            )
        )
    await session.commit()


@pytest.mark.asyncio
async def test_cards_listed_with_stats_newest_first(
    client: AsyncClient, auth_headers, session: AsyncSession, test_user
):
    account_id = await _create_card_account(client, auth_headers)
    await _add_charges(
        session, test_user, account_id,
        [("1111", "10.00", 5), ("1111", "20.00", 1), ("2222", "5.00", 3), (None, "1.00", 0)],
    )

    response = await client.get(f"/api/accounts/{account_id}/cards", headers=auth_headers)

    assert response.status_code == 200
    today = date.today()
    assert response.json() == [
        {
            "last4": "1111",
            "alias": None,
            "is_hidden": False,
            "transaction_count": 2,
            "first_date": (today - timedelta(days=5)).isoformat(),
            "last_date": (today - timedelta(days=1)).isoformat(),
        },
        {
            "last4": "2222",
            "alias": None,
            "is_hidden": False,
            "transaction_count": 1,
            "first_date": (today - timedelta(days=3)).isoformat(),
            "last_date": (today - timedelta(days=3)).isoformat(),
        },
    ]


@pytest.mark.asyncio
async def test_cards_empty_without_card_data_and_404_for_unknown_account(
    client: AsyncClient, auth_headers
):
    account_id = await _create_card_account(client, auth_headers)

    empty = await client.get(f"/api/accounts/{account_id}/cards", headers=auth_headers)
    unknown = await client.get(f"/api/accounts/{uuid.uuid4()}/cards", headers=auth_headers)

    assert empty.status_code == 200
    assert empty.json() == []
    assert unknown.status_code == 404


@pytest.mark.asyncio
async def test_patch_card_sets_alias_and_hidden_independently(
    client: AsyncClient, auth_headers, session: AsyncSession, test_user
):
    account_id = await _create_card_account(client, auth_headers)
    await _add_charges(session, test_user, account_id, [("1111", "10.00", 0)])
    url = f"/api/accounts/{account_id}/cards/1111"

    renamed = await client.patch(url, headers=auth_headers, json={"alias": "Virtual"})
    hidden = await client.patch(url, headers=auth_headers, json={"is_hidden": True})
    cleared = await client.patch(url, headers=auth_headers, json={"alias": ""})
    listed = await client.get(f"/api/accounts/{account_id}/cards", headers=auth_headers)

    assert renamed.status_code == 200
    assert renamed.json()["alias"] == "Virtual"
    assert renamed.json()["is_hidden"] is False
    assert hidden.json()["alias"] == "Virtual"
    assert hidden.json()["is_hidden"] is True
    assert cleared.json()["alias"] is None
    assert cleared.json()["is_hidden"] is True
    assert listed.json()[0]["alias"] is None
    assert listed.json()[0]["is_hidden"] is True
    assert listed.json()[0]["transaction_count"] == 1


@pytest.mark.asyncio
async def test_patch_unknown_card_is_404(
    client: AsyncClient, auth_headers, session: AsyncSession, test_user
):
    account_id = await _create_card_account(client, auth_headers)
    await _add_charges(session, test_user, account_id, [("1111", "10.00", 0)])

    response = await client.patch(
        f"/api/accounts/{account_id}/cards/9999", headers=auth_headers, json={"is_hidden": True}
    )

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_transactions_list_excludes_cards_but_keeps_rows_without_card(
    client: AsyncClient, auth_headers, session: AsyncSession, test_user
):
    account_id = await _create_card_account(client, auth_headers)
    await _add_charges(
        session, test_user, account_id,
        [("1111", "10.00", 0), ("2222", "20.00", 0), ("3333", "30.00", 0), (None, "40.00", 0)],
    )

    response = await client.get(
        "/api/transactions",
        headers=auth_headers,
        params={"account_id": account_id, "exclude_card_last4": ["1111", "2222"]},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 2
    assert {item["card_last4"] for item in body["items"]} == {"3333", None}
    assert Decimal(str(body["summary"]["expense"])) == Decimal("70.00")


@pytest.mark.asyncio
async def test_transactions_list_without_filter_returns_every_card(
    client: AsyncClient, auth_headers, session: AsyncSession, test_user
):
    account_id = await _create_card_account(client, auth_headers)
    await _add_charges(
        session, test_user, account_id, [("1111", "10.00", 0), (None, "40.00", 0)]
    )

    response = await client.get(
        "/api/transactions", headers=auth_headers, params={"account_id": account_id}
    )

    assert response.json()["total"] == 2


@pytest.mark.asyncio
async def test_account_summary_excludes_cards_but_keeps_rows_without_card(
    client: AsyncClient, auth_headers, session: AsyncSession, test_user
):
    account_id = await _create_card_account(client, auth_headers)
    await _add_charges(
        session, test_user, account_id,
        [("1111", "100.00", 0), ("2222", "40.00", 0), (None, "10.00", 0)],
    )
    url = f"/api/accounts/{account_id}/summary"

    everything = await client.get(url, headers=auth_headers)
    without_one = await client.get(
        url, headers=auth_headers, params={"exclude_card_last4": ["1111"]}
    )
    without_both = await client.get(
        url, headers=auth_headers, params={"exclude_card_last4": ["1111", "2222"]}
    )

    assert everything.json()["monthly_expenses"] == pytest.approx(150.00)
    assert without_one.json()["monthly_expenses"] == pytest.approx(50.00)
    assert without_one.json()["projected_expenses"] == pytest.approx(50.00)
    assert without_both.json()["monthly_expenses"] == pytest.approx(10.00)


@pytest.mark.asyncio
async def test_account_summary_with_hidden_card_never_goes_negative_from_card_payment(
    client: AsyncClient, auth_headers, session: AsyncSession, test_user
):
    account_id = await _create_card_account(client, auth_headers)
    await _add_charges(
        session, test_user, account_id, [("1111", "100.00", 0), ("2222", "150.00", 0)]
    )
    # The bill was paid in full from a checking account: one credit on the
    # card, with no last4, paired to the debit on the other side.
    session.add(
        Transaction(
            id=uuid.uuid4(),
            user_id=test_user.id,
            account_id=uuid.UUID(account_id),
            description="Pagamento recebido",
            amount=Decimal("250.00"),
            currency="BRL",
            date=date.today(),
            type="credit",
            source="manual",
            transfer_pair_id=uuid.uuid4(),
            created_at=datetime.now(timezone.utc),
        )
    )
    await session.commit()

    response = await client.get(
        f"/api/accounts/{account_id}/summary",
        headers=auth_headers,
        params={"exclude_card_last4": ["2222"]},
    )

    assert response.json()["monthly_expenses"] == pytest.approx(100.00)
