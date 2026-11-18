"""Investment class and valuation date on the assets list (Investimentos page)."""

import uuid
from datetime import date, datetime, timezone
from decimal import Decimal

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.asset import Asset
from app.models.asset_value import AssetValue
from app.models.user import User
from app.models.workspace import Workspace
from app.services.investment_class import investment_class_of


@pytest.mark.parametrize(
    ("asset_type", "ticker", "metadata", "expected"),
    [
        # Not investments: they stay on Patrimônio only.
        ("real_estate", None, None, None),
        ("vehicle", None, None, None),
        ("valuable", None, None, None),
        ("other", None, None, None),
        # The user's own type wins, even over a provider payload.
        ("stock", "PETR4.SA", None, "stocks"),
        ("etf", "BOVA11.SA", None, "etfs"),
        ("fund", None, None, "funds"),
        ("crypto", "BTC-USD", None, "crypto"),
        ("crypto", None, {"type": "FIXED_INCOME"}, "crypto"),
        # Manual Tesouro Direto bonds.
        ("investment", "TD:ABCD1234", None, "fixed_income"),
        # Pluggy holdings, all stored as type="investment".
        ("investment", None, {"type": "FIXED_INCOME", "subtype": "CDB"}, "fixed_income"),
        ("investment", None, {"type": "FIXED_INCOME", "subtype": "TREASURY"}, "fixed_income"),
        ("investment", None, {"type": "EQUITY", "subtype": "STOCK"}, "stocks"),
        ("investment", None, {"type": "EQUITY", "subtype": "BDR"}, "stocks"),
        ("investment", None, {"type": "EQUITY", "subtype": "REAL_ESTATE_FUND"}, "real_estate_funds"),
        ("investment", None, {"type": "ETF", "subtype": "ETF"}, "etfs"),
        ("investment", None, {"type": "MUTUAL_FUND", "subtype": "ETF_FUND"}, "etfs"),
        ("investment", None, {"type": "MUTUAL_FUND", "subtype": "MULTIMARKET_FUND"}, "funds"),
        ("investment", None, {"type": "SECURITY", "subtype": "VGBL"}, "pension"),
        ("investment", None, {"type": "COE", "subtype": "STRUCTURED_NOTE"}, "structured"),
        ("investment", None, {"type": "fixed_income"}, "fixed_income"),
        # Nothing to go on (SimpleFIN, unknown Pluggy type, plain manual entry).
        ("investment", None, {"symbol": "VTI", "cost_basis": "100"}, "other"),
        ("investment", None, {"type": "OTHER"}, "other"),
        ("investment", None, None, "other"),
    ],
)
def test_investment_class_of(asset_type, ticker, metadata, expected):
    assert investment_class_of(asset_type, ticker, metadata) == expected


@pytest.mark.asyncio
async def test_assets_list_reports_class_and_value_date(
    client: AsyncClient,
    auth_headers: dict,
    session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
):
    def asset(name: str, **fields) -> Asset:
        row = Asset(
            id=uuid.uuid4(),
            user_id=test_user.id,
            workspace_id=test_workspace.id,
            name=name,
            currency="BRL",
            position=0,
            **fields,
        )
        session.add(row)
        return row

    synced_cdb = asset(
        "CDB Banco X",
        type="investment",
        valuation_method="manual",
        source="pluggy",
        external_id="pluggy-cdb",
        purchase_price=Decimal("1000"),
        external_metadata={"type": "FIXED_INCOME", "subtype": "CDB"},
    )
    priced_stock = asset(
        "Petrobras",
        type="stock",
        valuation_method="market_price",
        ticker="PETR4.SA",
        units=Decimal("10"),
        last_price=Decimal("38.50"),
        last_price_at=datetime(2026, 11, 17, 21, 0, tzinfo=timezone.utc),
    )
    at_cost = asset(
        "Fundo sem cotação",
        type="fund",
        valuation_method="manual",
        purchase_price=Decimal("500"),
    )
    house = asset(
        "Casa",
        type="real_estate",
        valuation_method="manual",
        purchase_price=Decimal("300000"),
    )
    await session.flush()
    session.add_all([
        AssetValue(id=uuid.uuid4(), asset_id=synced_cdb.id, amount=Decimal("1010"), date=date(2026, 11, 10), source="sync"),
        AssetValue(id=uuid.uuid4(), asset_id=synced_cdb.id, amount=Decimal("1020"), date=date(2026, 11, 16), source="sync"),
        AssetValue(id=uuid.uuid4(), asset_id=priced_stock.id, amount=Decimal("370"), date=date(2026, 11, 1), source="market"),
    ])
    await session.commit()

    headers = {**auth_headers, "X-Workspace-Id": str(test_workspace.id)}
    response = await client.get("/api/assets", headers=headers)
    assert response.status_code == 200
    by_id = {row["id"]: row for row in response.json()}

    cdb = by_id[str(synced_cdb.id)]
    assert cdb["investment_class"] == "fixed_income"
    assert cdb["value_as_of"] == "2026-11-16"
    assert cdb["current_value"] == 1020.0

    stock = by_id[str(priced_stock.id)]
    assert stock["investment_class"] == "stocks"
    # Valued at the live quote, so the quote's date, not the older history row.
    assert stock["value_as_of"] == "2026-11-17"
    assert stock["current_value"] == pytest.approx(385.0)

    fund = by_id[str(at_cost.id)]
    assert fund["investment_class"] == "funds"
    assert fund["value_as_of"] is None
    assert fund["current_value"] == 500.0

    home = by_id[str(house.id)]
    assert home["investment_class"] is None
