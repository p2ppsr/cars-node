/** Opt-in Node services; existing OverlayExpress projects retain their runtime. */
export interface NodeApplicationRuntime {
  runtime: 'node';
  entrypoint: string;
  frontendProxy?: string[];
}

export function nodeApplicationRuntime(info: {
  backend?: unknown;
  contracts?: unknown;
  topicManagers?: Record<string, unknown>;
  lookupServices?: Record<string, unknown>;
}): NodeApplicationRuntime | undefined {
  const value = info.backend as NodeApplicationRuntime | undefined;
  if (!value || !Object.hasOwn(value, 'runtime')) return undefined;
  if (!value || value.runtime !== 'node' || Object.keys(value).some(key => !['runtime','entrypoint','frontendProxy'].includes(key)))
    throw new Error('Unsupported backend runtime configuration');
  if (typeof value.entrypoint !== 'string' || !/^\.\/src\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.mjs$/.test(value.entrypoint))
    throw new Error('Node entrypoint must be an ESM file inside backend/src');
  if (info.contracts || Object.keys(info.topicManagers || {}).length || Object.keys(info.lookupServices || {}).length)
    throw new Error('Node services cannot advertise OverlayExpress capabilities');
  const paths = validateFrontendProxyPaths(value.frontendProxy ?? []);
  return { runtime: 'node', entrypoint: value.entrypoint, frontendProxy: paths };
}

export function validateFrontendProxyPaths(paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length > 8 || new Set(paths).size !== paths.length || paths.some(path =>
    typeof path !== 'string' || !/^\/[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.-]+)*\/?$/.test(path) || path.includes('..')))
    throw new Error('Invalid same-pod frontend proxy paths');
  return [...paths];
}

export function generateNodeEntrypoint(runtime: NodeApplicationRuntime): string {
  // Fixed platform listener; application code is still confined to the tenant pod.
  return `process.env.PORT = '8080';\nawait import(${JSON.stringify(runtime.entrypoint)});\n`;
}

export function generateNodePackageJson(dependencies: Record<string, string>) {
  return { name:'cars-node-application', version:'1.0.0', private:true, type:'module', scripts:{start:'tsx index.ts'},
    dependencies:{tsx:'4.19.2',...dependencies} };
}

export function generateNodeDockerfile(): string {
  return `FROM docker.io/node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
WORKDIR /app
COPY ./package.json .
RUN npm install --omit=dev --ignore-scripts
COPY ./index.ts ./tsconfig.json ./
COPY ./src ./src
USER node
EXPOSE 8080
CMD ["npm", "run", "start"]
`;
}
