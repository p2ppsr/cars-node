#!/usr/bin/env bash
set -euo pipefail

kubectl_cmd="${KUBECTL:-kubectl}"
namespace="cars-operator-system"
selector="app.kubernetes.io/name=cars-advertisement-controller"
rounds="${AUDIT_ROUNDS:-3}"
timeout_ms="${AUDIT_TIMEOUT_MS:-3000}"
round_delay_ms="${AUDIT_ROUND_DELAY_MS:-5000}"
concurrency="${AUDIT_CONCURRENCY:-10}"
output="${AUDIT_OUTPUT:-discovery-host-audit.json}"

[[ "${rounds}" =~ ^[1-9][0-9]*$ ]] || { echo "AUDIT_ROUNDS must be a positive integer" >&2; exit 2; }
[[ "${timeout_ms}" =~ ^[1-9][0-9]*$ ]] || { echo "AUDIT_TIMEOUT_MS must be a positive integer" >&2; exit 2; }
[[ "${round_delay_ms}" =~ ^[0-9]+$ ]] || { echo "AUDIT_ROUND_DELAY_MS must be a non-negative integer" >&2; exit 2; }
[[ "${concurrency}" =~ ^[1-9][0-9]*$ ]] || { echo "AUDIT_CONCURRENCY must be a positive integer" >&2; exit 2; }

pod="$(${kubectl_cmd} -n "${namespace}" get pods -l "${selector}" \
  -o jsonpath='{range .items[?(@.status.phase=="Running")]}{.metadata.name}{"\t"}{.metadata.deletionTimestamp}{"\t"}{.status.containerStatuses[0].ready}{"\n"}{end}' \
  | awk -F '\t' '$2 == "" && $3 == "true" {print $1; exit}')"
[[ -n "${pod}" ]] || {
  echo "no ready advertisement-controller pod is available for discovery audit" >&2
  exit 1
}

tmp_output="$(mktemp)"
trap 'rm -f "${tmp_output}"' EXIT

"${kubectl_cmd}" -n "${namespace}" exec -i "${pod}" -c controller -- \
  env \
    "AUDIT_ROUNDS=${rounds}" \
    "AUDIT_TIMEOUT_MS=${timeout_ms}" \
    "AUDIT_ROUND_DELAY_MS=${round_delay_ms}" \
    "AUDIT_CONCURRENCY=${concurrency}" \
  node >"${tmp_output}" <<'NODE'
const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { MongoClient } = require('mongodb');

const rounds = Number(process.env.AUDIT_ROUNDS);
const timeoutMs = Number(process.env.AUDIT_TIMEOUT_MS);
const roundDelayMs = Number(process.env.AUDIT_ROUND_DELAY_MS);
const concurrency = Number(process.env.AUDIT_CONCURRENCY);

function normalizeDomain(value) {
  const url = new URL(String(value));
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('advertisement domain must use HTTP or HTTPS');
  }
  if (url.username || url.password) throw new Error('advertisement domain must not contain credentials');
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/$/, '').toLowerCase();
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) || a >= 224
    );
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    return !(
      normalized === '::' || normalized === '::1' ||
      normalized.startsWith('fc') || normalized.startsWith('fd') ||
      normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
      normalized.startsWith('fea') || normalized.startsWith('feb') ||
      normalized.startsWith('ff') || normalized.startsWith('2001:db8:') ||
      normalized.startsWith('::ffff:')
    );
  }
  return false;
}

async function fetchInventory(domain, path) {
  const endpoint = new URL(path, `${domain}/`);
  const hostname = endpoint.hostname.toLowerCase();
  if (
    hostname === 'localhost' || hostname.endsWith('.local') ||
    hostname.endsWith('.internal') || hostname.endsWith('.cluster.local')
  ) throw new Error('hostname is not public');

  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  const targets = addresses.filter(candidate => isPublicAddress(candidate.address));
  if (targets.length === 0) throw new Error('hostname has no public address');
  const target = targets[0];

  return new Promise((resolve, reject) => {
    const transport = endpoint.protocol === 'https:' ? https : http;
    const request = transport.request(endpoint, {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': 'cars-discovery-audit/1.0' },
      lookup: (_hostname, options, callback) => {
        if (options && options.all) callback(null, [target]);
        else callback(null, target.address, target.family);
      },
    }, response => {
      const status = response.statusCode || 0;
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 256 * 1024) {
          request.destroy(new Error('response exceeds 256 KiB'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!body || typeof body !== 'object' || Array.isArray(body)) {
            throw new Error('inventory is not a JSON object');
          }
          resolve(body);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    request.on('error', reject);
    request.end();
  });
}

function conciseError(error) {
  const value = String(error && (error.code || error.message) || error || 'unknown error');
  return value.replace(/\s+/g, ' ').slice(0, 180);
}

async function probeDomain(entry) {
  const checks = [];
  for (const [protocol, capabilities, path] of [
    ['SHIP', entry.topics, '/listTopicManagers'],
    ['SLAP', entry.services, '/listLookupServiceProviders'],
  ]) {
    if (capabilities.length === 0) continue;
    try {
      const inventory = await fetchInventory(entry.domain, path);
      const present = capabilities.filter(capability =>
        Object.prototype.hasOwnProperty.call(inventory, capability));
      const missing = capabilities.filter(capability => !present.includes(capability));
      checks.push({ protocol, status: missing.length === 0 ? 'live' : 'partial', present, missing });
    } catch (error) {
      checks.push({ protocol, status: 'dead', present: [], missing: capabilities, reason: conciseError(error) });
    }
  }

  const claimed = entry.topics.length + entry.services.length;
  const present = checks.reduce((count, check) => count + check.present.length, 0);
  const status = present === claimed ? 'live' : present > 0 ? 'partial' : 'dead';
  return { status, checks };
}

async function mapWithConcurrency(items, limit, callback) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await callback(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

(async () => {
  const mongoUrl = process.env.ADVERTISEMENT_MONGO_URL;
  if (!mongoUrl) throw new Error('ADVERTISEMENT_MONGO_URL is required');
  const client = new MongoClient(mongoUrl);
  await client.connect();
  let shipRecords;
  let slapRecords;
  try {
    const database = client.db();
    [shipRecords, slapRecords] = await Promise.all([
      database.collection('shipRecords').find({}, { projection: { domain: 1, topic: 1 } }).toArray(),
      database.collection('slapRecords').find({}, { projection: { domain: 1, service: 1 } }).toArray(),
    ]);
  } finally {
    await client.close();
  }

  const domains = new Map();
  const invalidRecords = [];
  for (const [protocol, records, capabilityField] of [
    ['SHIP', shipRecords, 'topic'],
    ['SLAP', slapRecords, 'service'],
  ]) {
    for (const record of records) {
      try {
        const domain = normalizeDomain(record.domain);
        const entry = domains.get(domain) || { domain, topics: new Set(), services: new Set(), records: 0 };
        entry.records += 1;
        const capability = String(record[capabilityField] || '').trim();
        if (capability) entry[protocol === 'SHIP' ? 'topics' : 'services'].add(capability);
        domains.set(domain, entry);
      } catch (error) {
        invalidRecords.push({ protocol, domain: String(record.domain || ''), reason: conciseError(error) });
      }
    }
  }

  const entries = [...domains.values()].map(entry => ({
    domain: entry.domain,
    topics: [...entry.topics].sort(),
    services: [...entry.services].sort(),
    records: entry.records,
    rounds: [],
  })).sort((left, right) => left.domain.localeCompare(right.domain));

  for (let round = 1; round <= rounds; round += 1) {
    const results = await mapWithConcurrency(entries, concurrency, probeDomain);
    results.forEach((result, index) => entries[index].rounds.push({ round, ...result }));
    if (round < rounds && roundDelayMs > 0) await sleep(roundDelayMs);
  }

  for (const entry of entries) {
    const statuses = entry.rounds.map(round => round.status);
    entry.classification = statuses.every(status => status === 'live')
      ? 'live'
      : statuses.every(status => status === 'dead')
        ? 'deny-candidate'
        : 'unstable-or-partial';
  }

  const report = {
    schema: 'https://cars.babbage.systems/schemas/discovery-host-audit-v1',
    auditedAt: new Date().toISOString(),
    parameters: { rounds, timeoutMs, roundDelayMs, concurrency },
    source: {
      shipRecords: shipRecords.length,
      slapRecords: slapRecords.length,
      distinctDomains: entries.length,
      invalidRecords: invalidRecords.length,
    },
    summary: {
      live: entries.filter(entry => entry.classification === 'live').length,
      denyCandidates: entries.filter(entry => entry.classification === 'deny-candidate').length,
      unstableOrPartial: entries.filter(entry => entry.classification === 'unstable-or-partial').length,
    },
    denyCandidates: entries.filter(entry => entry.classification === 'deny-candidate').map(entry => entry.domain),
    invalidRecords,
    domains: entries,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
})().catch(error => { console.error(error); process.exit(1); });
NODE

mkdir -p "$(dirname "${output}")"
mv "${tmp_output}" "${output}"
trap - EXIT

node -e '
const report = require(process.argv[1]);
console.log(JSON.stringify({ auditedAt: report.auditedAt, source: report.source, summary: report.summary }));
for (const domain of report.denyCandidates) console.log(`DENY_CANDIDATE ${domain}`);
' "$(cd "$(dirname "${output}")" && pwd)/$(basename "${output}")"

