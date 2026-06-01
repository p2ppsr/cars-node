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

"${kubectl_cmd}" -n cars-operator-system set image deployment/cars "cars=${image}"
"${kubectl_cmd}" -n cars-operator-system annotate deployment/cars \
  "network-ops.babbage.systems/source-sha=${SOURCE_SHA:-unknown}" \
  "network-ops.babbage.systems/cars-node-image=${image}" \
  --overwrite
"${kubectl_cmd}" -n cars-operator-system rollout status deployment/cars --timeout=15m

curl --fail --show-error --silent https://cars.babbage.systems/health/live >/dev/null
curl --fail --show-error --silent https://cars.babbage.systems/health/ready >/dev/null

printf 'cars-node deployment completed for image %s\n' "${image}"
