#!/bin/bash
# Roda NO SERVIDOR (Swarm), no mesmo estilo do deploy do hotmanager.
# Ajuste as variáveis conforme os nomes dos serviços da stack no Portainer.
set -euo pipefail

REPO_DIR=${REPO_DIR:-/root/securo}
STACK=${STACK:-securo}
BACKEND_IMAGE=securo-backend
FRONTEND_IMAGE=securo-frontend
# Serviços que usam a imagem do backend (a ordem importa: backend primeiro).
BACKEND_SERVICES=("${STACK}_backend" "${STACK}_celery-worker" "${STACK}_celery-beat")
FRONTEND_SERVICE="${STACK}_frontend"
KEEP_IMAGES=3

cd "$REPO_DIR"

echo "[1/6] Sincronizando código com origin/main..."
git fetch origin main
git reset --hard origin/main
SHA=$(git rev-parse --short=12 HEAD)

echo "[2/6] Buildando imagens ($SHA)..."
docker build --pull -t "$BACKEND_IMAGE:$SHA" -t "$BACKEND_IMAGE:latest" ./backend
docker build --pull --build-arg VITE_APP_VERSION="$SHA" \
  -t "$FRONTEND_IMAGE:$SHA" -t "$FRONTEND_IMAGE:latest" ./frontend

echo "[3/6] Atualizando backend e workers..."
for svc in "${BACKEND_SERVICES[@]}"; do
  docker service update --image "$BACKEND_IMAGE:$SHA" "$svc"
done

echo "[4/6] Aplicando migrations (alembic upgrade head)..."
CID=$(docker ps -q -f "name=${STACK}_backend\." | head -n1)
[ -n "$CID" ] || { echo "container do backend não encontrado" >&2; exit 1; }
docker exec "$CID" alembic upgrade head

echo "[5/6] Atualizando frontend..."
docker service update --image "$FRONTEND_IMAGE:$SHA" "$FRONTEND_SERVICE"
for svc in "${BACKEND_SERVICES[@]}" "$FRONTEND_SERVICE"; do
  docker service ps "$svc" --filter desired-state=running
done

echo "[6/6] Limpando..."
for img in "$BACKEND_IMAGE" "$FRONTEND_IMAGE"; do
  docker images "$img" --format '{{.Repository}}:{{.Tag}}' \
    | grep -v ':latest$' \
    | tail -n +$((KEEP_IMAGES + 1)) \
    | xargs -r -n1 docker rmi || true
done
docker image prune -f
docker builder prune -f --keep-storage 10GB
docker system df
