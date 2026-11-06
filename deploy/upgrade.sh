#!/bin/sh
# Run from the repository root after pulling/building the desired images.
# On failure keep maintenance in place; restore the backup before rolling back.
set -eu
compose() { docker compose --env-file .env.production -f compose.production.yml "$@"; }
compose stop -t 180 caddy gateway
PROXY_IA_BACKUP_NO_RESTART=1 sh deploy/backup.sh
# Workers are created dynamically and are not replaced by `compose up`.
for container in $(docker ps -aq --filter label=dsp.managed=worker); do
  docker stop --time 30 "$container" >/dev/null
  docker rm "$container" >/dev/null
done
for network in $(docker network ls -q --filter label=dsp.managed=worker); do
  for container in dsp_gateway dsp_egress; do
    docker network disconnect -f "$network" "$container" >/dev/null 2>&1 || true
  done
  docker network rm "$network" >/dev/null
done
# Profiles remain in their original volumes; the gateway migrates the database.
compose up -d --remove-orphans
