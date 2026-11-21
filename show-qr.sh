#!/bin/bash
# Show QR code in a tmux split pane, auto-closes when phone connects
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTANCE_ID="${1:-default}"
TMP_PREFIX="/tmp/claudeqr-${INSTANCE_ID}"

# Save our pane ID so the server can kill us when phone connects
tmux display-message -p '#{pane_id}' > "${TMP_PREFIX}-pane-id.txt"
rm -f "${TMP_PREFIX}-connected"

CLAUDEQR_INSTANCE="$INSTANCE_ID" node "$SCRIPT_DIR/qr-display.js"
echo ""
echo "  Waiting for phone to connect..."

# Poll for connection signal (server writes this file on connect)
while [ ! -f "${TMP_PREFIX}-connected" ]; do
  sleep 0.3
done

# Clean up
rm -f "${TMP_PREFIX}-pane-id.txt" "${TMP_PREFIX}-connected"
