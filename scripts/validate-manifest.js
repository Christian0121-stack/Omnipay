#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const file = process.argv[2] || process.env.MANIFEST;
if (!file) {
  console.error('usage: node validate-manifest.js <manifest.json>');
  process.exit(2);
}

const problems = [];
const warnings = [];
const fail = (msg) => problems.push(msg);
const warn = (msg) => warnings.push(msg);

let text;
try {
  text = fs.readFileSync(file, 'utf8');
} catch (err) {
  console.error('cannot read ' + file + ': ' + err.message);
  process.exit(2);
}

let manifest;
try {
  manifest = JSON.parse(text);
} catch (err) {
  console.error('invalid JSON in ' + file + ': ' + err.message);
  process.exit(2);
}

if (/\bS[A-Z2-7]{55}\b/.test(text)) fail('a value that looks like a secret key (S...) was found');

const CONTRACT_ID = /^C[A-Z2-7]{55}$/;
const HEX64 = /^[0-9a-f]{64}$/i;
const PASSPHRASE = 'Test SDF Network ; September 2015';
if (!/test/i.test(String(manifest.network || ''))) fail('"network" must be testnet');
if (manifest.passphrase !== PASSPHRASE) fail('"passphrase" must be "' + PASSPHRASE + '"');
if (!/^https:\/\/[^\s]+$/.test(String(manifest.rpc || ''))) fail('"rpc" must be an https URL');
const deployments = Array.isArray(manifest.deployments) ? manifest.deployments : null;

if (!deployments || deployments.length === 0) {
  fail('"deployments" must be a non-empty array');
} else {
  const labels = new Set();
  deployments.forEach((d, i) => {
    const where = 'deployments[' + i + ']';
    if (d && typeof d === 'object' && d.label && labels.has(d.label)) {
      const first = deployments.find((x) => x && x.label === d.label);
      if (first && first.contractId === d.contractId) {
        warn(where + ' repeats "' + d.label + '" with the same contract');
        return;
      }
    }
    if (!d || typeof d !== 'object') return fail(where + ' must be an object');
    if (!d.label || typeof d.label !== 'string') fail(where + ' is missing "label"');
    else if (labels.has(d.label)) fail(where + ' repeats the label "' + d.label + '"');
    else labels.add(d.label);
    if (!HEX64.test(String(d.wasmHash || ''))) fail(where + ' "wasmHash" must be 64 hex characters');
    if (!CONTRACT_ID.test(String(d.contractId || ''))) fail(where + ' "contractId" must start with C and be 56 characters');
    Object.keys(d).forEach((key) => {
      if (key !== 'wasmHash' && /wasm.*hash|hash.*wasm/i.test(key) && !HEX64.test(String(d[key]))) fail(where + ' "' + key + '" must be 64 hex characters');
      if (/^network$/i.test(key) && !/test/i.test(String(d[key]))) fail(where + ' "' + key + '" must be Testnet');
    });
  });
  if (!labels.has('v2')) fail('no deployment with label "v2"');
}

if (problems.length) {
  console.error('FAIL ' + path.basename(file));
  problems.forEach((p) => console.error('  - ' + p));
  process.exit(1);
}
warnings.forEach((w) => console.log('WARN ' + w));
console.log('OK   ' + path.basename(file) + ' (' + deployments.length + ' deployment' + (deployments.length === 1 ? '' : 's') + ')');
