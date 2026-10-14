#!/bin/sh
# Start the image with the limits that the homelab uses. Then check the page and its headers.
#   test/smoke.sh                test the image astrel:dev
#   test/smoke.sh astrel:test    test another image
set -eu

image=${1:-astrel:dev}
port=${PORT:-18080}
name="astrel-smoke-$$"
url="http://127.0.0.1:$port"

fail() {
	echo "smoke: FAIL: $*" >&2
	docker logs "$name" >&2 || true
	exit 1
}

docker run -d --name "$name" \
	--read-only --tmpfs /data:rw,noexec,nosuid,size=1m,uid=65534,gid=65534,mode=0700 \
	--cap-drop ALL --security-opt no-new-privileges:true \
	--memory 64m --pids-limit 64 \
	-p "127.0.0.1:$port:8080" "$image" >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1' EXIT

tries=0
until curl -fs -o /dev/null "$url/healthz"; do
	tries=$((tries + 1))
	[ "$tries" -lt 15 ] || fail "no answer from $url/healthz after 15 seconds"
	sleep 1
done

curl -fsS "$url/" | grep -q '<h1>Astrel</h1>' || fail "the page has no <h1>Astrel</h1>"

headers=$(curl -fsS -D - -o /dev/null "$url/" | tr -d '\r')
for h in content-security-policy strict-transport-security x-content-type-options \
	referrer-policy permissions-policy cross-origin-opener-policy; do
	echo "$headers" | grep -qi "^$h: " || fail "the header $h is missing"
done
if echo "$headers" | grep -qi '^server: '; then
	fail "the Server header names the web server"
fi

for path in /style.css /favicon.svg; do
	curl -fsS -o /dev/null "$url$path" || fail "$path does not load"
done

code=$(curl -s -o /dev/null -w '%{http_code}' "$url/no-such-page")
[ "$code" = 404 ] || fail "an unknown path gave HTTP $code, not 404"
curl -s "$url/no-such-page" | grep -q 'There is no light' || fail "an unknown path does not show 404.html"

[ "$(docker exec "$name" id -u)" = 65534 ] || fail "Caddy does not run as the user nobody"

# Caddy writes JSON logs. An error line shows a problem, for example a write to the read-only file system.
if docker logs "$name" 2>&1 | grep -q '"level":"error"'; then
	fail "Caddy logged an error"
fi

echo "smoke: ok ($image)"
