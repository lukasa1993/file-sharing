#!/usr/bin/env bash
set -euo pipefail

base=$(mktemp -d)
name="fileserver-smoke-${BASHPID}"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf -- "$base"
}
trap cleanup EXIT
bun scripts/ops.ts init "$base/state" smoke-admin --container
origin=http://127.0.0.1:8080
docker run -d --name "$name" --read-only --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,nodev,nosuid,noexec --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$base/state/config,dst=/etc/fileserver,readonly" \
  --mount "type=bind,src=$base/state/data,dst=/var/lib/fileserver" \
  --mount "type=bind,src=$base/state/storage,dst=/srv/files" \
  -e PUBLIC_ORIGIN="$origin" fileserver:check >/dev/null

ready() {
  for attempt in {1..35}; do
    if docker exec "$name" bun -e 'const r=await fetch("http://127.0.0.1:8080/readyz");process.exit(r.status===200?0:1)' 2>/dev/null; then
      return
    fi
    sleep 1
  done
  docker logs "$name" >&2
  return 1
}
ready
docker exec "$name" bun -e 'if (process.getuid()===0) throw Error("container is root")'
docker exec "$name" bun -e 'const r=await fetch("http://127.0.0.1:8080/");if (!r.ok || !r.headers.get("content-type")?.includes("text/html")) throw Error("public entry failed")'
mv -- "$base/state/config/bootstrap.json" "$base/used-bootstrap.json"
docker restart --time 30 "$name" >/dev/null
ready
