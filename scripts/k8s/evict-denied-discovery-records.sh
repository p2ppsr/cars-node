#!/usr/bin/env bash
set -euo pipefail

kubectl_cmd="${KUBECTL:-kubectl}"
namespace="cars-operator-system"
selector="app.kubernetes.io/name=cars-advertisement-controller"

pod="$(${kubectl_cmd} -n "${namespace}" get pods -l "${selector}" \
  -o jsonpath='{range .items[?(@.status.phase=="Running")]}{.metadata.name}{"\t"}{.metadata.deletionTimestamp}{"\t"}{.status.containerStatuses[0].ready}{"\n"}{end}' \
  | awk -F '\t' '$2 == "" && $3 == "true" {print $1; exit}')"
[[ -n "${pod}" ]] || {
  echo "no ready advertisement-controller pod is available for discovery eviction" >&2
  exit 1
}

"${kubectl_cmd}" -n "${namespace}" exec -i "${pod}" -c controller -- node <<'NODE'
const { MongoClient } = require('mongodb');
const { KeyDeriver, PrivateKey } = require('@bsv/sdk');
const {
  DEFAULT_DISCOVERY_DENYLIST,
  discoveryDenylist,
  normalizeDiscoveryDomain,
} = require('./dist/src/discovery-denylist.js');

(async () => {
  const mongoUrl = process.env.ADVERTISEMENT_MONGO_URL;
  if (!mongoUrl) throw new Error('ADVERTISEMENT_MONGO_URL is required');
  const denied = [...discoveryDenylist(
    process.env.CARS_BANNED_AD_DOMAINS || DEFAULT_DISCOVERY_DENYLIST.join(',')
  )];
  if (denied.length === 0) throw new Error('refusing eviction with an empty discovery denylist');
  const privateKey = process.env.CARS_ADVERTISEMENT_PRIVATE_KEY;
  if (!privateKey) throw new Error('CARS_ADVERTISEMENT_PRIVATE_KEY is required');
  const preferredIdentityKey = new KeyDeriver(new PrivateKey(privateKey, 'hex')).identityKey;

  const candidates = [...new Set(denied.flatMap(domain => [domain, `${domain}/`]))];
  const client = new MongoClient(mongoUrl);
  await client.connect();
  try {
    const database = client.db();
    const backup = database.collection('networkOpsDiscoveryEvictions');
    const evictedAt = new Date();
    const results = {};
    for (const [collectionName, protocol, capabilityField] of [
      ['shipRecords', 'SHIP', 'topic'],
      ['slapRecords', 'SLAP', 'service'],
    ]) {
      const collection = database.collection(collectionName);
      const records = await collection.find({ domain: { $in: candidates } }).toArray();
      if (records.length > 0) {
        await backup.insertMany(records.map(record => ({
          evictedAt,
          reason: 'operator-domain-denylist',
          protocol,
          sourceCollection: collectionName,
          record,
        })));
        await collection.deleteMany({ _id: { $in: records.map(record => record._id) } });
      }
      const remaining = await collection.countDocuments({ domain: { $in: candidates } });
      if (remaining !== 0) throw new Error(`${collectionName} retains ${remaining} denied records`);

      const activeRecords = await collection.find({}).toArray();
      const groups = new Map();
      for (const record of activeRecords) {
        const key = JSON.stringify([
          normalizeDiscoveryDomain(record.domain),
          String(record[capabilityField] || ''),
        ]);
        const group = groups.get(key) || [];
        group.push(record);
        groups.set(key, group);
      }
      const duplicateRecords = [];
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        group.sort((left, right) => {
          const preferred = Number(right.identityKey === preferredIdentityKey) -
            Number(left.identityKey === preferredIdentityKey);
          if (preferred) return preferred;
          const dateOrder = Number(new Date(right.createdAt || 0)) - Number(new Date(left.createdAt || 0));
          if (dateOrder) return dateOrder;
          return String(right._id).localeCompare(String(left._id));
        });
        duplicateRecords.push(...group.slice(1));
      }
      if (duplicateRecords.length > 0) {
        await backup.insertMany(duplicateRecords.map(record => ({
          evictedAt,
          reason: 'semantic-provider-capability-duplicate',
          protocol,
          sourceCollection: collectionName,
          record,
        })));
        await collection.deleteMany({ _id: { $in: duplicateRecords.map(record => record._id) } });
      }

      const validationRecords = await collection.find({}).toArray();
      const validationKeys = new Set();
      for (const record of validationRecords) {
        const key = JSON.stringify([
          normalizeDiscoveryDomain(record.domain),
          String(record[capabilityField] || ''),
        ]);
        if (validationKeys.has(key)) throw new Error(`${collectionName} retains semantic duplicates`);
        validationKeys.add(key);
      }
      results[collectionName] = {
        deniedEvicted: records.length,
        duplicatesEvicted: duplicateRecords.length,
        deniedRemaining: remaining,
      };
    }
    console.log(JSON.stringify({ deniedDomains: denied.length, ...results }));
  } finally {
    await client.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
NODE
