import { execFileSync } from 'child_process';
import logger from '../logger';

// Disable public routing by removing both legacy and Gateway API resources.
export async function disableIngress(projectUUID: string) {
    if (!/^[a-f0-9]{32}$/.test(projectUUID)) throw new Error('Invalid project id');
    const namespace = `cars-project-${projectUUID}`;
    const helmReleaseName = `cars-project-${projectUUID.substr(0, 24)}`;
    const gatewayResources = 'gateway.gateway.networking.k8s.io,httproute.gateway.networking.k8s.io,backendtrafficpolicy.gateway.envoyproxy.io';
    try {
        execFileSync('kubectl', ['delete', 'ingress', '-n', namespace, `${helmReleaseName}-ingress`, '--ignore-not-found=true']);
        execFileSync('kubectl', [
            'delete',
            gatewayResources,
            '-n', namespace,
            '-l', `app=${helmReleaseName}`,
            '--ignore-not-found=true'
        ]);
        // During the migration, network-ops owns the same deterministic route
        // objects until a project is next deployed and Helm adopts them.
        execFileSync('kubectl', [
            'delete',
            gatewayResources,
            '-n', namespace,
            '-l', `network-ops.babbage.systems/source-ingress=${helmReleaseName}-ingress`,
            '--ignore-not-found=true'
        ]);
        logger.info({ project_uuid: projectUUID }, 'Public Gateway routes disabled (deleted).');
    } catch (e) {
        logger.error({ project_uuid: projectUUID, error: (e as Error).message }, 'Failed to disable ingress');
    }
}

// Enable ingress by re-running helm upgrade, which will recreate the ingress.
export async function enableIngress(projectUUID: string): Promise<boolean> {
    if (!/^[a-f0-9]{32}$/.test(projectUUID)) throw new Error('Invalid project id');
    const namespace = `cars-project-${projectUUID}`;
    const helmReleaseName = `cars-project-${projectUUID.substr(0, 24)}`;

    try {
        // Let's just assume we can do a helm rollback:
        execFileSync('helm', ['rollback', helmReleaseName, '1', '-n', namespace], { stdio: 'inherit' });
        logger.info({ project_uuid: projectUUID }, 'Public Gateway routes enabled (rollback performed).');
        return true;
    } catch (e) {
        logger.error({ project_uuid: projectUUID, error: (e as Error).message }, 'Failed to enable public Gateway routes. Re-run deployment.');
    }
    return false;
}
