#!/usr/bin/env node
/**
 * Patches the randomBytesHex stub in @bsv/wallet-toolbox that is missing
 * from the compiled build (bug present in 2.0.14 through at least 2.0.20).
 *
 * Without this patch, createWalletSQLite throws "Function not implemented"
 * and the wallet falls back to memory mode, losing persistent wallet state.
 *
 * Run automatically via "postinstall" in package.json.
 */
const fs = require('fs');
const path = require('path');

const setupPath = path.join(__dirname, '..', 'node_modules', '@bsv', 'wallet-toolbox', 'out', 'src', 'Setup.js');

if (!fs.existsSync(setupPath)) {
  console.log('[patch-wallet-toolbox] Setup.js not found — skipping.');
  process.exit(0);
}

let content = fs.readFileSync(setupPath, 'utf8');
const stub = "function randomBytesHex(arg0) {\n    throw new Error('Function not implemented.');\n}";
const impl = "function randomBytesHex(arg0) { return require('crypto').randomBytes(arg0).toString('hex'); }";

if (!content.includes(stub)) {
  console.log('[patch-wallet-toolbox] Stub not found — already patched or version changed. OK.');
  process.exit(0);
}

content = content.replace(stub, impl);
fs.writeFileSync(setupPath, content);
console.log('[patch-wallet-toolbox] randomBytesHex stub patched successfully. SQLite wallet mode enabled.');
