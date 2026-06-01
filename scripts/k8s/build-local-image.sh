#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "${repo_root}"

source_sha="${SOURCE_SHA:-$(git rev-parse HEAD)}"
short_sha="${source_sha:0:12}"
image_date="${IMAGE_DATE:-$(date -u +%F)}"
package_version="$(node -p "require('./package.json').version")"
image_tag="${IMAGE_TAG:-v${package_version}-${image_date}-cars-reliability-${short_sha}}"
registry_push="${REGISTRY_PUSH:-10.152.183.28:5000}"
registry_pull="${REGISTRY_PULL:-registry.cars-operator-system.svc.cluster.local:5000}"

push_image="${registry_push}/cars-node:${image_tag}"
pull_image="${registry_pull}/cars-node:${image_tag}"

docker build \
  --build-arg "APP_COMMIT=${source_sha}" \
  --build-arg "APP_VERSION=${package_version}" \
  -t "${push_image}" .
docker push "${push_image}"

cat > release-manifest.json <<EOF
{
  "source_sha": "${source_sha}",
  "version": "${package_version}",
  "image_tag": "${image_tag}",
  "image": "${pull_image}"
}
EOF

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    printf 'image_tag=%s\n' "${image_tag}"
    printf 'image=%s\n' "${pull_image}"
  } >> "${GITHUB_OUTPUT}"
fi

printf 'Pushed image %s\n' "${pull_image}"
