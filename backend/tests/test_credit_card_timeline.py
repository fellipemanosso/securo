from datetime import date
from decimal import Decimal

import pytest

from app.models.account import Account
from app.models.account_card import AccountCard
from app.models.credit_card_bill import CreditCardBill
from app.models.transaction import Transaction
from app.services.credit_card_timeline import CreditCardTimeline


@pytest.mark.asyncio
async def test_bank_statement_is_the_canonical_item_for_a_cycle(
    session, test_user, test_workspace
):
    card = Account(
        user_id=test_user.id,
        workspace_id=test_workspace.id,
        name="Principal",
        type="credit_card",
        currency="BRL",
        balance=Decimal("0"),
        statement_close_day=10,
        payment_due_day=17,
    )
    session.add(card)
    await session.flush()

    manual = CreditCardBill(
        user_id=test_user.id,
        workspace_id=test_workspace.id,
        account_id=card.id,
        external_id="manual:test",
        due_date=date(2026, 5, 17),
        closing_date=date(2026, 5, 10),
        total_amount=Decimal("80"),
        currency="BRL",
        raw_data={"securo_manual": True},
    )
    bank = CreditCardBill(
        user_id=test_user.id,
        workspace_id=test_workspace.id,
        account_id=card.id,
        external_id="bank:test",
        due_date=date(2026, 5, 17),
        closing_date=date(2026, 5, 10),
        total_amount=Decimal("100"),
        currency="BRL",
    )
    session.add_all([manual, bank])
    await session.commit()

    timelines = await CreditCardTimeline.index(
        session,
        test_workspace.id,
        [card.id],
        due_from=date(2026, 5, 1),
        due_to=date(2026, 5, 31),
        as_of=date(2026, 5, 1),
    )

    item = timelines[card.id].items[0]
    assert item.kind == "statement"
    assert item.source == "bank"
    assert item.record_id == bank.id
    assert item.amount == Decimal("100")
    assert item.cycle_key == f"bill:{bank.id}"


@pytest.mark.asyncio
async def test_bank_statement_leaves_out_hidden_card_charges(
    session, test_user, test_workspace
):
    card = Account(
        user_id=test_user.id,
        workspace_id=test_workspace.id,
        name="Principal",
        type="credit_card",
        currency="BRL",
        balance=Decimal("0"),
        statement_close_day=10,
        payment_due_day=17,
    )
    session.add(card)
    await session.flush()
    bill = CreditCardBill(
        user_id=test_user.id,
        workspace_id=test_workspace.id,
        account_id=card.id,
        external_id="bank:hidden",
        due_date=date(2026, 5, 17),
        closing_date=date(2026, 5, 10),
        total_amount=Decimal("1000.00"),
        currency="BRL",
    )
    session.add(bill)
    await session.flush()
    hidden_card = AccountCard(
        workspace_id=test_workspace.id, account_id=card.id, last4="9999", is_hidden=True
    )

    def charge(last4, amount, kind="debit"):
        return Transaction(
            user_id=test_user.id,
            account_id=card.id,
            description=f"{last4} {amount}",
            amount=Decimal(amount),
            currency="BRL",
            date=date(2026, 5, 2),
            type=kind,
            source="sync",
            card_last4=last4,
            bill_id=bill.id,
        )

    session.add_all([
        hidden_card,
        charge("1111", "800.00"),
        charge("9999", "250.00"),
        # A refund on the hidden card nets against its charges.
        charge("9999", "50.00", "credit"),
    ])
    await session.commit()

    async def statement_amount():
        timelines = await CreditCardTimeline.index(
            session,
            test_workspace.id,
            [card.id],
            due_from=date(2026, 5, 1),
            due_to=date(2026, 5, 31),
            as_of=date(2026, 5, 1),
        )
        return timelines[card.id].items[0].amount

    assert await statement_amount() == Decimal("800.00")
    # Only the display changes: payments and status keep the bank's figure.
    await session.refresh(bill)
    assert bill.total_amount == Decimal("1000.00")

    hidden_card.is_hidden = False
    await session.commit()
    assert await statement_amount() == Decimal("1000.00")


@pytest.mark.asyncio
async def test_timeline_interface_returns_one_canonical_item_per_card(
    client, auth_headers, session, test_user, test_workspace
):
    card = Account(
        user_id=test_user.id,
        workspace_id=test_workspace.id,
        name="Travel",
        type="credit_card",
        currency="BRL",
        balance=Decimal("0"),
        statement_close_day=10,
        payment_due_day=17,
    )
    session.add(card)
    await session.flush()
    bill = CreditCardBill(
        user_id=test_user.id,
        workspace_id=test_workspace.id,
        account_id=card.id,
        external_id="bank:travel",
        due_date=date(2026, 5, 17),
        closing_date=date(2026, 5, 10),
        total_amount=Decimal("123.45"),
        currency="BRL",
    )
    session.add(bill)
    await session.commit()

    response = await client.get(
        "/api/accounts/credit-card-timeline",
        params={
            "account_ids": str(card.id),
            "from": "2026-05-01",
            "to": "2026-05-31",
            "as_of": "2026-05-01",
        },
        headers=auth_headers,
    )

    assert response.status_code == 200
    body = response.json()
    assert body[0]["account_id"] == str(card.id)
    assert body[0]["items"] == [
        {
            "account_id": str(card.id),
            "due_month": "2026-05",
            "kind": "statement",
            "cycle_key": f"bill:{bill.id}",
            "start": "2026-04-10",
            "end": "2026-05-09",
            "closing_date": "2026-05-10",
            "due_date": "2026-05-17",
            "amount": 123.45,
            "primary_amount": None,
            "source": "bank",
            "record_id": str(bill.id),
            "status": "open",
            "editable": False,
            "unavailable_reason": None,
        }
    ]
