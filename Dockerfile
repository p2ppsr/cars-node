ARG BUILDAH_IMAGE=quay.io/buildah/stable:v1.43.2@sha256:6671da220c2a55976b4f10f6edfe21da3fcba86a81d495ce1ecd5b1129a97063

FROM ${BUILDAH_IMAGE} AS tools

ARG NODE_VERSION=24.19.0
ARG NODE_SHA256=14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647
ARG KUBECTL_VERSION=1.34.9
ARG KUBECTL_SHA256=73bb6f5063caadae1e73a39de018d8ad21755984bea35358484db817859e7634
ARG HELM_VERSION=3.21.4
ARG HELM_SHA256=61f88ab166748cb19604d7884cb100ae9ccb13804ddeb98e08af167eacbb6a14

RUN dnf upgrade -y --refresh && \
    dnf install -y ca-certificates curl gzip tar xz && \
    dnf clean all && \
    rm -rf /var/cache/dnf

WORKDIR /tmp/toolchain

RUN curl --fail --location --proto '=https' --tlsv1.2 \
      --output node.tar.xz \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" && \
    printf '%s  %s\n' "${NODE_SHA256}" node.tar.xz | sha256sum --check --strict && \
    tar --extract --xz --file node.tar.xz --strip-components=1 --directory /usr/local && \
    rm node.tar.xz

RUN curl --fail --location --proto '=https' --tlsv1.2 \
      --output /usr/local/bin/kubectl \
      "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/amd64/kubectl" && \
    printf '%s  %s\n' "${KUBECTL_SHA256}" /usr/local/bin/kubectl | sha256sum --check --strict && \
    chmod 0755 /usr/local/bin/kubectl

RUN curl --fail --location --proto '=https' --tlsv1.2 \
      --output helm.tar.gz \
      "https://get.helm.sh/helm-v${HELM_VERSION}-linux-amd64.tar.gz" && \
    printf '%s  %s\n' "${HELM_SHA256}" helm.tar.gz | sha256sum --check --strict && \
    tar --extract --gzip --file helm.tar.gz && \
    install -m 0755 linux-amd64/helm /usr/local/bin/helm && \
    rm -rf helm.tar.gz linux-amd64

FROM ${BUILDAH_IMAGE} AS build

COPY --from=tools /usr/local/ /usr/local/

RUN dnf upgrade -y --refresh && \
    dnf install -y gcc-c++ make && \
    dnf clean all && \
    rm -rf /var/cache/dnf

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
COPY setup.ts ./setup.ts
RUN npm run build && \
    npm prune --omit=dev && \
    npm cache clean --force

FROM ${BUILDAH_IMAGE} AS runtime

ARG APP_COMMIT=unknown
ARG APP_VERSION=unknown

LABEL org.opencontainers.image.source="https://github.com/p2ppsr/cars-node" \
      org.opencontainers.image.revision="${APP_COMMIT}" \
      org.opencontainers.image.version="${APP_VERSION}"

RUN dnf upgrade -y --refresh && \
    dnf install -y bash ca-certificates openssl shadow-utils && \
    dnf clean all && \
    rm -rf /var/cache/dnf

COPY --from=tools /usr/local/ /usr/local/

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY wait-for-services.sh /wait-for-services.sh

RUN chmod 0755 /wait-for-services.sh && \
    test "$(node --version)" = "v24.19.0" && \
    test "$(kubectl version --client=true --output=json | node -pe 'JSON.parse(require("fs").readFileSync(0)).clientVersion.gitVersion')" = "v1.34.9" && \
    test "$(helm version --template '{{.Version}}')" = "v3.21.4" && \
    buildah --version | grep -F 'buildah version 1.43.2'

EXPOSE 7777

CMD ["node", "dist/src/server.js"]
