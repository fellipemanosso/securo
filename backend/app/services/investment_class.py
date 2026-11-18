"""Investment class of an asset, for the Investimentos page.

Synced holdings are all stored with ``type="investment"``; what they really
are (CDB, FII, previdência…) only lives in the provider payload kept on
``Asset.external_metadata``. This module turns that, the user's own type
choice and the Tesouro Direto ticker into one small, provider-neutral
vocabulary so the frontend never has to read provider fields.
"""

from typing import Any, Literal, Optional

InvestmentClass = Literal[
    "fixed_income",
    "stocks",
    "real_estate_funds",
    "etfs",
    "funds",
    "pension",
    "structured",
    "crypto",
    "other",
]

# Asset types that are investments. Real estate, vehicles, valuables and
# "other" stay on Patrimônio only.
INVESTMENT_ASSET_TYPES = frozenset({"investment", "stock", "etf", "fund", "crypto"})

# A specific type picked by the user (or set at creation from the market
# quote) is the user's own classification and wins over anything else.
_TYPE_CLASS: dict[str, InvestmentClass] = {
    "stock": "stocks",
    "etf": "etfs",
    "fund": "funds",
    "crypto": "crypto",
}

# Pluggy /investments `type` and `subtype` (docs.pluggy.ai/docs/investments).
# The subtype is checked first: FIIs and ETF-shaped funds are filed by Pluggy
# under EQUITY and MUTUAL_FUND, but Brazilian investors read them apart.
_PROVIDER_SUBTYPE_CLASS: dict[str, InvestmentClass] = {
    "REAL_ESTATE_FUND": "real_estate_funds",
    "ETF_FUND": "etfs",
}
_PROVIDER_TYPE_CLASS: dict[str, InvestmentClass] = {
    "FIXED_INCOME": "fixed_income",
    "EQUITY": "stocks",
    "ETF": "etfs",
    "MUTUAL_FUND": "funds",
    "SECURITY": "pension",
    "COE": "structured",
}

# Manual Tesouro Direto bonds carry an internal `TD:` market symbol.
_TESOURO_TICKER_PREFIX = "TD:"


def investment_class_of(
    asset_type: str,
    ticker: Optional[str],
    metadata: Optional[dict[str, Any]],
) -> Optional[InvestmentClass]:
    """Class of an investment asset, or None when the asset is not one."""
    if asset_type not in INVESTMENT_ASSET_TYPES:
        return None
    if asset_type in _TYPE_CLASS:
        return _TYPE_CLASS[asset_type]
    if ticker and ticker.startswith(_TESOURO_TICKER_PREFIX):
        return "fixed_income"
    if metadata:
        subtype = str(metadata.get("subtype") or "").upper()
        if subtype in _PROVIDER_SUBTYPE_CLASS:
            return _PROVIDER_SUBTYPE_CLASS[subtype]
        provider_type = str(metadata.get("type") or "").upper()
        if provider_type in _PROVIDER_TYPE_CLASS:
            return _PROVIDER_TYPE_CLASS[provider_type]
    return "other"
