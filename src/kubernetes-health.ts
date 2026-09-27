import { readFileSync } from 'node:fs';
import { Agent, request } from 'node:https';

// Keep the same namespace/RBAC check and absolute deadline, without starting a
// kubectl process and a new TLS session on every in-cluster health collection.
export function createKubernetesNamespaceReader(options: {
    host: string;
    port: number;
    serviceAccountDirectory: string;
    timeoutMs: () => number;
}) {
    const root = options.serviceAccountDirectory.replace(/\/$/, '');
    const agent = new Agent({
        keepAlive: true,
        maxSockets: 2,
        ca: readFileSync(`${root}/ca.crt`),
    });
    return {
        close: () => agent.destroy(),
        read: () => new Promise<any>((resolve, reject) => {
            // Projected tokens rotate. Read the current token for each request;
            // never log it or include response bodies in health errors.
            const token = readFileSync(`${root}/token`, 'utf8').trim();
            const req = request({
                hostname: options.host,
                port: options.port,
                path: '/api/v1/namespaces/cars-operator-system',
                method: 'GET',
                agent,
                headers: { authorization: `Bearer ${token}` },
            }, response => {
                if (response.statusCode !== 200) {
                    response.resume();
                    req.destroy(new Error(`Kubernetes namespace health returned HTTP ${response.statusCode}`));
                    return;
                }
                const chunks: Buffer[] = [];
                let bytes = 0;
                response.on('data', chunk => {
                    bytes += chunk.length;
                    if (bytes > 1024 * 1024) {
                        req.destroy(new Error('Kubernetes namespace health response exceeded 1 MiB'));
                        return;
                    }
                    chunks.push(Buffer.from(chunk));
                });
                response.on('error', reject);
                response.on('aborted', () => reject(new Error('Kubernetes namespace health response was interrupted')));
                response.on('end', () => {
                    clearTimeout(deadline);
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                    } catch {
                        reject(new Error('Kubernetes namespace health returned invalid JSON'));
                    }
                });
            });
            const deadline = setTimeout(() => {
                req.destroy(new Error('Kubernetes namespace health request timed out'));
            }, options.timeoutMs());
            req.on('error', reject);
            req.on('close', () => clearTimeout(deadline));
            req.end();
        }),
    };
}
