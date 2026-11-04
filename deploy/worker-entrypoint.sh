#!/bin/sh
set -eu
mkdir -p /profile /home/node
chown 1000:1000 /profile /home/node
# The provisioner guarantees one container per profile. PIDs from an earlier
# container cannot identify a live owner in this new PID namespace.
rm -f /profile/.runtime.lock /profile/SingletonLock /profile/SingletonCookie /profile/SingletonSocket
exec gosu node /bin/sh /app/deploy/worker-session.sh
