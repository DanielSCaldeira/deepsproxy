#!/bin/sh
# Restore one profile into a NEW volume, with gateway/Caddy stopped.
set -eu
archive=${1:?Usage: restore-profile.sh /absolute/path/dsp_profile_UUID.tar.gz}
filename=$(basename "$archive")
volume=${filename%.tar.gz}
owner=${volume#dsp_profile_}
account=$owner
printf '%s' "$owner" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' || { printf '%s\n' 'Invalid profile filename' >&2; exit 1; }
[ "$filename" = "dsp_profile_$owner.tar.gz" ] || exit 1
[ -f "$archive" ] || exit 1
if docker volume inspect "$volume" >/dev/null 2>&1; then
  printf '%s\n' 'Target volume already exists; restore into an empty installation.' >&2
  exit 1
fi
provider=deepseek
manifest=${2:-$(dirname "$archive")/accounts.tsv}
if [ -f "$manifest" ]; then
  row=$(awk -F '\t' -v account="$account" '$1==account {print $2 " " $3 " " $4}' "$manifest")
  [ -n "$row" ] || { printf '%s\n' 'Account missing from backup manifest.' >&2; exit 1; }
  read -r owner provider expected_volume <<EOF
$row
EOF
  [ "$expected_volume" = "$volume" ] || exit 1
  printf '%s' "$owner" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' || exit 1
  case "$provider" in deepseek|qwen|chatgpt|claude|perplexity|cohere|ernie|gemini|copilot|kimi|mistral) ;; *) exit 1 ;; esac
fi
worker_image=$(docker compose --env-file .env.production -f compose.production.yml --profile images config --images | awk '/deepsproxy-worker:/ {print; exit}')
[ -n "$worker_image" ] || exit 1
docker volume create --label dsp.managed=worker --label "dsp.owner=$owner" --label "dsp.account=$account" --label "dsp.provider=$provider" "$volume" >/dev/null
docker run --rm -i --network none --read-only --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --entrypoint tar \
  -v "$volume:/destination" "$worker_image" -xzf - -C /destination < "$archive"
