import uuid
from datetime import date as _date, datetime, timezone
from decimal import Decimal
from typing import TYPE_CHECKING, Literal, Optional, cast

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, JSON, Numeric, SmallInteger, String, event
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.orm.base import instance_state

from app.core.database import Base

if TYPE_CHECKING:
    from app.models.account import Account
    from app.models.category import Category
    from app.models.credit_card_bill import CreditCardBill
    from app.models.import_log import ImportLog
    from app.models.payee import Payee
    from app.models.recurring_transaction import RecurringTransaction
    from app.models.transaction_attachment import TransactionAttachment
    from app.models.transaction_split import TransactionSplit
    from app.models.transaction_category_line import TransactionCategoryLine


class Transaction(Base):
    __tablename__ = "transactions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    account_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("accounts.id"), nullable=False)
    category_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("categories.id"), nullable=True)
    external_id: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)  # Provider's transaction ID
    description: Mapped[str] = mapped_column(String(500))
    original_description: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    description_is_rule_managed: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )
    amount: Mapped[Decimal] = mapped_column(Numeric(precision=15, scale=2))
    currency: Mapped[str] = mapped_column(String(3), default="USD")
    date: Mapped[_date] = mapped_column(Date)
    # Effective date for cash-flow reporting. For regular accounts this equals
    # `date`. For credit card transactions it's the due date of the bill that
    # the transaction belongs to — so accrual-mode aggregations count the
    # purchase when it hits the user's cash, not when it was made.
    effective_date: Mapped[_date] = mapped_column(Date, index=True)
    type: Mapped[str] = mapped_column(String(10))  # debit, credit
    source: Mapped[str] = mapped_column(String(20))  # sync, ofx, csv, manual
    status: Mapped[str] = mapped_column(String(10), default="posted")  # posted, pending
    payee: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    payee_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("payees.id", ondelete="SET NULL"), nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)
    raw_data: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    import_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("import_logs.id"), nullable=True)
    transfer_pair_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), nullable=True)
    # True on both legs of a cross-currency transfer whose destination amount
    # the user typed in, instead of letting it be converted at the market rate.
    # Both amounts are then observed facts, so editing one leg must not
    # re-derive the other from an FX rate.
    transfer_amount_explicit: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )
    amount_primary: Mapped[Optional[Decimal]] = mapped_column(Numeric(precision=15, scale=2), nullable=True)
    fx_rate_used: Mapped[Optional[Decimal]] = mapped_column(Numeric(precision=20, scale=10), nullable=True)
    # Installment (parcelamento) metadata. Populated from provider data when available.
    # `installment_number` is 1-indexed (e.g. 3 for "3/12"). Storing alongside the
    # raw tx row so the door stays open to a plan view or manual entry later
    # without another migration.
    installment_number: Mapped[Optional[int]] = mapped_column(SmallInteger, nullable=True)
    total_installments: Mapped[Optional[int]] = mapped_column(SmallInteger, nullable=True)
    installment_total_amount: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(precision=15, scale=2), nullable=True
    )
    installment_purchase_date: Mapped[Optional[_date]] = mapped_column(Date, nullable=True)
    # Last digits of the physical or virtual card a credit-card charge was made
    # with, when the provider reports it (Pluggy creditCardMetadata.cardNumber).
    card_last4: Mapped[Optional[str]] = mapped_column(String(8), nullable=True)
    # Stable identity for rows created by the manual installment-series
    # endpoint. Provider-synced installment rows leave this null because their
    # metadata is only a deduplication fingerprint, not a series identifier.
    installment_series_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), nullable=True, index=True
    )
    # Which bill (named by its due date) this credit-card tx is placed on,
    # ahead of cycle math. Null by default. `effective_bill_date_source` says
    # who placed it: "manual" (the user, issue #92) beats everything, including
    # Pluggy's billId; "provider" (the bank's billForecastDate for a charge not
    # billed yet) gives way to billId as soon as the bank bills the charge.
    effective_bill_date: Mapped[Optional[_date]] = mapped_column(Date, nullable=True)
    effective_bill_date_source: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    # FK to the bill this transaction belongs to (issue #92). Set during sync
    # for providers that expose a bills feed; null otherwise — in which case
    # the read path falls back to locally-computed cycle math via
    # apply_effective_date. ON DELETE SET NULL: if a bill row is removed
    # (re-sync, deletion), the transaction stays put and just unlinks.
    bill_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("credit_card_bills.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    # Ignore the row everywhere monetary totals are calculated, including the
    # account balance. The row remains stored and can still be shown in ledger
    # views unless the caller explicitly hides ignored transactions.
    is_ignored: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    # Keep the row in the ledger and current balance, but leave it out of P&L
    # reports. This differs from is_ignored, which also removes the row from
    # balance calculations. Balance adjustments use this distinction so the
    # reconciled balance stays exact without looking like income or spending.
    exclude_from_pnl: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )
    # True while the amount is split across several categories, kept in
    # `category_lines`. `category_id` is null for those rows, which every
    # other path reads as "uncategorized"; this flag is how rules, sync and
    # bulk edits tell the two apart without a subquery. Written only by
    # category_line_service.
    has_category_lines: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )
    # How the current category got there, for the categorization review:
    # "rule" (with the rule in `category_rule_id`), "provider" (the bank's own
    # category, through the sync), "import" (the file or the import preview),
    # "recurring" (the recurring bill the row was generated from), "manual"
    # (the user picked it) or "suggestion" (the user accepted the category the
    # review suggested). Null means not recorded: rows categorized before the
    # column existed, or by a path that does not say. Written through
    # `stamp_category_source`; the flush listeners below clear it whenever the
    # category changes without saying how, so it never describes an old one.
    category_source: Mapped[Optional[str]] = mapped_column(String(12), nullable=True)
    category_rule_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("rules.id", ondelete="SET NULL"), nullable=True
    )
    # Link to the recurring bill this transaction fulfills (issue #116). Set when
    # a synced/imported/manual charge is matched to a recurring bill, or stamped
    # onto the placeholder generate_pending materializes. ON DELETE SET NULL: if
    # the recurring bill is removed, the transaction stays put and just unlinks.
    recurring_transaction_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("recurring_transactions.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    account: Mapped["Account"] = relationship(back_populates="transactions")
    category: Mapped[Optional["Category"]] = relationship()
    bill: Mapped[Optional["CreditCardBill"]] = relationship()
    payee_entity: Mapped[Optional["Payee"]] = relationship(back_populates="transactions")
    recurring_transaction: Mapped[Optional["RecurringTransaction"]] = relationship(
        back_populates="transactions"
    )
    import_log: Mapped[Optional["ImportLog"]] = relationship(back_populates="transactions")
    attachments: Mapped[list["TransactionAttachment"]] = relationship(
        back_populates="transaction", cascade="all, delete-orphan"
    )
    splits: Mapped[list["TransactionSplit"]] = relationship(
        back_populates="transaction", cascade="all, delete-orphan"
    )
    # Loaded with every transaction: an unsplit row costs one empty IN query,
    # and any response that serializes a row needs its lines.
    category_lines: Mapped[list["TransactionCategoryLine"]] = relationship(
        back_populates="transaction",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="TransactionCategoryLine.position",
        lazy="selectin",
    )

    # Populated dynamically by the service (not DB columns).
    is_shared: bool = False
    viewer_share = cast(Optional[Decimal], None)
    group_id = cast(Optional[uuid.UUID], None)
    parent_owner_name = cast(Optional[str], None)
    attachment_count: int = 0
    payee_name = cast(Optional[str], None)
    running_balance = cast(Optional[float], None)
    running_balance_primary = cast(Optional[float], None)
    matched_amount = cast(Optional[Decimal], None)
    matched_amount_primary = cast(Optional[Decimal], None)


# Safety net: `effective_date` is NOT NULL. For non-CC transactions it always
# equals `date`, so if a call site (or test) forgets to set it, fall back
# silently. CC-aware service code still calls `apply_effective_date` explicitly
# so that cycle-based due dates are stored when the account has the metadata.
@event.listens_for(Transaction, "before_insert")
def _default_effective_date(mapper, connection, target):
    if target.effective_date is None:
        target.effective_date = target.date


@event.listens_for(Transaction, "before_update")
def _default_effective_date_on_update(mapper, connection, target):
    if target.effective_date is None:
        target.effective_date = target.date


CategorySource = Literal["rule", "provider", "import", "recurring", "manual", "suggestion"]

_STAMPED = "_category_source_stamped"


def _category_value(tx: Transaction) -> tuple:
    loaded = instance_state(tx).dict
    return (loaded.get("category_id"), bool(loaded.get("has_category_lines")))


def stamp_category_source(
    tx: Transaction, source: Optional[CategorySource], rule_id: Optional[uuid.UUID] = None
) -> None:
    """Record how `tx` got the category it holds now.

    Call it right after writing the category. Setting the column by hand is not
    enough on its own: when the new value equals the old one (a rule replacing
    another rule's category) SQLAlchemy sees no change, and the listener would
    take the category change as undeclared and clear it. The stamp names the
    category it was made for, so a later change that does not stamp again is
    still caught.
    """
    tx.category_source = source
    tx.category_rule_id = rule_id if source == "rule" else None
    setattr(tx, _STAMPED, _category_value(tx))


def copy_category_source(source: Transaction, target: Transaction) -> None:
    """Give `target` the provenance of the category it just took from `source`."""
    stamp_category_source(
        target,
        cast(Optional[CategorySource], source.category_source),
        source.category_rule_id,
    )


def _settle_category_source(target: Transaction, inserting: bool) -> None:
    state = instance_state(target)
    loaded = state.dict
    stamped_for = loaded.pop(_STAMPED, None)
    # Only read what is loaded: a lazy load here would fail under async.
    if "category_id" not in loaded:
        return
    if loaded["category_id"] is None and not loaded.get("has_category_lines"):
        target.category_source = None
        target.category_rule_id = None
        return
    if inserting or stamped_for == _category_value(target):
        return
    attrs = state.attrs
    changed = (
        attrs.category_id.history.has_changes()
        or attrs.has_category_lines.history.has_changes()
    )
    if changed and not attrs.category_source.history.has_changes():
        target.category_source = None
        target.category_rule_id = None


@event.listens_for(Transaction, "before_insert")
def _category_source_on_insert(mapper, connection, target):
    _settle_category_source(target, inserting=True)


@event.listens_for(Transaction, "before_update")
def _category_source_on_update(mapper, connection, target):
    _settle_category_source(target, inserting=False)
