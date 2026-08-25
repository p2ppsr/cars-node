export interface ProjectIngressTlsOptions {
  projectUuid: string;
  frontendEnabled: boolean;
  backendEnabled: boolean;
  frontendCustomDomain?: string | null;
  backendCustomDomain?: string | null;
}

function tlsBlock(hosts: string[], secretName: string): string {
  const renderedHosts = hosts.map(host => `      - ${host}\n`).join('');
  return `    - hosts:\n${renderedHosts}      secretName: ${secretName}\n`;
}

/**
 * Keep CARS-owned platform names independently renewable from operator-owned
 * custom domains. A custom domain can move away from Evans at any time; it
 * must never prevent cert-manager from renewing the generated platform names.
 */
export function buildProjectIngressTls(options: ProjectIngressTlsOptions): string {
  const platformHosts: string[] = [];
  if (options.frontendEnabled) {
    platformHosts.push('{{ .Values.ingressHostFrontend }}');
  }
  if (options.backendEnabled) {
    platformHosts.push('{{ .Values.ingressHostBackend }}');
  }

  if (platformHosts.length === 0) {
    throw new Error('project ingress TLS requires at least one generated platform host');
  }

  let rendered = tlsBlock(platformHosts, `project-${options.projectUuid}-tls`);
  const frontendCustomDomain = options.frontendCustomDomain?.trim() || '';
  const backendCustomDomain = options.backendCustomDomain?.trim() || '';

  if (
    options.frontendEnabled
    && options.backendEnabled
    && frontendCustomDomain
    && frontendCustomDomain === backendCustomDomain
  ) {
    rendered += tlsBlock(
      ['{{ .Values.ingressCustomFrontend }}'],
      `project-${options.projectUuid}-custom-tls`
    );
    return rendered;
  }

  if (options.frontendEnabled && frontendCustomDomain) {
    rendered += tlsBlock(
      ['{{ .Values.ingressCustomFrontend }}'],
      `project-${options.projectUuid}-frontend-custom-tls`
    );
  }
  if (options.backendEnabled && backendCustomDomain) {
    rendered += tlsBlock(
      ['{{ .Values.ingressCustomBackend }}'],
      `project-${options.projectUuid}-backend-custom-tls`
    );
  }

  return rendered;
}
