#!/bin/bash
# Roda NO SERVIDOR (Swarm). Constrói as imagens aqui, a partir do main no
# GitHub, e atualiza os serviços da stack "securo".
#
# Fluxo completo a cada atualização:
#   (local)    git push origin main
#   (servidor) /root/deploy_securo.sh
#
# O script se atualiza sozinho: se a versão no main for diferente desta, ela
# substitui este arquivo e roda no lugar dele.
set -euo pipefail

STACK=${STACK:-securo}
BACKEND_SERVICES=("${STACK}_backend" "${STACK}_celery-worker" "${STACK}_celery-beat")
FRONTEND_SERVICE="${STACK}_frontend"
SRC_DIR=${SRC_DIR:-/root/securo-src}

echo "[1/5] Construindo imagens a partir do main..."
if [ -d "$SRC_DIR/.git" ]; then
  git -C "$SRC_DIR" fetch --depth 1 origin main
  git -C "$SRC_DIR" reset --hard FETCH_HEAD
else
  git clone --depth 1 https://github.com/fellipemanosso/securo.git "$SRC_DIR"
fi
DEPLOY_COMMIT=$(git -C "$SRC_DIR" log -1 --format='%h %s')

SELF=$(readlink -f "$0")
if [ "${DEPLOY_SELF_UPDATED:-0}" != "1" ] && ! cmp -s "$SRC_DIR/deploy_securo.sh" "$SELF"; then
  echo "Script de deploy mudou no main; atualizando $SELF e reiniciando..."
  install -m 0755 "$SRC_DIR/deploy_securo.sh" "$SELF"
  DEPLOY_SELF_UPDATED=1 exec "$SELF" "$@"
fi

echo "main em $DEPLOY_COMMIT"
# Images are tagged per commit under the `localhost/` registry. A Swarm task
# pulls its image before starting even with --no-resolve-image; a tag that
# also exists on a real registry (the old ghcr.io/...:latest) would be pulled
# over the image built here. Nothing answers on localhost, so the pull fails
# fast and the task runs the local image.
SHA=$(git -C "$SRC_DIR" rev-parse --short HEAD)
BACKEND_IMAGE=localhost/securo-backend:$SHA
FRONTEND_IMAGE=localhost/securo-frontend:$SHA
docker build -t "$BACKEND_IMAGE" -f "$SRC_DIR/backend/Dockerfile" "$SRC_DIR/backend"
docker build -t "$FRONTEND_IMAGE" \
  --build-arg VITE_APP_VERSION="main-$SHA" \
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

# Fail loudly when a running container is not the image built above.
check_running_image() {
  local svc=$1 image=$2 want got
  want=$(docker image inspect --format '{{.Id}}' "$image")
  for _ in $(seq 1 30); do
    got=$(docker ps --filter "label=com.docker.swarm.service.name=$svc" --format '{{.ID}}' \
      | head -n1 | xargs -r docker inspect --format '{{.Image}}')
    [ "$got" = "$want" ] && return 0
    sleep 2
  done
  echo "ERRO: $svc não está rodando a imagem $image (rodando: ${got:-nenhuma})" >&2
  return 1
}
check_running_image "${STACK}_backend" "$BACKEND_IMAGE"
check_running_image "$FRONTEND_SERVICE" "$FRONTEND_IMAGE"

# Keep only this commit's images; ones still held by stopped task containers
# stay until Swarm drops those tasks.
docker images --format '{{.Repository}}:{{.Tag}}' \
  | grep -E '^localhost/securo-(backend|frontend):' \
  | grep -v ":$SHA\$" \
  | xargs -r docker rmi >/dev/null 2>&1 || true
docker image prune -f

echo
echo "Publicado: $DEPLOY_COMMIT"
echo "No navegador, recarregue com Ctrl+Shift+R (no celular, feche e abra o app)."
