#!/bin/bash
# Show QR code in a tmux split pane, auto-closes when phone connects
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Save our pane ID so the server can kill us when phone connects
tmux display-message -p '#{pane_id}' > /tmp/claudeqr-pane-id.txt
rm -f /tmp/claudeqr-connected

node "$SCRIPT_DIR/qr-display.js"
echo ""
echo "  Waiting for phone to connect..."

# Poll for connection signal (server writes this file on connect)
while [ ! -f /tmp/claudeqr-connected ]; do
  sleep 0.3
done

# Clean up
rm -f /tmp/claudeqr-pane-id.txt /tmp/claudeqr-connected
