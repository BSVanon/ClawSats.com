#!/usr/bin/env node

/**
 * Sweep faucet balance to a destination address (or identity key).
 *
 * Safety defaults:
 * - Dry-run by default (no broadcast).
 * - Requires explicit --broadcast to publish.
 * - Keeps a small remainder in faucet address unless --keep 0.
 *
 * Usage:
 *   FAUCET_ROOT_KEY_HEX=... node scripts/sweep-faucet-balance.js --to <address-or-identity-key>
 *   FAUCET_ROOT_KEY_HEX=... node scripts/sweep-faucet-balance.js --to <dest> --broadcast
 */

const crypto = require('crypto');
const { PrivateKey, P2PKH, fromUtxo, Transaction, SatoshisPerKilobyte } = require('@bsv/sdk');

const DEFAULT_WOC_API_BASE = process.env.WOC_API_BASE || 'https://api.whatsonchain.com/v1/bsv/main';
const DEFAULT_KEEP_SATS = Number(process.env.SWEEP_KEEP_SATS || 1000);
const DEFAULT_FEE_BUFFER_SATS = Number(process.env.SWEEP_FEE_BUFFER_SATS || 3000);
const DEFAULT_FEE_RATE = Number(process.env.SWEEP_FEE_RATE || 1000);

function usage(exitCode = 0) {
  console.log(
    [
      'Usage:',
      '  FAUCET_ROOT_KEY_HEX=<64-hex> node scripts/sweep-faucet-balance.js --to <address-or-identity-key> [--broadcast]',
      '',
      'Options:',
      '  --to <value>           Required destination: P2PKH address (1...) or identity key (02/03...)',
      '  --keep <sats>          Keep this amount in faucet address (default: 1000)',
      '  --fee-buffer <sats>    Extra fee headroom before exact fee calc (default: 3000)',
      '  --fee-rate <sat/kb>    Fee rate for tx.fee() (default: 1000)',
      '  --woc <url>            WhatsOnChain base URL',
      '  --broadcast            Broadcast tx (otherwise dry-run)',
      '  --json                 Print machine-readable JSON output',
      '  --help                 Show this help',
      '',
      'Examples:',
      '  FAUCET_ROOT_KEY_HEX=... node scripts/sweep-faucet-balance.js --to 1abc...',
      '  FAUCET_ROOT_KEY_HEX=... node scripts/sweep-faucet-balance.js --to 03abcd... --broadcast'
    ].join('\n')
  );
  process.exit(exitCode);
}

function parseArgs(argv) {
  const out = {
    to: '',
    keep: DEFAULT_KEEP_SATS,
    feeBuffer: DEFAULT_FEE_BUFFER_SATS,
    feeRate: DEFAULT_FEE_RATE,
    woc: DEFAULT_WOC_API_BASE,
    broadcast: false,
    json: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') usage(0);
    else if (a === '--broadcast') out.broadcast = true;
    else if (a === '--json') out.json = true;
    else if (a === '--to') out.to = String(argv[++i] || '').trim();
    else if (a === '--keep') out.keep = Number(argv[++i]);
    else if (a === '--fee-buffer') out.feeBuffer = Number(argv[++i]);
    else if (a === '--fee-rate') out.feeRate = Number(argv[++i]);
    else if (a === '--woc') out.woc = String(argv[++i] || '').trim();
    else usage(1);
  }
  if (!out.to) throw new Error('Missing required --to destination.');
  if (!Number.isFinite(out.keep) || out.keep < 0) throw new Error('Invalid --keep value.');
  if (!Number.isFinite(out.feeBuffer) || out.feeBuffer < 0) throw new Error('Invalid --fee-buffer value.');
  if (!Number.isFinite(out.feeRate) || out.feeRate <= 0) throw new Error('Invalid --fee-rate value.');
  return out;
}

function isIdentityKey(value) {
  return /^(02|03)[0-9a-fA-F]{64}$/.test(value);
}

function pubkeyToAddress(pubkeyHex) {
  const pubkeyBuf = Buffer.from(pubkeyHex, 'hex');
  const sha = crypto.createHash('sha256').update(pubkeyBuf).digest();
  const hash160 = crypto.createHash('ripemd160').update(sha).digest();
  const versioned = Buffer.concat([Buffer.from([0x00]), hash160]);
  const checksum = crypto
    .createHash('sha256')
    .update(crypto.createHash('sha256').update(versioned).digest())
    .digest()
    .slice(0, 4);

  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let num = BigInt(`0x${Buffer.concat([versioned, checksum]).toString('hex')}`);
  let encoded = '';
  while (num > 0n) {
    const rem = num % 58n;
    num /= 58n;
    encoded = alphabet[Number(rem)] + encoded;
  }
  for (let i = 0; i < versioned.length + checksum.length && Buffer.concat([versioned, checksum])[i] === 0; i++) {
    encoded = `1${encoded}`;
  }
  return encoded;
}

async function fetchApi(url, options = {}) {
  const resp = await fetch(url, options);
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status} ${resp.statusText} for ${url}: ${body.slice(0, 240)}`);
  }
  const contentType = (resp.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/json')) return resp.json();
  return resp.text();
}

function parseWocTxHex(raw) {
  if (typeof raw === 'string') {
    const cleaned = raw.trim().replace(/^"|"$/g, '');
    if (/^[0-9a-fA-F]+$/.test(cleaned) && cleaned.length % 2 === 0) return cleaned;
  } else if (raw && typeof raw.hex === 'string') {
    return raw.hex.trim();
  } else if (raw && typeof raw.txhex === 'string') {
    return raw.txhex.trim();
  }
  throw new Error('Could not parse tx hex response.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const rootHex = String(process.env.FAUCET_ROOT_KEY_HEX || '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(rootHex)) {
    throw new Error('FAUCET_ROOT_KEY_HEX must be set to 64 hex chars.');
  }

  const priv = PrivateKey.fromHex(rootHex);
  const sourceIdentityKey = priv.toPublicKey().toString();
  const sourceAddress = priv.toAddress().toString();

  const destinationAddress = isIdentityKey(args.to) ? pubkeyToAddress(args.to) : args.to;
  const destLock = new P2PKH().lock(destinationAddress);
  if (!destLock || typeof destLock.toHex !== 'function') {
    throw new Error('Destination is not a valid P2PKH address or identity key.');
  }

  const rawUtxos = await fetchApi(`${args.woc}/address/${sourceAddress}/unspent`);
  const baseUtxos = (Array.isArray(rawUtxos) ? rawUtxos : [])
    .map(u => ({
      txid: u.tx_hash || u.tx_hash_big_endian || u.txid,
      vout: u.tx_pos ?? u.vout ?? u.tx_output_n,
      satoshis: Number(u.value ?? u.satoshis ?? 0)
    }))
    .filter(u => typeof u.txid === 'string' && Number.isInteger(u.vout) && u.satoshis > 0)
    .sort((a, b) => b.satoshis - a.satoshis);

  if (!baseUtxos.length) throw new Error('No spendable UTXOs for faucet address.');

  const tx = new Transaction();
  const unlock = new P2PKH().unlock(priv);
  let inputTotal = 0;
  let inputCount = 0;

  for (const u of baseUtxos) {
    const txhexRaw = await fetchApi(`${args.woc}/tx/${u.txid}/hex`);
    const txhex = parseWocTxHex(txhexRaw);
    const sourceTx = Transaction.fromHex(txhex);
    const out = sourceTx.outputs?.[u.vout];
    if (!out || !out.lockingScript) continue;

    tx.addInput(
      fromUtxo(
        {
          txid: u.txid,
          vout: u.vout,
          satoshis: Number(out.satoshis || u.satoshis || 0),
          script: out.lockingScript.toHex()
        },
        unlock
      )
    );
    inputTotal += Number(out.satoshis || u.satoshis || 0);
    inputCount++;
  }

  if (inputCount === 0 || inputTotal <= 0) throw new Error('Unable to load spendable inputs.');

  const provisionalSend = Math.floor(inputTotal - args.keep - args.feeBuffer);
  if (provisionalSend <= 0) {
    throw new Error(`Insufficient balance. inputTotal=${inputTotal}, keep=${args.keep}, feeBuffer=${args.feeBuffer}`);
  }

  tx.addOutput({
    satoshis: provisionalSend,
    lockingScript: destLock
  });
  tx.addP2PKHOutput(sourceAddress); // change

  await tx.fee(new SatoshisPerKilobyte(args.feeRate));
  await tx.sign();

  const outputs = tx.outputs.map((o, i) => ({
    index: i,
    satoshis: Number(o.satoshis || 0),
    script: o.lockingScript.toHex()
  }));
  const totalOutputs = outputs.reduce((sum, o) => sum + o.satoshis, 0);
  const feePaid = inputTotal - totalOutputs;
  const recipientSats = outputs[0] ? outputs[0].satoshis : 0;
  const changeSats = outputs[1] ? outputs[1].satoshis : 0;

  const report = {
    mode: args.broadcast ? 'broadcast' : 'dry-run',
    sourceIdentityKey,
    sourceAddress,
    destinationInput: args.to,
    destinationAddress,
    inputCount,
    inputTotal,
    recipientSats,
    changeSats,
    feePaid,
    keepTarget: args.keep,
    feeRate: args.feeRate
  };

  if (!args.broadcast) {
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log('[SWEEP] Dry-run only (no broadcast).');
      console.log(report);
      console.log('\nAdd --broadcast to publish this transaction.');
    }
    return;
  }

  const txhex = tx.toHex();
  const br = await fetchApi(`${args.woc}/tx/raw`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ txhex })
  });
  const txid = br && typeof br === 'object' ? br.txid : br;
  if (!txid || typeof txid !== 'string') {
    throw new Error(`Broadcast response missing txid: ${JSON.stringify(br).slice(0, 240)}`);
  }

  if (args.json) {
    console.log(JSON.stringify({ ...report, txid }, null, 2));
  } else {
    console.log('[SWEEP] Broadcast complete.');
    console.log({ ...report, txid });
  }
}

main().catch((err) => {
  const msg = err && err.message ? err.message : String(err);
  console.error(`[SWEEP] ${msg}`);
  process.exit(1);
});

