import crypto from 'node:crypto';
import path from 'node:path';

const projectIdPattern = /^[a-f0-9]{32}$/;
const deploymentIdPattern = /^[a-f0-9]{32}$/;

function workspaceSecret(): string {
  const value = process.env.CARS_BUILD_CONTROLLER_TOKEN;
  if (!value || value.length < 32) {
    throw new Error('CARS_BUILD_CONTROLLER_TOKEN must contain at least 32 characters');
  }
  return value;
}

/**
 * Return an opaque, server-authenticated scratch path for one deployment.
 *
 * Request identifiers are deliberately never interpolated into filesystem
 * paths. The HMAC also prevents one tenant from predicting another tenant's
 * in-flight workspace name when the shared scratch volume is inspected from a
 * compromised build.
 */
export function deploymentWorkspaceRoot(projectId: string, deploymentId: string): string {
  if (!projectIdPattern.test(projectId)) throw new Error('Invalid project id');
  if (!deploymentIdPattern.test(deploymentId)) throw new Error('Invalid deployment id');
  const workspaceId = crypto
    .createHmac('sha256', workspaceSecret())
    .update('cars-deployment-workspace\0')
    .update(projectId)
    .update('\0')
    .update(deploymentId)
    .digest('hex');
  return path.join('/tmp', `cars-workspace-${workspaceId}`);
}
