#!/usr/bin/env bash
set -euo pipefail

kubectl_cmd="${KUBECTL:-kubectl}"
controller_namespace="cars-operator-system"
controller_selector="app.kubernetes.io/name=cars-advertisement-controller"
root_namespace="cars-project-c6a84fc53bb50c34e179dcd861eb3964"
root_selector="app=cars-project-c6a84fc53bb50c34e179dcd8"

ready_pod() {
  local namespace="$1"
  local selector="$2"
  "${kubectl_cmd}" -n "${namespace}" get pods -l "${selector}" \
    -o jsonpath='{range .items[?(@.status.phase=="Running")]}{.metadata.name}{"\t"}{.metadata.deletionTimestamp}{"\t"}{.status.containerStatuses[0].ready}{"\n"}{end}' \
    | awk -F '\t' '$2 == "" && $3 == "true" {print $1; exit}'
}

controller_pod="$(ready_pod "${controller_namespace}" "${controller_selector}")"
root_pod="$(ready_pod "${root_namespace}" "${root_selector}")"
[[ -n "${controller_pod}" ]] || {
  echo "no ready advertisement-controller pod is available for discovery eviction" >&2
  exit 1
}
[[ -n "${root_pod}" ]] || {
  echo "no ready users.bapp.dev backend pod is available for discovery eviction" >&2
  exit 1
}

denied_domains="$(${kubectl_cmd} -n "${controller_namespace}" exec "${controller_pod}" -c controller -- node -e '
const { DEFAULT_DISCOVERY_DENYLIST } = require("./dist/src/discovery-denylist.js");
process.stdout.write(DEFAULT_DISCOVERY_DENYLIST.join(","));
')"
denied_capabilities="$(${kubectl_cmd} -n "${controller_namespace}" exec "${controller_pod}" -c controller -- node -e '
const { serializeDiscoveryCapabilityDenylist } = require("./dist/src/discovery-denylist.js");
process.stdout.write(serializeDiscoveryCapabilityDenylist());
')"
preferred_identity_key="$(${kubectl_cmd} -n "${controller_namespace}" exec "${controller_pod}" -c controller -- node -e '
const { KeyDeriver, PrivateKey } = require("@bsv/sdk");
process.stdout.write(new KeyDeriver(new PrivateKey(process.env.CARS_ADVERTISEMENT_PRIVATE_KEY, "hex")).identityKey);
')"

evict_store() {
  local namespace="$1"
  local pod="$2"
  local container="$3"
  local target="$4"
  "${kubectl_cmd}" -n "${namespace}" exec -i "${pod}" -c "${container}" -- env \
    "CARS_EVICTION_TARGET=${target}" \
    "CARS_EVICTION_DENIED_DOMAINS=${denied_domains}" \
    "CARS_EVICTION_DENIED_CAPABILITIES=${denied_capabilities}" \
    "CARS_EVICTION_PREFERRED_IDENTITY_KEY=${preferred_identity_key}" \
    node <<'NODE'
const { MongoClient } = require('mongodb');

const normalizeDomain = value => String(value || '').trim().replace(/\/+$/, '').toLowerCase();
const capabilityKey = (protocol, domain, capability) =>
  `${protocol}|${normalizeDomain(domain)}|${String(capability || '').trim()}`;

(async () => {
  const target = process.env.CARS_EVICTION_TARGET;
  const mongoUrl = process.env.ADVERTISEMENT_MONGO_URL || process.env.MONGO_URL;
  if (!mongoUrl) throw new Error(`${target}: ADVERTISEMENT_MONGO_URL or MONGO_URL is required`);
  const deniedDomains = new Set(
    String(process.env.CARS_EVICTION_DENIED_DOMAINS || '').split(',').map(normalizeDomain).filter(Boolean)
  );
  const deniedCapabilities = new Set(
    String(process.env.CARS_EVICTION_DENIED_CAPABILITIES || '').split(',').map(value => {
      const [protocol, domain, ...capabilityParts] = value.split('|');
      if ((protocol !== 'SHIP' && protocol !== 'SLAP') || !domain || capabilityParts.length === 0) return '';
      return capabilityKey(protocol, domain, capabilityParts.join('|'));
    }).filter(Boolean)
  );
  if (deniedDomains.size === 0) throw new Error(`${target}: refusing eviction with an empty domain denylist`);
  if (deniedCapabilities.size === 0) {
    throw new Error(`${target}: refusing eviction with an empty capability denylist`);
  }
  const preferredIdentityKey = process.env.CARS_EVICTION_PREFERRED_IDENTITY_KEY;
  if (!preferredIdentityKey) throw new Error(`${target}: preferred identity key is required`);

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
      const before = await collection.find({}).toArray();
      const domainRecords = before.filter(record => deniedDomains.has(normalizeDomain(record.domain)));
      const domainIds = new Set(domainRecords.map(record => String(record._id)));
      const capabilityRecords = before.filter(record =>
        !domainIds.has(String(record._id)) && deniedCapabilities.has(
          capabilityKey(protocol, record.domain, record[capabilityField])
        )
      );
      const evictions = [
        ...domainRecords.map(record => ({ reason: 'operator-domain-denylist', record })),
        ...capabilityRecords.map(record => ({ reason: 'operator-capability-denylist', record })),
      ];
      if (evictions.length > 0) {
        await backup.insertMany(evictions.map(({ reason, record }) => ({
          evictedAt,
          reason,
          target,
          protocol,
          sourceCollection: collectionName,
          record,
        })));
        await collection.deleteMany({ _id: { $in: evictions.map(({ record }) => record._id) } });
      }

      const activeRecords = await collection.find({}).toArray();
      const deniedRemaining = activeRecords.filter(record =>
        deniedDomains.has(normalizeDomain(record.domain))
      ).length;
      const capabilityDeniedRemaining = activeRecords.filter(record =>
        deniedCapabilities.has(capabilityKey(protocol, record.domain, record[capabilityField]))
      ).length;
      if (deniedRemaining !== 0 || capabilityDeniedRemaining !== 0) {
        throw new Error(
          `${target}/${collectionName} retains domain=${deniedRemaining} capability=${capabilityDeniedRemaining} denied records`
        );
      }

      const groups = new Map();
      for (const record of activeRecords) {
        const key = JSON.stringify([
          normalizeDomain(record.domain),
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
          target,
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
          normalizeDomain(record.domain),
          String(record[capabilityField] || ''),
        ]);
        if (validationKeys.has(key)) throw new Error(`${target}/${collectionName} retains semantic duplicates`);
        validationKeys.add(key);
      }
      results[collectionName] = {
        domainDeniedEvicted: domainRecords.length,
        capabilityDeniedEvicted: capabilityRecords.length,
        duplicatesEvicted: duplicateRecords.length,
        deniedRemaining,
        capabilityDeniedRemaining,
      };
    }
    console.log(JSON.stringify({
      target,
      deniedDomains: deniedDomains.size,
      deniedCapabilities: deniedCapabilities.size,
      ...results,
    }));
  } finally {
    await client.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
NODE
}

evict_store "${controller_namespace}" "${controller_pod}" controller advertisement-controller
evict_store "${root_namespace}" "${root_pod}" backend users.bapp.dev
