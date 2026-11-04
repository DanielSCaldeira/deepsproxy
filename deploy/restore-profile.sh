#!/bin/sh
# Restore one profile into a NEW volume, with gateway/Caddy stopped.
set -eu
archive=${1:?Usage: restore-profile.sh /absolute/path/dsp_profile_UUID.tar.gz}
filename=$(basename "$archive")
volume=${filename%.tar.gz}
owner=${volume#dsp_profile_}
printf '%s' "$owner" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' || { printf '%s\n' 'Invalid profile filename' >&2; exit 1; }
[ "$filename" = "dsp_profile_$owner.tar.gz" ] || exit 1
[ -f "$archive" ] || exit 1
if docker volume inspect "$volume" >/dev/null 2>&1; then
  printf '%s\n' 'Target volume already exists; restore into an empty installation.' >&2
  exit 1
fi
docker volume create --label dsp.managed=worker --label "dsp.owner=$owner" "$volume" >/dev/null
docker run --rm -i --network none --read-only --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --entrypoint tar \
  -v "$volume:/destination" deepsproxy-worker:local -xzf - -C /destination < "$archive"
