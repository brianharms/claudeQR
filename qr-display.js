#!/usr/bin/env node
// Renders a QR code using random ASCII characters for filled modules
const fs = require('fs');
const QRCode = require('qrcode');

const INSTANCE_ID = process.env.CLAUDEQR_INSTANCE || 'default';
const infoPath = `/tmp/claudeqr-${INSTANCE_ID}-info.json`;

if (!fs.existsSync(infoPath)) {
  console.log('\n  claudeQR server is not running.');
  console.log('  Start your session with: claudeqr\n');
  process.exit(1);
}

const info = JSON.parse(fs.readFileSync(infoPath, 'utf-8'));

// Full ASCII character pool — dense mix for visual texture
const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$%&*+=!?<>{}[]~;:';

function randomChar() {
  return CHARS[Math.floor(Math.random() * CHARS.length)];
}

// Generate raw QR matrix — low error correction keeps it small
const qr = QRCode.create(info.mobileUrl, { errorCorrectionLevel: 'L' });
const size = qr.modules.size;
const data = qr.modules.data;
const quiet = 2; // quiet zone border (modules)

const lines = [];
lines.push('');
lines.push('  CLAUDEQR — SCAN TO CONNECT');
lines.push('');

for (let row = -quiet; row < size + quiet; row++) {
  let line = '    ';
  for (let col = -quiet; col < size + quiet; col++) {
    if (row >= 0 && row < size && col >= 0 && col < size) {
      const isDark = data[row * size + col];
      line += isDark ? randomChar() + randomChar() : '  ';
    } else {
      line += '  ';
    }
  }
  lines.push(line);
}

lines.push('');
lines.push('  ' + info.mobileUrl);
lines.push('');

// Output to stdout
console.log(lines.join('\n'));

// Also write to file so the pane height can be calculated
const totalLines = lines.length;
fs.writeFileSync(`/tmp/claudeqr-${INSTANCE_ID}-qr-height`, String(totalLines));
