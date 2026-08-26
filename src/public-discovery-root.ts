const DEFAULT_PUBLIC_DISCOVERY_ROOTS = ['users.bapp.dev'];

function normalizeHost(value: string): string {
  const candidate = value.trim().toLowerCase();
  if (!candidate) return '';
  try {
    return new URL(candidate.includes('://') ? candidate : `https://${candidate}`).hostname;
  } catch {
    return candidate.replace(/^https?:\/\//, '').split('/')[0].split(':')[0].replace(/\.$/, '');
  }
}

/**
 * Public discovery roots are compatibility/bootstrap services, not
 * advertisement owners. The centralized controller remains the only writer.
 */
export function isPublicDiscoveryRoot(
  domain: string | null | undefined,
  configuredRoots = process.env.CARS_PUBLIC_DISCOVERY_ROOT_DOMAINS,
): boolean {
  const host = normalizeHost(domain || '');
  if (!host) return false;
  const roots = (configuredRoots || DEFAULT_PUBLIC_DISCOVERY_ROOTS.join(','))
    .split(',')
    .map(normalizeHost)
    .filter(Boolean);
  return roots.includes(host);
}

