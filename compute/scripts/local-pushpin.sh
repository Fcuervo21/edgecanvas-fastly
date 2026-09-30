#!/bin/sh
# Starts a local Pushpin that plays Fanout for Viceroy: it holds streams, forwards them back to
# the service on 127.0.0.1:7676 ("self") signed with .secrets/local_grip_key, and accepts
# publishes on 127.0.0.1:5561. Viceroy then runs with --local-pushpin-proxy-port 7677.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
work=${PUSHPIN_WORKDIR:-/tmp/edgecanvas-pushpin}
mkdir -p "$work/run" "$work/log"
key=$(cat "$here/.secrets/local_grip_key")
libdir=$(dirname "$(find /usr/lib /usr/local/lib /opt/homebrew/opt/pushpin/lib -name internal.conf -path '*pushpin*' 2>/dev/null | head -1)")
cat > "$work/pushpin.conf" <<CONF
[global]
include=$libdir/internal.conf
rundir=$work/run
ipc_prefix=pushpin-
port_offset=0
[runner]
services=condure,pushpin-proxy,pushpin-handler
http_port=127.0.0.1:7677
logdir=$work/log
log_level=2
[proxy]
routesfile=routes
accept_pushpin_route=true
sig_iss=viceroy
sig_key=$key
[handler]
push_in_spec=tcp://127.0.0.1:5560
push_in_http_addr=127.0.0.1
push_in_http_port=5561
CONF
echo 'id=self 127.0.0.1:7676,over_http' > "$work/routes"
exec pushpin --config "$work/pushpin.conf"
