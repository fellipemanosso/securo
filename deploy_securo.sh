#!/bin/bash
# Roda NO SERVIDOR (Swarm). As imagens são construídas no GitHub Actions
# (release.yml) e publicadas em ghcr.io/fellipemanosso; aqui só puxamos e
# atualizamos os serviços da stack "securo".
#
# Fluxo completo a cada atualização:
#   (local)    git push origin main && gh workflow run release.yml --ref main
#   (servidor) ./deploy_securo.sh
set -euo pipefail

STACK=${STACK:-securo}
REGISTRY=ghcr.io/fellipemanosso
BACKEND_IMAGE=$REGISTRY/securo-backend:latest
FRONTEND_IMAGE=$REGISTRY/securo-frontend:latest
BACKEND_SERVICES=("${STACK}_backend" "${STACK}_celery-worker" "${STACK}_celery-beat")
FRONTEND_SERVICE="${STACK}_frontend"

echo "[1/5] Baixando imagens..."
docker pull "$BACKEND_IMAGE"
docker pull "$FRONTEND_IMAGE"

echo "[2/5] Atualizando backend e workers..."
for svc in "${BACKEND_SERVICES[@]}"; do
  docker service update --force --image "$BACKEND_IMAGE" "$svc"
done

echo "[3/5] Aplicando migrations (alembic upgrade head)..."
CID=$(docker ps -q -f "name=${STACK}_backend\." | head -n1)
[ -n "$CID" ] || { echo "container do backend não encontrado" >&2; exit 1; }
docker exec "$CID" alembic upgrade head

echo "[4/5] Atualizando frontend..."
docker service update --force --image "$FRONTEND_IMAGE" "$FRONTEND_SERVICE"

echo "[5/5] Verificando tarefas ativas..."
for svc in "${BACKEND_SERVICES[@]}" "$FRONTEND_SERVICE"; do
  docker service ps "$svc" --filter desired-state=running
done
docker image prune -f
