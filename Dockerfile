# Use the publisher's immutable patch-release image and verify the installed
# Buildah version after OS security updates. The October 18 Fedora update
# advances Buildah to the reviewed 1.43.5 symlink-escape fixes.
ARG BUILDAH_IMAGE=quay.io/buildah/stable:v1.43.4-immutable@sha256:6f237dd57d662fe3e86e6d5cae018585173913783d3a4480d729fc8b92247487

FROM ${BUILDAH_IMAGE} AS node-tools

RUN dnf upgrade -y --refresh && \
    dnf install -y ca-certificates curl gzip tar xz && \
    dnf clean all && \
    rm -rf /var/cache/dnf

WORKDIR /tmp/toolchain

ARG NODE_VERSION=24.22.1
ARG NODE_SHA256=6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6
RUN curl --fail --location --proto '=https' --tlsv1.2 \
      --output node.tar.xz \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" && \
    printf '%s  %s\n' "${NODE_SHA256}" node.tar.xz | sha256sum --check --strict && \
    tar --extract --xz --file node.tar.xz --strip-components=1 --directory /usr/local && \
    rm node.tar.xz

FROM node-tools AS release-security

WORKDIR /security
COPY package.json package-lock.json ./

# The workflow supplies a unique nonce so the network-backed audit cannot be
# satisfied from a stale BuildKit layer while the verified toolchain remains
# cacheable.
ARG SECURITY_AUDIT_NONCE=manual
RUN test -n "${SECURITY_AUDIT_NONCE}" && \
    npm audit --omit=dev --audit-level=high && \
    npm sbom --package-lock-only --omit=dev --sbom-format=cyclonedx > release-sbom.cdx.json

FROM scratch AS release-security-evidence
COPY --from=release-security /security/release-sbom.cdx.json /release-sbom.cdx.json

FROM node-tools AS tools

ARG GO_VERSION=1.26.10
ARG GO_SHA256=ccfe7ae822d2c2f41f4fe7c956199967a4dac22d0ee0d2b2bfdb440aab3b20c5
RUN curl --fail --location --proto '=https' --tlsv1.2 \
      --output go.tar.gz \
      "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" && \
    printf '%s  %s\n' "${GO_SHA256}" go.tar.gz | sha256sum --check --strict && \
    tar --extract --gzip --file go.tar.gz --directory /usr/local && \
    rm go.tar.gz

ENV PATH="/usr/local/go/bin:${PATH}" \
    GOTOOLCHAIN=local \
    GOPROXY="https://proxy.golang.org,direct" \
    GOSUMDB="sum.golang.org"

WORKDIR /tmp/cars-runtime-tools
COPY tools/helm ./helm
COPY tools/kubectl ./kubectl

ARG HELM_VERSION=v4.2.4
ARG HELM_COMMIT=3900f434fd3ef2b84065dc04508df48f288dba00
RUN cd helm && \
    go mod download && \
    go mod verify && \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
      -trimpath -buildvcs=false \
      -ldflags="-s -w -X helm.sh/helm/v4/internal/version.version=${HELM_VERSION} -X helm.sh/helm/v4/internal/version.metadata=cars-patched-go${GO_VERSION} -X helm.sh/helm/v4/internal/version.gitCommit=${HELM_COMMIT} -X helm.sh/helm/v4/internal/version.gitTreeState=clean" \
      -o /usr/local/bin/helm .

ARG KUBECTL_VERSION=v1.34.11
ARG KUBECTL_COMMIT=3a634765b787dd069f7f714fa77d767cb7d43795
RUN cd kubectl && \
    go mod download && \
    go mod verify && \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
      -trimpath -buildvcs=false \
      -ldflags="-s -w -X k8s.io/component-base/version.gitMajor=1 -X k8s.io/component-base/version.gitMinor=34 -X k8s.io/component-base/version.gitVersion=${KUBECTL_VERSION}+cars.2 -X k8s.io/component-base/version.gitCommit=${KUBECTL_COMMIT} -X k8s.io/component-base/version.gitTreeState=clean" \
      -o /usr/local/bin/kubectl . && \
    go clean -cache -modcache && \
    rm -rf /usr/local/go /tmp/cars-runtime-tools

FROM ${BUILDAH_IMAGE} AS build

RUN dnf upgrade -y --refresh && \
    dnf install -y gcc-c++ make && \
    dnf clean all && \
    rm -rf /var/cache/dnf

COPY --from=tools /usr/local/ /usr/local/

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
COPY setup.ts ./setup.ts
RUN npm run build && \
    npm prune --omit=dev && \
    npm cache clean --force

FROM ${BUILDAH_IMAGE} AS runtime

# Include the security package in the cache key so an older cached dnf upgrade
# cannot supply the runtime package. Verify it before copying application code.
ARG BUILDAH_RPM_VERSION=1.43.5-1.fc44
RUN dnf upgrade -y --refresh && \
    dnf install -y "buildah-${BUILDAH_RPM_VERSION}" bash ca-certificates openssl shadow-utils && \
    test "$(rpm -q --qf '%{VERSION}-%{RELEASE}' buildah)" = "${BUILDAH_RPM_VERSION}" && \
    dnf clean all && \
    rm -rf /var/cache/dnf

COPY --from=tools /usr/local/bin/node /usr/local/bin/node
COPY --from=tools /usr/local/bin/kubectl /usr/local/bin/kubectl
COPY --from=tools /usr/local/bin/helm /usr/local/bin/helm

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY wait-for-services.sh /wait-for-services.sh

RUN set -eux; install -d -m 0755 /app/src/migrations && \
    for file in /app/dist/src/migrations/*.js; do \
      install -m 0644 "$file" "/app/src/migrations/$(basename "${file%.js}").ts"; \
    done && \
    test "$(find /app/src/migrations -maxdepth 1 -type f -name '*.ts' | wc -l)" = \
      "$(find /app/dist/src/migrations -maxdepth 1 -type f -name '*.js' | wc -l)" && \
    chmod 0755 /wait-for-services.sh && \
    test ! -e /usr/local/bin/npm && \
    test ! -d /usr/local/lib/node_modules/npm && \
    test "$(node --version)" = "v24.22.1" && \
    test "$(kubectl version --client=true --output=json | node -pe 'JSON.parse(require("fs").readFileSync(0)).clientVersion.gitVersion')" = "v1.34.11+cars.2" && \
    test "$(helm version --template '{{.Version}}')" = "v4.2.4+cars-patched-go1.26.10" && \
    test "$(buildah --version)" = 'buildah version 1.43.5 (image-spec 1.1.1, runtime-spec 1.2.1)' && \
    test "$(rpm -q --qf '%{VERSION}-%{RELEASE}' buildah)" = '1.43.5-1.fc44'

ENV CARS_MIGRATIONS_DIR=/app/src/migrations

ARG APP_COMMIT=unknown
ARG APP_VERSION=unknown

LABEL org.opencontainers.image.source="https://github.com/p2ppsr/cars-node" \
      org.opencontainers.image.revision="${APP_COMMIT}" \
      org.opencontainers.image.version="${APP_VERSION}"

EXPOSE 7777

CMD ["node", "dist/src/server.js"]
