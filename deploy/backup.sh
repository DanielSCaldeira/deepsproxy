#!/bin/sh
# Run on the VPS from the repository root. Profiles are copied only while their
# browsers are stopped. Dynamic resources are managed by the provisioner.
set -eu
umask 077
destination="$(pwd)/backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$destination"
compose() { docker compose --env-file .env.production -f compose.production.yml "$@"; }
restart() { compose up -d gateway caddy >/dev/null; }
trap restart EXIT
compose stop caddy gateway
# With the gateway stopped, no new work is accepted. Stop only labeled workers.
for container in $(docker ps -q --filter label=dsp.managed=worker); do
  docker stop --time 30 "$container" >/dev/null
done
compose exec -T postgres pg_dump -U deepsproxy -d deepsproxy -Fc > "$destination/database.dump"
for volume in $(docker volume ls -q --filter label=dsp.managed=worker); do
  docker run --rm --user 1000:1000 --network none --read-only --cap-drop ALL --entrypoint tar \
    -v "$volume:/source:ro" deepsproxy-worker:local -czf - -C /source . > "$destination/$volume.tar.gz"
done
printf '%s\n' "$destination"
