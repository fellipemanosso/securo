import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.api.pluggy_webhooks import pluggy_webhook_secret
from app.models.bank_connection import BankConnection


@pytest.mark.asyncio
async def test_pluggy_webhook_rejects_missing_secret(client):
    response = await client.post("/api/webhooks/pluggy", json={"event": "item/updated"})
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_pluggy_webhook_dispatches_matching_connection(
    client, session, test_user, test_workspace
):
    connection = BankConnection(
        id=uuid.uuid4(),
        user_id=test_user.id,
        workspace_id=test_workspace.id,
        provider="pluggy",
        external_id="item-123",
        institution_name="Banco Teste",
        status="active",
    )
    session.add(connection)
    await session.commit()

    fake_redis = AsyncMock()
    fake_redis.set.return_value = True
    with patch(
        "app.api.pluggy_webhooks.get_pluggy_credentials",
        new=AsyncMock(return_value=("client-123", "secret", "database")),
    ), patch(
        "app.api.pluggy_webhooks.get_redis", new=AsyncMock(return_value=fake_redis)
    ), patch("app.api.pluggy_webhooks.celery_app.send_task") as send_task:
        response = await client.post(
            "/api/webhooks/pluggy",
            headers={"X-Securo-Webhook-Secret": pluggy_webhook_secret()},
            json={
                "event": "transactions/updated",
                "eventId": "event-1",
                "itemId": "item-123",
                "clientId": "client-123",
            },
        )

    assert response.status_code == 202
    assert response.json() == {"accepted": True}
    send_task.assert_called_once_with(
        "app.tasks.sync_tasks.sync_single_connection",
        args=[str(connection.id), str(test_user.id)],
    )


@pytest.mark.asyncio
async def test_ensure_webhook_updates_existing_registration():
    provider = __import__("app.providers.pluggy", fromlist=["PluggyProvider"]).PluggyProvider()
    list_response = MagicMock()
    list_response.json.return_value = {
        "results": [{"id": "hook-1", "url": "https://securo.test/api/webhooks/pluggy", "event": "all"}]
    }
    update_response = MagicMock()
    client = MagicMock()
    client.get = AsyncMock(return_value=list_response)
    client.patch = AsyncMock(return_value=update_response)
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=None)

    with patch.object(provider, "_headers", new=AsyncMock(return_value={"X-API-KEY": "k"})), patch(
        "app.providers.pluggy.httpx.AsyncClient", return_value=client
    ):
        await provider.ensure_webhook("https://securo.test/api/webhooks/pluggy", "signed-secret")

    update_response.raise_for_status.assert_called_once()
    assert client.patch.await_args.kwargs["json"]["headers"] == {
        "X-Securo-Webhook-Secret": "signed-secret"
    }
