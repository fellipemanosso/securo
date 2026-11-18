"""The categorization review: where each category came from, what the user's
history suggests for an uncategorized row, and which rows look like one the
user just recategorized."""

import uuid
from datetime import date, datetime, timezone
from decimal import Decimal

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.account import Account
from app.models.category import Category
from app.models.payee import Payee
from app.models.rule import Rule
from app.models.transaction import Transaction, stamp_category_source
from app.models.user import User
from app.services.connection_service import _stamp_sync_category


def _tx(user: User, account: Account, description: str, **kwargs) -> Transaction:
    values = dict(
        id=uuid.uuid4(),
        user_id=user.id,
        account_id=account.id,
        description=description,
        amount=Decimal("10.00"),
        date=date(2026, 11, 5),
        type="debit",
        source="manual",
        created_at=datetime.now(timezone.utc),
    )
    values.update(kwargs)
    return Transaction(**values)


async def _reload(session: AsyncSession, tx_id: uuid.UUID) -> Transaction:
    result = await session.execute(
        select(Transaction)
        .where(Transaction.id == tx_id)
        .execution_options(populate_existing=True)
    )
    return result.scalar_one()


# --- provenance ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_rule_categorization_records_the_rule(
    client: AsyncClient, auth_headers, test_account, test_rules: list[Rule], test_categories
):
    response = await client.post(
        "/api/transactions",
        headers=auth_headers,
        json={
            "account_id": str(test_account.id),
            "description": "UBER *TRIP",
            "amount": "18.00",
            "date": "2026-11-05",
            "type": "debit",
        },
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["category_id"] == str(test_categories[1].id)
    assert body["category_source"] == "rule"
    assert body["category_rule_id"] == str(test_rules[0].id)


@pytest.mark.asyncio
async def test_a_category_picked_on_create_is_manual(
    client: AsyncClient, auth_headers, test_account, test_categories
):
    response = await client.post(
        "/api/transactions",
        headers=auth_headers,
        json={
            "account_id": str(test_account.id),
            "description": "Feira",
            "amount": "30.00",
            "date": "2026-11-05",
            "type": "debit",
            "category_id": str(test_categories[0].id),
        },
    )
    assert response.status_code == 201, response.text
    assert response.json()["category_source"] == "manual"


@pytest.mark.asyncio
async def test_editing_the_category_records_manual_but_a_resave_keeps_the_rule(
    client: AsyncClient, auth_headers, session: AsyncSession, test_user, test_account, test_categories, test_rules
):
    tx = _tx(test_user, test_account, "UBER TRIP", category_id=test_categories[1].id)
    stamp_category_source(tx, "rule", test_rules[0].id)
    session.add(tx)
    await session.commit()

    # The form echoes the category back on every save.
    resave = await client.patch(
        f"/api/transactions/{tx.id}",
        headers=auth_headers,
        json={"category_id": str(test_categories[1].id), "notes": "corrida"},
    )
    assert resave.status_code == 200, resave.text
    assert resave.json()["category_source"] == "rule"
    assert resave.json()["category_rule_id"] == str(test_rules[0].id)

    changed = await client.patch(
        f"/api/transactions/{tx.id}",
        headers=auth_headers,
        json={"category_id": str(test_categories[0].id)},
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["category_source"] == "manual"
    assert changed.json()["category_rule_id"] is None


@pytest.mark.asyncio
async def test_bulk_categorize_records_the_source_only_where_the_category_changes(
    client: AsyncClient, auth_headers, session: AsyncSession, test_user, test_account, test_categories, test_rules
):
    food = test_categories[0].id
    already = _tx(test_user, test_account, "IFOOD", category_id=food)
    stamp_category_source(already, "rule", test_rules[1].id)
    loose = _tx(test_user, test_account, "IFOOD *2")
    session.add_all([already, loose])
    await session.commit()

    response = await client.patch(
        "/api/transactions/bulk-categorize",
        headers=auth_headers,
        json={
            "transaction_ids": [str(already.id), str(loose.id)],
            "category_id": str(food),
            "category_source": "suggestion",
        },
    )
    assert response.status_code == 200, response.text

    kept = await _reload(session, already.id)
    assert (kept.category_source, kept.category_rule_id) == ("rule", test_rules[1].id)
    accepted = await _reload(session, loose.id)
    assert (accepted.category_id, accepted.category_source) == (food, "suggestion")

    cleared = await client.patch(
        "/api/transactions/bulk-categorize",
        headers=auth_headers,
        json={"transaction_ids": [str(loose.id)], "category_id": None},
    )
    assert cleared.status_code == 200
    assert (await _reload(session, loose.id)).category_source is None


@pytest.mark.asyncio
async def test_an_undeclared_category_change_forgets_the_old_provenance(
    session: AsyncSession, test_user, test_account, test_categories, test_rules
):
    tx = _tx(test_user, test_account, "UBER", category_id=test_categories[1].id)
    stamp_category_source(tx, "rule", test_rules[0].id)
    session.add(tx)
    await session.commit()

    loaded = await _reload(session, tx.id)
    loaded.category_id = test_categories[0].id
    await session.commit()

    after = await _reload(session, tx.id)
    assert (after.category_source, after.category_rule_id) == (None, None)


@pytest.mark.asyncio
async def test_a_rule_replacing_another_rules_category_keeps_saying_rule(
    session: AsyncSession, test_user, test_account, test_categories, test_rules
):
    tx = _tx(test_user, test_account, "UBER", category_id=test_categories[1].id)
    stamp_category_source(tx, "rule", test_rules[0].id)
    session.add(tx)
    await session.commit()

    loaded = await _reload(session, tx.id)
    loaded.category_id = test_categories[0].id
    stamp_category_source(loaded, "rule", test_rules[0].id)
    await session.commit()

    after = await _reload(session, tx.id)
    assert (after.category_id, after.category_source) == (test_categories[0].id, "rule")


def test_a_synced_parcel_keeps_the_provenance_of_the_parcel_it_copied():
    category = uuid.uuid4()
    earlier = Transaction(category_id=category, category_source="manual")
    copied = Transaction(category_id=category)
    _stamp_sync_category(copied, earlier)
    assert copied.category_source == "manual"

    from_bank = Transaction(category_id=uuid.uuid4())
    _stamp_sync_category(from_bank, earlier)
    assert from_bank.category_source == "provider"


# --- suggestions --------------------------------------------------------------


@pytest.mark.asyncio
async def test_suggestions_follow_the_payee_first_then_the_description(
    client: AsyncClient, auth_headers, session: AsyncSession, test_user, test_account, test_categories
):
    food, transport, income = (c.id for c in test_categories)
    padaria = Payee(id=uuid.uuid4(), user_id=test_user.id, name="Padaria")
    session.add(padaria)
    await session.flush()
    session.add_all(
        [
            # The payee was filed under food twice and transport once.
            _tx(test_user, test_account, "PADARIA A", payee_id=padaria.id, category_id=food),
            _tx(test_user, test_account, "PADARIA B", payee_id=padaria.id, category_id=food),
            _tx(test_user, test_account, "PADARIA C", payee_id=padaria.id, category_id=transport),
            # Same description, other direction: a refund is not a purchase.
            _tx(test_user, test_account, "Uber Trip", category_id=transport),
            _tx(test_user, test_account, "UBER TRIP", type="credit", category_id=income),
            _tx(test_user, test_account, "UBER TRIP", type="credit", category_id=income),
        ]
    )
    by_payee = _tx(test_user, test_account, "Nova descrição", payee_id=padaria.id)
    by_description = _tx(test_user, test_account, "  uber trip ")
    nothing = _tx(test_user, test_account, "NUNCA VISTO")
    categorized = _tx(test_user, test_account, "UBER TRIP", category_id=food)
    session.add_all([by_payee, by_description, nothing, categorized])
    await session.commit()

    response = await client.post(
        "/api/transactions/category-suggestions",
        headers=auth_headers,
        json={"transaction_ids": [str(t.id) for t in (by_payee, by_description, nothing, categorized)]},
    )
    assert response.status_code == 200, response.text
    suggestions = {item["transaction_id"]: item for item in response.json()}
    assert set(suggestions) == {str(by_payee.id), str(by_description.id)}
    assert suggestions[str(by_payee.id)] == {
        "transaction_id": str(by_payee.id),
        "category_id": str(food),
        "uses": 2,
        "matched_by": "payee",
    }
    assert suggestions[str(by_description.id)]["category_id"] == str(transport)
    assert suggestions[str(by_description.id)]["matched_by"] == "description"


@pytest.mark.asyncio
async def test_suggestions_skip_hidden_categories(
    client: AsyncClient, auth_headers, session: AsyncSession, test_user, test_account
):
    hidden = Category(id=uuid.uuid4(), user_id=test_user.id, name="Antiga", icon="x", color="#000", is_hidden=True)
    session.add(hidden)
    await session.flush()
    session.add(_tx(test_user, test_account, "MERCADO", category_id=hidden.id))
    target = _tx(test_user, test_account, "MERCADO")
    session.add(target)
    await session.commit()

    response = await client.post(
        "/api/transactions/category-suggestions",
        headers=auth_headers,
        json={"transaction_ids": [str(target.id)]},
    )
    assert response.status_code == 200
    assert response.json() == []


# --- similar ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_similar_lists_the_same_payee_or_description_in_any_month(
    client: AsyncClient, auth_headers, session: AsyncSession, test_user, test_account, test_categories
):
    food = test_categories[0].id
    anchor = _tx(test_user, test_account, "Spotify")
    older = _tx(test_user, test_account, "SPOTIFY ", date=date(2026, 3, 5), category_id=food)
    same_month = _tx(test_user, test_account, "spotify")
    refund = _tx(test_user, test_account, "Spotify", type="credit")
    transfer = _tx(test_user, test_account, "Spotify", transfer_pair_id=uuid.uuid4())
    ignored = _tx(test_user, test_account, "Spotify", is_ignored=True)
    other = _tx(test_user, test_account, "Deezer")
    session.add_all([anchor, older, same_month, refund, transfer, ignored, other])
    await session.commit()

    response = await client.get(f"/api/transactions/{anchor.id}/similar", headers=auth_headers)
    assert response.status_code == 200, response.text
    assert response.json() == [
        {"id": str(same_month.id), "category_id": None, "date": "2026-11-05"},
        {"id": str(older.id), "category_id": str(food), "date": "2026-03-05"},
    ]


@pytest.mark.asyncio
async def test_similar_matches_by_payee_when_the_row_has_one(
    client: AsyncClient, auth_headers, session: AsyncSession, test_user, test_account
):
    payee = Payee(id=uuid.uuid4(), user_id=test_user.id, name="Mercado Bom")
    session.add(payee)
    await session.flush()
    anchor = _tx(test_user, test_account, "MERCADO BOM 123", payee_id=payee.id)
    sibling = _tx(test_user, test_account, "MERCADO BOM 456", payee_id=payee.id)
    lookalike = _tx(test_user, test_account, "MERCADO BOM 123")
    session.add_all([anchor, sibling, lookalike])
    await session.commit()

    response = await client.get(f"/api/transactions/{anchor.id}/similar", headers=auth_headers)
    assert [item["id"] for item in response.json()] == [str(sibling.id)]

    missing = await client.get(f"/api/transactions/{uuid.uuid4()}/similar", headers=auth_headers)
    assert missing.status_code == 404
