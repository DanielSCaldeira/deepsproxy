#!/bin/sh
# Run on the VPS from the repository root. Profiles are copied only while their
# browsers are stopped. Dynamic resources are managed by the provisioner.
set -eu
umask 077
destination="$(pwd)/backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$destination"
compose() { docker compose --env-file .env.production -f compose.production.yml "$@"; }
restart() { if [ "${PROXY_IA_BACKUP_NO_RESTART:-0}" != 1 ]; then compose up -d gateway caddy >/dev/null; fi; }
trap restart EXIT
compose stop -t 180 caddy gateway
# With the gateway stopped, no new work is accepted. Stop only labeled workers.
for container in $(docker ps -q --filter label=dsp.managed=worker); do
  docker stop --time 30 "$container" >/dev/null
done
compose exec -T postgres pg_dump -U deepsproxy -d deepsproxy -Fc > "$destination/database.dump"
compose exec -T postgres psql -U deepsproxy -d deepsproxy -At -F "$(printf '\t')" -c \
  "SELECT id,user_id,provider,'dsp_profile_' || id FROM provider_accounts ORDER BY id" > "$destination/accounts.tsv" 2>/dev/null || {
  # Older installations have one DeepSeek profile per user.
  compose exec -T postgres psql -U deepsproxy -d deepsproxy -At -F "$(printf '\t')" -c \
    "SELECT id,id,'deepseek','dsp_profile_' || id FROM users ORDER BY id" > "$destination/accounts.tsv"
}
worker_image=$(compose --profile images config --images | awk '/deepsproxy-worker:/ {print; exit}')
[ -n "$worker_image" ] || { printf '%s\n' 'Worker image was not found in Compose configuration.' >&2; exit 1; }
for volume in $(docker volume ls -q --filter label=dsp.managed=worker); do
  docker run --rm --user 1000:1000 --network none --read-only --cap-drop ALL --entrypoint tar \
    -v "$volume:/source:ro" "$worker_image" -czf - -C /source . > "$destination/$volume.tar.gz"
done
printf '%s\n' "$destination"
