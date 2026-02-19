#!/usr/bin/env node
// Reads connection info and prints an ASCII QR code to stdout
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');

const infoPath = '/tmp/claudeqr-info.json';

if (!fs.existsSync(infoPath)) {
  console.log('\n  claudeQR server is not running.');
  console.log('  Start your session with: claudeqr\n');
  process.exit(1);
}

const info = JSON.parse(fs.readFileSync(infoPath, 'utf-8'));

console.log('');
console.log('  ╔══════════════════════════════════════════╗');
console.log('  ║         claudeQR — Scan to Connect       ║');
console.log('  ╚══════════════════════════════════════════╝');
console.log('');
qrcode.generate(info.mobileUrl, { small: true }, (code) => {
  // Indent each line for nicer centering
  const indented = code.split('\n').map(l => '    ' + l).join('\n');
  console.log(indented);
  console.log('');
  console.log('  URL: ' + info.mobileUrl);
  console.log('');
});
