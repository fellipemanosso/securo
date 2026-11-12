"""Authenticated Pluggy notifications.

Notifications are deliberately treated only as a signal. The worker reads
the current provider state instead of trusting mutable financial data in the
public request body.
"""

import hashlib
import hmac
import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.database import get_async_session
from app.core.redis import get_redis
from app.models.bank_connection import BankConnection
from app.services.admin_service import get_pluggy_credentials
from app.worker import celery_app

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/webhooks/pluggy", tags=["webhooks"])


def pluggy_webhook_secret() -> str:
    key = get_settings().secret_key.get_secret_value().encode()
    return hmac.new(key, b"securo:pluggy-webhook:v1", hashlib.sha256).hexdigest()


@router.post("", status_code=status.HTTP_202_ACCEPTED)
async def receive_pluggy_webhook(
    request: Request,
    x_securo_webhook_secret: str | None = Header(default=None),
    session: AsyncSession = Depends(get_async_session),
):
    expected = pluggy_webhook_secret()
    if not x_securo_webhook_secret or not hmac.compare_digest(
        x_securo_webhook_secret, expected
    ):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)

    payload = await request.json()
    client_id, _client_secret, _source = await get_pluggy_credentials(session)
    if not client_id or payload.get("clientId") != client_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)

    event = str(payload.get("event") or "")
    if not (event.startswith("transactions/") or event in {"item/updated", "item/created"}):
        return {"accepted": False}

    event_id = str(payload.get("eventId") or payload.get("id") or "")
    if event_id:
        try:
            redis = await get_redis()
            fresh = await redis.set(
                f"pluggy:webhook:{event_id}", "1", nx=True, ex=7 * 24 * 60 * 60
            )
            if not fresh:
                return {"accepted": True, "duplicate": True}
        except Exception:
            # Redis availability must not turn a valid provider notification
            # into a retry storm. Connection row locking still serializes sync.
            logger.warning("Could not deduplicate Pluggy webhook %s", event_id, exc_info=True)

    item_id = payload.get("itemId")
    if not item_id:
        return {"accepted": False}

    connection = await session.scalar(
        select(BankConnection).where(
            BankConnection.provider == "pluggy",
            BankConnection.external_id == str(item_id),
        )
    )
    if connection is None:
        return {"accepted": False}

    celery_app.send_task(
        "app.tasks.sync_tasks.sync_single_connection",
        args=[str(connection.id), str(connection.user_id)],
    )
    return {"accepted": True}
