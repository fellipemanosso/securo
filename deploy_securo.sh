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
  docker service update --force --image "$BACKEND_IMAGE" "$svc"
done

echo "[4/5] Atualizando frontend..."
docker service update --force --image "$FRONTEND_IMAGE" "$FRONTEND_SERVICE"

echo "[5/5] Verificando tarefas ativas..."
for svc in "${BACKEND_SERVICES[@]}" "$FRONTEND_SERVICE"; do
  docker service ps "$svc" --filter desired-state=running
done
docker image prune -f
