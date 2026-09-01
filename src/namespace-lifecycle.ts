import logger from './logger';

const PROJECT_ID_PATTERN = /^[a-f0-9]{32}$/;

export interface NamespaceAudit {
  status: 'ok' | 'error';
  expectedProjects: number;
  managedNamespaces: number;
  missingNamespaces: string[];
  orphanNamespaces: string[];
  invalidBindings: string[];
}

export class NamespaceLifecycleError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'NamespaceLifecycleError';
  }
}

export function assertProjectId(projectId: string): void {
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new NamespaceLifecycleError('Invalid CARS project id', 'validate', 400);
  }
}

function lifecycleBaseUrl(): string {
  return (process.env.CARS_NAMESPACE_LIFECYCLE_URL ||
    'http://cars-namespace-lifecycle.cars-operator-system.svc.cluster.local:7780').replace(/\/$/, '');
}

function lifecycleToken(): string {
  const token = process.env.CARS_NAMESPACE_LIFECYCLE_TOKEN;
  if (!token) {
    throw new NamespaceLifecycleError('CARS namespace lifecycle credential is not configured', 'configure');
  }
  return token;
}

function timeoutMs(): number {
  const configured = Number(process.env.CARS_NAMESPACE_LIFECYCLE_TIMEOUT_MS || 30000);
  return Number.isFinite(configured) ? Math.max(1000, Math.min(120000, Math.trunc(configured))) : 30000;
}

async function request(path: string, options: RequestInit = {}, acceptedStatuses: number[] = []): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const response = await fetch(`${lifecycleBaseUrl()}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${lifecycleToken()}`,
        'content-type': 'application/json',
        ...(options.headers || {}),
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok && !acceptedStatuses.includes(response.status)) {
      throw new NamespaceLifecycleError(
        typeof payload?.error === 'string' ? payload.error : `Namespace lifecycle request failed with HTTP ${response.status}`,
        options.method || 'GET',
        response.status,
      );
    }
    return payload;
  } catch (error: any) {
    if (error instanceof NamespaceLifecycleError) {
      throw error;
    }
    const message = error?.name === 'AbortError'
      ? 'Namespace lifecycle request timed out'
      : 'Namespace lifecycle controller is unavailable';
    throw new NamespaceLifecycleError(message, options.method || 'GET');
  } finally {
    clearTimeout(timeout);
  }
}

export async function ensureProjectNamespace(projectId: string): Promise<void> {
  assertProjectId(projectId);
  await request(`/v1/projects/${projectId}`, { method: 'PUT', body: '{}' });
}

export async function deleteProjectNamespace(projectId: string): Promise<void> {
  assertProjectId(projectId);
  await request(`/v1/projects/${projectId}`, { method: 'DELETE' });
}

export async function auditProjectNamespaces(projectIds: string[]): Promise<NamespaceAudit> {
  for (const projectId of projectIds) {
    assertProjectId(projectId);
  }
  const payload = await request('/v1/audit', {
    method: 'POST',
    body: JSON.stringify({ projectIds }),
  }, [409]);
  return payload as NamespaceAudit;
}

export function logLifecycleFailure(error: unknown, context: Record<string, unknown>): void {
  const lifecycleError = error as NamespaceLifecycleError;
  logger.error({
    ...context,
    error: lifecycleError?.message || 'Unknown namespace lifecycle failure',
    operation: lifecycleError?.operation,
    statusCode: lifecycleError?.statusCode,
    alert: 'cars.namespace_lifecycle.failure',
  }, 'CARS namespace lifecycle operation failed');
}
