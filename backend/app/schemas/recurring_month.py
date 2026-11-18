import uuid
from datetime import date
from typing import Literal, Optional

from pydantic import BaseModel

RecurringOccurrenceStatus = Literal["paid", "pending", "overdue"]


class RecurringMonthOccurrence(BaseModel):
    """One expected occurrence of a recurring commitment in a month.

    ``date`` is the scheduled date while the occurrence is still open, and
    the linked transaction's date once one exists. ``paid_amount`` is set
    only for a paid occurrence: what actually left (or entered) the account.
    """

    recurring_id: uuid.UUID
    description: str
    account_id: Optional[uuid.UUID] = None
    category_id: Optional[uuid.UUID] = None
    category_name: Optional[str] = None
    category_icon: Optional[str] = None
    category_color: Optional[str] = None
    type: Literal["debit", "credit"]
    frequency: str
    currency: str
    date: date
    expected_amount: float
    # Converted at the latest real rate; null when no rate is known.
    expected_amount_primary: Optional[float] = None
    status: RecurringOccurrenceStatus
    transaction_id: Optional[uuid.UUID] = None
    paid_amount: Optional[float] = None
    paid_amount_primary: Optional[float] = None
