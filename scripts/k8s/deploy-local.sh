#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${IMAGE_TAG:-}" ]]; then
  if [[ -z "${SOURCE_SHA:-}" ]]; then
    echo "IMAGE_TAG or SOURCE_SHA is required" >&2
    exit 2
  fi
  package_version="$(node -p "require('./package.json').version")"
  IMAGE_TAG="v${package_version}-$(date -u +%F)-cars-reliability-${SOURCE_SHA:0:12}"
fi

registry_pull="${REGISTRY_PULL:-registry.cars-operator-system.svc.cluster.local:5000}"
kubectl_cmd="${KUBECTL:-kubectl}"
image="${registry_pull}/cars-node:${IMAGE_TAG}"
[[ "${SOURCE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || {
  echo "SOURCE_SHA must be a full lowercase Git commit SHA" >&2
  exit 2
}

curl --fail --show-error --silent https://cars.babbage.systems/health/live >/dev/null
curl --fail --show-error --silent https://cars.babbage.systems/health/ready >/dev/null
"${kubectl_cmd}" -n cars-operator-system get --raw "/api/v1/namespaces/cars-operator-system/services/http:cars-advertisement-controller:8081/proxy/health/ready" >/dev/null

"${kubectl_cmd}" -n cars-operator-system set image deployment/cars "cars=${image}"
"${kubectl_cmd}" -n cars-operator-system annotate deployment/cars \
  "network-ops.babbage.systems/source-sha=${SOURCE_SHA:-unknown}" \
  "network-ops.babbage.systems/cars-node-image=${image}" \
  --overwrite
"${kubectl_cmd}" -n cars-operator-system rollout status deployment/cars --timeout=15m
curl --fail --show-error --silent https://cars.babbage.systems/health/live >/dev/null
curl --fail --show-error --silent https://cars.babbage.systems/health/ready >/dev/null

rendered_advertisement_manifest="$(sed \
  "s|image: registry.cars-operator-system.svc.cluster.local:5000/cars-node:latest|image: ${image}|" \
  k8s/advertisement-controller.yaml)"
grep -Fq "image: ${image}" <<<"${rendered_advertisement_manifest}"
! grep -Fq 'image: registry.cars-operator-system.svc.cluster.local:5000/cars-node:latest' \
  <<<"${rendered_advertisement_manifest}"
printf '%s\n' "${rendered_advertisement_manifest}" | "${kubectl_cmd}" apply -f -
"${kubectl_cmd}" -n cars-operator-system annotate deployment/cars-advertisement-controller \
  "network-ops.babbage.systems/source-sha=${SOURCE_SHA:-unknown}" \
  "network-ops.babbage.systems/cars-node-image=${image}" \
  --overwrite
"${kubectl_cmd}" -n cars-operator-system rollout status deployment/cars-advertisement-controller --timeout=15m

controller_nodes="$(
  "${kubectl_cmd}" -n cars-operator-system get pods \
    -l app.kubernetes.io/name=cars-advertisement-controller -o json | \
    READY_IMAGE="${image}" node -e '
      const fs = require("fs")
      const readyImage = process.env.READY_IMAGE
      const pods = JSON.parse(fs.readFileSync(0, "utf8")).items
      const nodes = new Set(pods
        .filter(pod => !pod.metadata.deletionTimestamp)
        .filter(pod => pod.spec.containers?.[0]?.image === readyImage)
        .filter(pod => pod.status.containerStatuses?.[0]?.ready === true)
        .map(pod => pod.spec.nodeName))
      process.stdout.write([...nodes].sort().join("\n"))
    '
)"
controller_node_count="$(awk 'NF {count++} END {print count+0}' <<<"${controller_nodes}")"
[[ "${controller_node_count}" -ge 2 ]] || {
  echo "CARS advertisement-controller rollout lost node diversity: ${controller_nodes:-none}" >&2
  exit 1
}

curl --fail --show-error --silent https://cars.babbage.systems/health/live >/dev/null
curl --fail --show-error --silent https://cars.babbage.systems/health/ready >/dev/null
"${kubectl_cmd}" -n cars-operator-system get --raw "/api/v1/namespaces/cars-operator-system/services/http:cars-advertisement-controller:8081/proxy/health/ready" >/dev/null

printf 'cars-node deployment completed for image %s\n' "${image}"
