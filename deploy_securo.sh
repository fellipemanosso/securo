#!/bin/bash
# Roda NO SERVIDOR (Swarm). Constrói as imagens aqui, a partir do main no
# GitHub, e atualiza os serviços da stack "securo".
#
# Fluxo completo a cada atualização:
#   (local)    git push origin main
#   (servidor) ./deploy_securo.sh
set -euo pipefail

STACK=${STACK:-securo}
# The stack's services reference these registry tags; the images built here
# reuse them so the stack definition needs no change.
REGISTRY=ghcr.io/fellipemanosso
BACKEND_IMAGE=$REGISTRY/securo-backend:latest
FRONTEND_IMAGE=$REGISTRY/securo-frontend:latest
BACKEND_SERVICES=("${STACK}_backend" "${STACK}_celery-worker" "${STACK}_celery-beat")
FRONTEND_SERVICE="${STACK}_frontend"
SRC_DIR=${SRC_DIR:-/root/securo-src}
# Services and the migration job use --no-resolve-image: a locally built tag
# must not be resolved against the registry, or Swarm would run whatever older
# image is published there under the same tag.

echo "[1/5] Construindo imagens a partir do main..."
if [ -d "$SRC_DIR/.git" ]; then
  git -C "$SRC_DIR" fetch --depth 1 origin main
  git -C "$SRC_DIR" reset --hard FETCH_HEAD
else
  git clone --depth 1 https://github.com/fellipemanosso/securo.git "$SRC_DIR"
fi
echo "main em $(git -C "$SRC_DIR" log -1 --format='%h %s')"
docker build -t "$BACKEND_IMAGE" -f "$SRC_DIR/backend/Dockerfile" "$SRC_DIR/backend"
docker build -t "$FRONTEND_IMAGE" \
  --build-arg VITE_APP_VERSION="main-$(git -C "$SRC_DIR" rev-parse --short HEAD)" \
  -f "$SRC_DIR/frontend/Dockerfile" "$SRC_DIR/frontend"

echo "[2/5] Aplicando migrations antes dos serviços protegidos pelo schema head..."
mapfile -t BACKEND_ENV < <(
  docker service inspect "${STACK}_backend" \
    --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}'
)
mapfile -t BACKEND_NETWORKS < <(
  docker service inspect "${STACK}_backend" \
    --format '{{range .Spec.TaskTemplate.Networks}}{{println .Target}}{{end}}'
)

MIGRATION_ARGS=()
for value in "${BACKEND_ENV[@]}"; do
  [ -n "$value" ] && MIGRATION_ARGS+=(--env "$value")
done
for network in "${BACKEND_NETWORKS[@]}"; do
  [ -n "$network" ] && MIGRATION_ARGS+=(--network "$network")
done

MIGRATION_SERVICE="${STACK}_migrate_$(date +%s)"
cleanup_migration() {
  docker service rm "$MIGRATION_SERVICE" >/dev/null 2>&1 || true
}
trap cleanup_migration EXIT
docker service create \
  --no-resolve-image \
  --detach \
  --name "$MIGRATION_SERVICE" \
  --mode replicated-job \
  --replicas 1 \
  --restart-condition none \
  --entrypoint alembic \
  "${MIGRATION_ARGS[@]}" \
  "$BACKEND_IMAGE" \
  upgrade head >/dev/null

# `--detach=false` waits forever on a failed job, so poll the task state.
MIGRATION_STATE=""
for _ in $(seq 1 360); do
  MIGRATION_STATE=$(docker service ps "$MIGRATION_SERVICE" --format '{{.CurrentState}}' | head -n1)
  case "$MIGRATION_STATE" in
    Complete*|Failed*|Rejected*) break ;;
  esac
  sleep 5
done
docker service logs --raw "$MIGRATION_SERVICE" 2>&1 | tail -n 40
case "$MIGRATION_STATE" in
  Complete*) ;;
  *)
    echo "migration não concluiu (estado: ${MIGRATION_STATE:-desconhecido}); serviços não foram atualizados" >&2
    exit 1
    ;;
esac
cleanup_migration
trap - EXIT

echo "[3/5] Atualizando backend e workers..."
for svc in "${BACKEND_SERVICES[@]}"; do
  docker service update --force --no-resolve-image --image "$BACKEND_IMAGE" "$svc"
done

echo "[4/5] Atualizando frontend..."
docker service update --force --no-resolve-image --image "$FRONTEND_IMAGE" "$FRONTEND_SERVICE"

echo "[5/5] Verificando tarefas ativas..."
for svc in "${BACKEND_SERVICES[@]}" "$FRONTEND_SERVICE"; do
  docker service ps "$svc" --filter desired-state=running
done
docker image prune -f
