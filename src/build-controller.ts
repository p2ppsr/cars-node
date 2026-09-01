import logger from './logger';

export type BuildKind = 'frontend' | 'backend';

function controllerToken(): string {
  const token = process.env.CARS_BUILD_CONTROLLER_TOKEN;
  if (!token || token.length < 32) {
    throw new Error('CARS_BUILD_CONTROLLER_TOKEN must contain at least 32 characters');
  }
  return token;
}

function controllerUrl(): string {
  return (process.env.CARS_BUILD_CONTROLLER_URL || 'http://127.0.0.1:7790').replace(/\/$/, '');
}

export async function buildProjectImage(input: {
  kind: BuildKind;
  projectId: string;
  deploymentId: string;
  contextDir: string;
  image: string;
}): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2 * 60 * 60 * 1000);
  try {
    const response = await fetch(`${controllerUrl()}/v1/build`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${controllerToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        typeof payload?.error === 'string'
          ? payload.error
          : `CARS build controller failed with HTTP ${response.status}`,
      );
    }
    if (typeof payload?.image !== 'string' || !/@sha256:[a-f0-9]{64}$/.test(payload.image)) {
      throw new Error('CARS build controller did not return an immutable image reference');
    }
    return payload.image;
  } catch (error: any) {
    const message = error?.name === 'AbortError'
      ? 'CARS build controller request timed out'
      : error?.message || 'CARS build controller is unavailable';
    logger.error({
      projectId: input.projectId,
      deploymentId: input.deploymentId,
      kind: input.kind,
      error: message,
      alert: 'cars.build_controller.failure',
    }, 'CARS image build failed');
    throw new Error(message);
  } finally {
    clearTimeout(timeout);
  }
}
