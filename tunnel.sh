#!/bin/bash
# Starts ngrok and points the Kapso webhook at its (random) public URL.
set -u
source ~/.config/kapso/kapso.env
/opt/homebrew/bin/ngrok http 8787 --log stdout > ~/whatsapp-assistant/logs/ngrok.log 2>&1 &
NGROK=$!
trap 'kill $NGROK 2>/dev/null' EXIT
for _ in $(seq 1 30); do
  URL=$(/usr/bin/curl -s http://127.0.0.1:4040/api/tunnels | /usr/bin/python3 -c 'import json,sys; t=json.load(sys.stdin)["tunnels"]; print(next(x["public_url"] for x in t if x["public_url"].startswith("https")))' 2>/dev/null)
  [ -n "${URL:-}" ] && break; sleep 1
done
[ -z "${URL:-}" ] && { echo "$(date) ngrok URL not found"; exit 1; }
if [ -n "${KAPSO_WEBHOOK_ID:-}" ]; then
  /usr/bin/curl -s -X PATCH "https://api.kapso.ai/platform/v1/whatsapp/webhooks/$KAPSO_WEBHOOK_ID" \
    -H "X-API-Key: $KAPSO_API_KEY" -H "Content-Type: application/json" \
    -d "{\"whatsapp_webhook\":{\"url\":\"$URL/webhook\"}}" -o /dev/null -w "$(date) webhook → $URL/webhook (%{http_code})\n"
else
  echo "$(date) tunnel up at $URL (no KAPSO_WEBHOOK_ID yet)"
fi
wait $NGROK
