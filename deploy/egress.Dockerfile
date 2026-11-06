FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends squid ca-certificates && rm -rf /var/lib/apt/lists/*
# Squid drops to the proxy user; allow that user to reopen the container logs.
CMD ["sh","-c","chown proxy:proxy /dev/stdout /dev/stderr && exec squid -N -f /etc/squid/squid.conf"]
