#!/usr/bin/env bash
set -euo pipefail

mode="${1:-enable}"
if [[ "${mode}" != "enable" && "${mode}" != "disable" ]]; then
  echo "usage: $0 [enable|disable]" >&2
  exit 2
fi

kubectl_cmd="${KUBECTL:-kubectl}"
namespace="cars-project-c6a84fc53bb50c34e179dcd861eb3964"
deployment="cars-project-c6a84fc53bb50c34e179dcd8-deployment"
configmap="cars-safe-access-logger"
index_key="cars-thin-index.ts"

"${kubectl_cmd}" -n "${namespace}" get deployment "${deployment}" >/dev/null
"${kubectl_cmd}" -n "${namespace}" get configmap "${configmap}" >/dev/null

current_index="$(${kubectl_cmd} -n "${namespace}" get configmap "${configmap}" \
  -o go-template='{{index .data "cars-thin-index.ts"}}')"

if [[ "${current_index}" == *"server.configureEngine(publicDiscoveryRoot)"* ]]; then
  patched_index="${current_index}"
elif [[ "${mode}" == "enable" && "${current_index}" == *"await server.configureEngine(false);"* ]]; then
  patched_index="${current_index/await server.configureEngine(false);/await server.configureEngine(true);}"
elif [[ "${mode}" == "disable" && "${current_index}" == *"await server.configureEngine(true);"* ]]; then
  patched_index="${current_index/await server.configureEngine(true);/await server.configureEngine(false);}"
else
  echo "${namespace}/${configmap}: discovery engine anchor is missing or ambiguous" >&2
  exit 1
fi

if [[ "${patched_index}" != "${current_index}" ]]; then
  patch_json="$({ printf '%s' "${patched_index}"; } | node -e '
let source = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { source += chunk; });
process.stdin.on("end", () => process.stdout.write(JSON.stringify({ data: { "cars-thin-index.ts": source } })));
')"
  "${kubectl_cmd}" -n "${namespace}" patch configmap "${configmap}" --type merge -p "${patch_json}"
fi

root_enabled="false"
if [[ "${mode}" == "enable" ]]; then
  root_enabled="true"
fi
"${kubectl_cmd}" -n "${namespace}" set env "deployment/${deployment}" -c backend \
  "CARS_PUBLIC_DISCOVERY_ROOT=${root_enabled}"
"${kubectl_cmd}" -n "${namespace}" annotate "deployment/${deployment}" \
  "network-ops.babbage.systems/public-discovery-root=${root_enabled}" \
  "network-ops.babbage.systems/source-sha=${SOURCE_SHA:-unknown}" \
  --overwrite

# The compatibility entry point is mounted with subPath, so a pod recreation is
# required even when the Deployment environment was already correct.
"${kubectl_cmd}" -n "${namespace}" rollout restart "deployment/${deployment}"
"${kubectl_cmd}" -n "${namespace}" rollout status "deployment/${deployment}" --timeout=15m

pod="$(${kubectl_cmd} -n "${namespace}" get pods \
  -l "app=${deployment%-deployment}" \
  -o jsonpath='{range .items[?(@.status.phase=="Running")]}{.metadata.name}{"\t"}{.metadata.deletionTimestamp}{"\t"}{.status.containerStatuses[0].ready}{"\n"}{end}' \
  | awk -F '\t' '$2 == "" && $3 == "true" {print $1; exit}')"
[[ -n "${pod}" ]] || {
  echo "${namespace}/${deployment}: no ready backend pod after rollout" >&2
  exit 1
}

"${kubectl_cmd}" -n "${namespace}" exec "${pod}" -c backend -- \
  env "expected_root_enabled=${root_enabled}" node -e '
const expected = process.env.expected_root_enabled === "true";
Promise.all([
  fetch("http://127.0.0.1:8080/listTopicManagers").then(r => r.json()),
  fetch("http://127.0.0.1:8080/listLookupServiceProviders").then(r => r.json())
]).then(([topics, services]) => {
  if (!topics.tm_users || !services.ls_users) throw new Error("UMP capabilities were not preserved");
  const discovery = Boolean(topics.tm_ship && topics.tm_slap && services.ls_ship && services.ls_slap);
  if (discovery !== expected) throw new Error(`public discovery root=${discovery}, expected=${expected}`);
  console.log(JSON.stringify({ discovery, topics: Object.keys(topics).sort(), services: Object.keys(services).sort() }));
}).catch(error => { console.error(error); process.exit(1); });
'

if [[ "${mode}" == "enable" ]]; then
  node <<'NODE'
const base = 'https://users.bapp.dev';
async function get(path) {
  const response = await fetch(`${base}${path}`);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}
async function lookup(service, query) {
  const response = await fetch(`${base}/lookup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ service, query }),
  });
  if (!response.ok) throw new Error(`${service}: HTTP ${response.status} ${await response.text()}`);
  const body = await response.json();
  if (!Array.isArray(body.outputs) || body.outputs.length === 0) {
    throw new Error(`${service}: expected at least one discovery output`);
  }
  return body.outputs.length;
}
(async () => {
  const [topics, services] = await Promise.all([
    get('/listTopicManagers'),
    get('/listLookupServiceProviders'),
  ]);
  if (!topics.tm_users || !topics.tm_ship || !topics.tm_slap) throw new Error('public topic inventory is incomplete');
  if (!services.ls_users || !services.ls_ship || !services.ls_slap) throw new Error('public lookup inventory is incomplete');
  const [shipOutputs, slapOutputs] = await Promise.all([
    lookup('ls_ship', { topics: ['tm_kvstore'] }),
    lookup('ls_slap', { service: 'ls_kvstore' }),
  ]);
  console.log(JSON.stringify({ publicRoot: base, shipOutputs, slapOutputs }));
})().catch(error => { console.error(error); process.exit(1); });
NODE
else
  curl --fail --show-error --silent https://users.bapp.dev/health >/dev/null
fi

printf 'users.bapp.dev public discovery root mode is %s\n' "${mode}d"
