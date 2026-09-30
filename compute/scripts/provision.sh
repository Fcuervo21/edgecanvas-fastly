#!/bin/sh
# Creates a complete EdgeCanvas stack on Fastly: Compute service, domain, TLS backends, KV Store,
# Secret Store (organizer token and password pepper are generated here and never printed) and the
# first deployment. Run from anywhere; needs the Fastly CLI logged in (`fastly auth login`), Node 24
# and a built package (this script builds it).
#
#   sh compute/scripts/provision.sh SERVICE_NAME DOMAIN
#   e.g. sh compute/scripts/provision.sh edgecanvas edgecanvas.edgecompute.app
#
# It does NOT create the Fanout publish token (the CLI cannot: creating tokens needs the account
# password). Create a token limited to this service in the Fastly console, then load it yourself:
#   fastly secret-store-entry create --store-id SECRET_STORE_ID --name fanout_api_token
set -eu
name=${1:?service name}; domain=${2:?domain, e.g. name.edgecompute.app}
here=$(cd "$(dirname "$0")/.." && pwd); root=$(cd "$here/.." && pwd)
id_of() { sed -n 's/.*(\([A-Za-z0-9]\{20,\}\)).*/\1/p'; }

echo "1/8 service"; out=$(fastly service create --name "$name" --type wasm --comment "EdgeCanvas: rooms on Fastly Compute" --non-interactive)
sid=$(printf '%s' "$out" | sed -n 's/.*Created service \([A-Za-z0-9]*\).*/\1/p'); [ -n "$sid" ] || { echo "could not read the service id: $out"; exit 1; }
echo "2/8 domain and TLS backends (version 1)"
fastly service domain create --service-id "$sid" --version 1 --name "$domain" --non-interactive >/dev/null
# The service calls itself for Fanout streams, and api.fastly.com to publish events; both must verify TLS.
fastly service backend create --service-id "$sid" --version 1 --name self --address "$domain" --port 443 --use-ssl \
  --ssl-cert-hostname "$domain" --ssl-sni-hostname "$domain" --override-host "$domain" --non-interactive >/dev/null
fastly service backend create --service-id "$sid" --version 1 --name fanout_publish --address api.fastly.com --port 443 --use-ssl \
  --ssl-cert-hostname api.fastly.com --ssl-sni-hostname api.fastly.com --override-host api.fastly.com --non-interactive >/dev/null
echo "3/8 KV Store"; kv=$(fastly kv-store create --name "$name-kv" --non-interactive | id_of)
echo "4/8 Secret Store"; ss=$(fastly secret-store create --name "$name-secrets" --non-interactive | id_of)
[ -n "$kv" ] && [ -n "$ss" ] || { echo "could not read store ids"; exit 1; }
echo "5/8 link stores (the names are what the code opens)"
fastly service resource-link create --service-id "$sid" --version 1 --resource-id "$kv" --name edgecanvas --non-interactive >/dev/null
fastly service resource-link create --service-id "$sid" --version 1 --resource-id "$ss" --name edgecanvas_secrets --non-interactive >/dev/null
echo "6/8 secrets (files in compute/.secrets/, mode 0600, git-ignored)"
umask 077; mkdir -p "$here/.secrets"
for secret in admin_token password_pepper; do
  file="$here/.secrets/hosted-$name-$secret"
  [ -s "$file" ] || openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' > "$file"
  fastly secret-store-entry create --store-id "$ss" --name "$secret" --file "$file" --non-interactive >/dev/null
done
echo "7/8 build and deploy"
( cd "$root" && npm run --silent build:hosted ) >/dev/null
( cd "$here" && fastly compute build --non-interactive >/dev/null && \
  fastly compute deploy --service-id "$sid" --package pkg/edgecanvas-edge.tar.gz --version 1 --comment "first deployment" --status-check-off --non-interactive >/dev/null )
echo "8/8 Fanout (30-day product trial; keep it by purchasing in the Fastly console)"
fastly products --enable=fanout --service-id "$sid" --non-interactive >/dev/null

cat <<EOF

Done.
  service id      $sid
  site            https://$domain   (the first minutes may answer 500 while it propagates)
  KV Store        $kv
  Secret Store    $ss
  organizer token $here/.secrets/hosted-$name-admin_token
  pepper backup   $here/.secrets/hosted-$name-password_pepper   (losing it invalidates every password)

Next:
  1. Create a Fastly API token limited to this service and load it as fanout_api_token (see the top of this script).
  2. export EDGE_ADMIN_TOKEN="\$(cat $here/.secrets/hosted-$name-admin_token)"
     npm run edge:admin -- upload --url https://$domain
     npm run edge:admin -- enroll --url https://$domain --player "EXACT_ROSTER_PLAYER_ID" --organizer
EOF
