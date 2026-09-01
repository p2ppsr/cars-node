#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "${repo_root}"

source_sha="${SOURCE_SHA:-$(git rev-parse HEAD)}"
[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || {
  echo "SOURCE_SHA must be a full lowercase Git commit SHA" >&2
  exit 2
}
short_sha="${source_sha:0:12}"
image_date="${IMAGE_DATE:-$(date -u +%F)}"
package_version="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -n 1)"
[[ "$package_version" =~ ^[0-9A-Za-z][0-9A-Za-z.+-]*$ ]] || {
  echo "cannot read a safe package version from package.json" >&2
  exit 2
}
image_tag="${IMAGE_TAG:-v${package_version}-${image_date}-cars-reliability-${short_sha}}"
registry_push="${REGISTRY_PUSH:-10.152.183.28:5000}"
registry_pull="${REGISTRY_PULL:-registry.cars-operator-system.svc.cluster.local:5000}"

push_image="${registry_push}/cars-node:${image_tag}"
pull_image="${registry_pull}/cars-node:${image_tag}"

docker build \
  --platform linux/amd64 \
  --build-arg "APP_COMMIT=${source_sha}" \
  --build-arg "APP_VERSION=${package_version}" \
  -t "${push_image}" .
push_output="$(docker push "${push_image}" 2>&1 | tee /dev/stderr)"
image_digest="$(sed -n 's/^.*digest: \(sha256:[0-9a-f]\{64\}\).*$/\1/p' <<<"${push_output}" | tail -n 1)"
[[ "${image_digest}" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo "registry push did not return a valid image digest" >&2
  exit 1
}
immutable_pull_image="${pull_image}@${image_digest}"
immutable_push_image="${push_image}@${image_digest}"

cat > release-manifest.json <<EOF
{
  "source_sha": "${source_sha}",
  "version": "${package_version}",
  "image_tag": "${image_tag}",
  "image": "${immutable_pull_image}",
  "image_digest": "${image_digest}"
}
EOF

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    printf 'image_tag=%s\n' "${image_tag}"
    printf 'image=%s\n' "${immutable_pull_image}"
    printf 'scan_image=%s\n' "${immutable_push_image}"
    printf 'image_digest=%s\n' "${image_digest}"
  } >> "${GITHUB_OUTPUT}"
fi

printf 'Pushed image %s\n' "${immutable_pull_image}"
