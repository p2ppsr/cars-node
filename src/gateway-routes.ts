import { createHash } from 'crypto';

export interface ProjectGatewayOptions {
  projectUuid: string;
  releaseName: string;
  frontendEnabled: boolean;
  backendEnabled: boolean;
  frontendHost: string;
  backendHost: string;
  frontendCustomDomain?: string | null;
  backendCustomDomain?: string | null;
}

export function gatewayObjectName(prefix: string, ...parts: string[]): string {
  const raw = [prefix, ...parts].join('-').toLowerCase();
  const slug = raw.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 10);
  return `${slug.slice(0, 52).replace(/-+$/g, '')}-${digest}`;
}

function listenerName(host: string, protocol: 'http' | 'https'): string {
  return `${protocol}-${createHash('sha256').update(host).digest('hex').slice(0, 10)}`;
}

function routeResources(options: ProjectGatewayOptions, gatewayName: string, host: string, port: 80 | 8080): string {
  const ingressName = `${options.releaseName}-ingress`;
  const httpRouteName = gatewayObjectName('route', ingressName, host, 'http');
  const httpsRouteName = gatewayObjectName('route', ingressName, host, 'https');
  const trafficPolicyName = gatewayObjectName('traffic', httpsRouteName);
  const frontendOnly = port === 80 && options.frontendEnabled && !options.backendEnabled;
  const retry = frontendOnly
    ? `
  retry:
    numRetries: 1
    perRetry:
      timeout: 2s
    retryOn:
      httpStatusCodes: [502, 503, 504]
      triggers: [connect-failure, reset, retriable-status-codes]`
    : '';

  return `apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: ${httpRouteName}
  labels:
    app: ${options.releaseName}
    created-by: cars
spec:
  parentRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: ${gatewayName}
      sectionName: ${listenerName(host, 'http')}
  hostnames: [${JSON.stringify(host)}]
  rules:
    - filters:
        - type: RequestRedirect
          requestRedirect:
            scheme: https
            statusCode: 308
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: ${httpsRouteName}
  labels:
    app: ${options.releaseName}
    created-by: cars
spec:
  parentRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: ${gatewayName}
      sectionName: ${listenerName(host, 'https')}
  hostnames: [${JSON.stringify(host)}]
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      filters:
        - type: ResponseHeaderModifier
          responseHeaderModifier:
            set:
              - name: strict-transport-security
                value: max-age=31536000; includeSubDomains
      backendRefs:
        - group: ""
          kind: Service
          name: ${options.releaseName}-service
          port: ${port}
          weight: 1
---
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: ${trafficPolicyName}
  labels:
    app: ${options.releaseName}
    created-by: cars
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      name: ${httpsRouteName}
  timeout:
    http:
      streamIdleTimeout: 21600s
    tcp:
      connectTimeout: ${frontendOnly ? 1 : 300}s
  compressor:
    - type: Gzip
      gzip: {}
      minContentLength: 1024
  loadBalancer:
    type: ConsistentHash
    consistentHash:
      type: Cookie
      cookie:
        name: route
        ttl: 86400s${retry}
`;
}

export function buildProjectGatewayResources(options: ProjectGatewayOptions): string {
  if (!options.frontendEnabled && !options.backendEnabled) {
    throw new Error('project Gateway requires a frontend or backend');
  }
  const records: Array<{ host: string; secret: string; port: 80 | 8080 }> = [];
  if (options.frontendEnabled) {
    records.push({ host: options.frontendHost, secret: `project-${options.projectUuid}-tls`, port: 80 });
    if (options.frontendCustomDomain?.trim()) {
      records.push({
        host: options.frontendCustomDomain.trim(),
        secret: `project-${options.projectUuid}-frontend-custom-tls`,
        port: 80,
      });
    }
  }
  if (options.backendEnabled) {
    records.push({ host: options.backendHost, secret: `project-${options.projectUuid}-tls`, port: 8080 });
    if (options.backendCustomDomain?.trim()) {
      records.push({
        host: options.backendCustomDomain.trim(),
        secret: `project-${options.projectUuid}-backend-custom-tls`,
        port: 8080,
      });
    }
  }
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.host)) {
      throw new Error(`frontend and backend cannot share Gateway hostname ${record.host}`);
    }
    seen.add(record.host);
  }
  const gatewayName = `${options.releaseName}-gateway`;
  const listeners = records.map(record => `    - name: ${listenerName(record.host, 'http')}
      hostname: ${JSON.stringify(record.host)}
      port: 80
      protocol: HTTP
      allowedRoutes:
        namespaces:
          from: All
    - name: ${listenerName(record.host, 'https')}
      hostname: ${JSON.stringify(record.host)}
      port: 443
      protocol: HTTPS
      allowedRoutes:
        namespaces:
          from: All
      tls:
        mode: Terminate
        certificateRefs:
          - group: ""
            kind: Secret
            name: ${record.secret}
`).join('');
  const gateway = `apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: ${gatewayName}
  labels:
    app: ${options.releaseName}
    created-by: cars
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-production
spec:
  gatewayClassName: evans-envoy-private-pilot
  listeners:
${listeners}`;
  return `${gateway}---\n${records.map(record => routeResources(options, gatewayName, record.host, record.port)).join('---\n')}`;
}
