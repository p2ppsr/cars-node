import path from 'path';

/**
 * The shape of the "deployment-info.json" used by CARS
 */
export interface CARSConfigInfo {
  schema: string;
  schemaVersion: string;
  topicManagers?: Record<string, string>;
  lookupServices?: Record<string, { serviceFactory: string; hydrateWith?: string }>;
  frontend?: { language: string; sourceDirectory: string };
  contracts?: { language: string; baseDirectory: string };
  configs?: CARSConfig[];
}

export interface CARSConfig {
  provider: string;
  projectID?: string;
  deploy?: string[];
  network?: string;
}

/**
 * generateIndexTs:
 * Produces a TypeScript file used as the "main" entrypoint in the
 * OverlayExpress container. We inject environment variables and
 * advanced engine config alignment so that the final server
 * respects the new features (adminBearerToken, sync config, etc.).
 */
export function generateIndexTs(info: CARSConfigInfo): string {
  const topicManagerNames = JSON.stringify(Object.keys(info.topicManagers || {}));
  const lookupServiceNames = JSON.stringify(Object.keys(info.lookupServices || {}));
  let imports = `
import OverlayExpress from '@bsv/overlay-express'
`;

  let mainFunction = `
const main = async () => {
  // Construct the OverlayExpress instance, including the admin bearer token if provided:
  const server = new OverlayExpress(
    \`CARS\`,
    process.env.SERVER_PRIVATE_KEY!,
    process.env.HOSTING_URL!,
    process.env.ADMIN_BEARER_TOKEN // 4th param is optional
  );

  // Basic server config
  server.configurePort(8080);
  server.configureVerboseRequestLogging(process.env.REQUEST_LOGGING === 'true');
  server.configureNetwork(process.env.NETWORK === 'mainnet' ? 'main' : 'test');

  // Databases
  await server.configureKnex(process.env.KNEX_URL!);
  await server.configureMongo(process.env.MONGO_URL!);

  // GASP enable/disable
  server.configureEnableGASPSync(process.env.GASP_SYNC === 'true');

  // ARC (TAAL) API key
  if (process.env.ARC_API_KEY) {
    server.configureArcApiKey(process.env.ARC_API_KEY!);
  }

  // If a WebUI config is set, parse it and configure
  if (process.env.WEB_UI_CONFIG) {
    try {
      server.configureWebUI(JSON.parse(process.env.WEB_UI_CONFIG!));
    } catch (e) {
      console.error('Failed to parse WEB_UI_CONFIG:', e);
    }
  }

  // Additional advanced engine config
  const logTime = process.env.LOG_TIME === 'true';
  const logPrefix = process.env.LOG_PREFIX || '[CARS ENGINE] ';
  const throwOnBroadcastFailure = process.env.THROW_ON_BROADCAST_FAIL === 'true';
  const suppressDefaultSyncAdvertisements = process.env.SUPPRESS_DEFAULT_SYNC_ADVERTISEMENTS !== 'false'; // defaults to true
  let parsedSyncConfig = {};
  if (process.env.SYNC_CONFIG_JSON) {
    try {
      parsedSyncConfig = JSON.parse(process.env.SYNC_CONFIG_JSON);
    } catch(e) {
      console.error('Failed to parse SYNC_CONFIG_JSON:', e);
    }
  }

  // Combine advanced options into EngineConfig
  server.configureEngineParams({
    logTime,
    logPrefix,
    throwOnBroadcastFailure,
    suppressDefaultSyncAdvertisements,
    syncConfiguration: parsedSyncConfig
  });
`;

  // For each Topic Manager in the deployment-info.json
  for (const [name, pathToTm] of Object.entries(info.topicManagers || {})) {
    const importName = `tm_${name}`;
    // Adjust path so it’s importable from inside the container
    const pathToTmInContainer = pathToTm.replace('/backend', '');
    imports += `import ${importName} from '${pathToTmInContainer}'\n`;
    mainFunction += `  server.configureTopicManager('${name}', new ${importName}());\n`;
  }

  // For each Lookup Service in the deployment-info.json
  for (const [name, lsConfig] of Object.entries(info.lookupServices || {})) {
    const importName = `lsf_${name}`;
    const pathToLsInContainer = lsConfig.serviceFactory.replace('/backend', '');
    imports += `import ${importName} from '${pathToLsInContainer}'\n`;
    if (lsConfig.hydrateWith === 'mongo') {
      mainFunction += `  server.configureLookupServiceWithMongo('${name}', ${importName});\n`;
    } else if (lsConfig.hydrateWith === 'knex') {
      mainFunction += `  server.configureLookupServiceWithKnex('${name}', ${importName});\n`;
    } else {
      // If neither mongo nor knex is specified, assume a direct factory
      mainFunction += `  server.configureLookupService('${name}', ${importName}());\n`;
    }
  }

  // Conclude
  mainFunction += `
  server.configureHealth({
    contextProvider: async () => ({
      serviceType: 'cars-project-backend',
      hostingUrl: process.env.HOSTING_URL,
      network: process.env.NETWORK,
      gaspSyncEnabled: process.env.GASP_SYNC === 'true',
      topicManagers: ${topicManagerNames},
      lookupServices: ${lookupServiceNames}
    })
  });
  await server.configureEngine();
  await server.start();
};

main()`;

  // Return the entire file as a string
  return imports + mainFunction;
}

/**
 * generatePackageJson:
 * Produces a minimal package.json so the container can install dependencies
 * (including overlay-express) at build time.
 */
export function generatePackageJson(backendDependencies: Record<string, string>) {
  const packageJsonContent = {
    "name": "overlay-express-dev",
    "version": "1.0.0",
    "description": "",
    "main": "index.ts",
    "scripts": {
      "start": "tsx index.ts"
    },
    "keywords": [],
    "author": "",
    "license": "ISC",
    "dependencies": {
      ...backendDependencies,
      "@bsv/overlay-express": "^2.2.0",
      "mysql2": "^3.11.5",
      "tsx": "^4.19.2",
      "chalk": "^5.3.0"
    },
    "devDependencies": {
      "@types/node": "^22.10.1"
    }
  };
  return packageJsonContent;
}

/**
 * generateDockerfile:
 * Produces a Dockerfile for building the backend environment
 * with optional contract artifacts if "enableContracts" is true.
 */
export function generateDockerfile(enableContracts: boolean) {
  let file = `FROM docker.io/node:22-alpine
WORKDIR /app
COPY ./package.json .
RUN npm i
COPY ./index.ts .
COPY ./safe-access-logger.cjs .
COPY ./tsconfig.json .
COPY ./wait-for-services.sh /wait-for-services.sh
RUN chmod +x /wait-for-services.sh`
  if (enableContracts) {
    file += `
COPY ./artifacts ./artifacts`
  }
  file += `
COPY ./src ./src

EXPOSE 8080
CMD ["/wait-for-services.sh", "mysql", "3306", "mongo", "27017", "npm", "run", "start"]`;
  return file;
}

/**
 * generateTsConfig:
 * Just a minimal tsconfig enabling decorators as required by overlay.
 */
export function generateTsConfig() {
  return `{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}`;
}

/**
 * generateWaitScript:
 * A script that waits for MySQL and Mongo containers to come up
 * before starting the Node process.
 */
export function generateWaitScript() {
  return `#!/bin/sh

set -e

if [ "\${SAFE_REQUEST_LOGGING:-false}" = "true" ]; then
  export NODE_OPTIONS="--require=/app/safe-access-logger.cjs \${NODE_OPTIONS:-}"
fi

host1="\${MYSQL_WAIT_HOST:-\${1:-mysql}}"
port1="\${MYSQL_WAIT_PORT:-\${2:-3306}}"
host2="\${MONGO_WAIT_HOST:-\${3:-mongo}}"
port2="\${MONGO_WAIT_PORT:-\${4:-27017}}"
shift 4

echo "Waiting for $host1:$port1..."
while ! nc -z $host1 $port1; do
  sleep 1
done
echo "$host1:$port1 is up"

echo "Waiting for $host2:$port2..."
while ! nc -z $host2 $port2; do
  sleep 1
done
echo "$host2:$port2 is up"

exec "$@"`
}

export function generateSafeAccessLoggerCjs() {
  return `'use strict';

if (process.env.SAFE_REQUEST_LOGGING === 'true') {
  const crypto = require('crypto');
  const express = require('express');

  if (!express.application.__carsSafeAccessPatched) {
    express.application.__carsSafeAccessPatched = true;
    const originalUse = express.application.use;

    const byteLength = (value) => {
      if (value == null) return 0;
      if (Buffer.isBuffer(value)) return value.length;
      if (typeof value === 'string') return Buffer.byteLength(value);
      try {
        return Buffer.byteLength(JSON.stringify(value));
      } catch {
        return 0;
      }
    };

    const stableJson = (value) => {
      const normalize = (input) => {
        if (!input || typeof input !== 'object') return input;
        if (Array.isArray(input)) return input.map(normalize);
        return Object.keys(input).sort().reduce((result, key) => {
          result[key] = normalize(input[key]);
          return result;
        }, {});
      };
      try {
        return JSON.stringify(normalize(value));
      } catch {
        return '';
      }
    };

    const hashValue = (value) => {
      const json = stableJson(value);
      return json ? crypto.createHash('sha256').update(json).digest('hex') : undefined;
    };

    const firstIp = (req) => {
      const forwarded = req.headers && req.headers['x-forwarded-for'];
      if (Array.isArray(forwarded)) return String(forwarded[0]).split(',')[0].trim();
      if (forwarded) return String(forwarded).split(',')[0].trim();
      return req.ip || (req.socket && req.socket.remoteAddress);
    };

    const collectResponseInfo = (bytes, chunks, truncated) => {
      const info = { bytes };
      if (truncated) return info;
      const text = Buffer.concat(chunks.map((chunk) => (
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      ))).toString('utf8');

      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          info.outputCount = parsed.length;
        } else if (Array.isArray(parsed && parsed.outputs)) {
          info.outputCount = parsed.outputs.length;
        } else if (Array.isArray(parsed && parsed.results)) {
          info.outputCount = parsed.results.length;
        } else if (Array.isArray(parsed && parsed.outputList)) {
          info.outputCount = parsed.outputList.length;
        }
      } catch {
        // Response bodies are intentionally not logged.
      }
      return info;
    };

    const safeAccessMiddleware = (req, res, next) => {
      const route = (req.path || req.originalUrl || '').split('?')[0];
      if (route !== '/lookup' && route !== '/submit') return next();

      const started = Date.now();
      const responseCaptureLimit = 2 * 1024 * 1024;
      let responseBytes = 0;
      let responseCaptureBytes = 0;
      let responseTruncated = false;
      const responseChunks = [];
      const originalWrite = res.write;
      const originalEnd = res.end;
      const captureChunk = (chunk, encoding) => {
        if (!chunk) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : undefined);
        responseBytes += buffer.length;
        if (responseCaptureBytes >= responseCaptureLimit) {
          responseTruncated = true;
          return;
        }
        const remaining = responseCaptureLimit - responseCaptureBytes;
        if (buffer.length > remaining) {
          responseChunks.push(buffer.subarray(0, remaining));
          responseCaptureBytes += remaining;
          responseTruncated = true;
        } else {
          responseChunks.push(buffer);
          responseCaptureBytes += buffer.length;
        }
      };

      res.write = function patchedWrite(chunk, encoding, callback) {
        captureChunk(chunk, encoding);
        return originalWrite.call(this, chunk, encoding, callback);
      };

      res.end = function patchedEnd(chunk, encoding, callback) {
        captureChunk(chunk, encoding);
        return originalEnd.call(this, chunk, encoding, callback);
      };

      res.on('finish', () => {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const query = body.query && typeof body.query === 'object' ? body.query : undefined;
        const responseInfo = collectResponseInfo(responseBytes, responseChunks, responseTruncated);
        const record = {
          source: 'cars-safe-access',
          ts: new Date().toISOString(),
          method: req.method,
          route,
          remote: firstIp(req),
          userAgent: String((req.headers && req.headers['user-agent']) || '').slice(0, 120),
          requestBytes: Number(req.headers && req.headers['content-length']) || byteLength(body),
          statusCode: res.statusCode,
          durationMs: Date.now() - started,
          responseBytes: responseInfo.bytes
        };

        if (route === '/lookup') {
          record.service = body.service || body.lookupService || body.serviceName;
          record.queryKeys = query ? Object.keys(query).sort() : [];
          record.queryHash = query ? hashValue(query) : undefined;
          record.queryBytes = query ? byteLength(query) : 0;
          record.outputCount = responseInfo.outputCount;
        } else if (route === '/submit') {
          const topics = Array.isArray(body.topics) ? body.topics : (body.topic ? [body.topic] : []);
          record.topics = topics.map((topic) => String(topic)).sort();
          record.topicCount = topics.length;
          record.bodyBytes = byteLength(body);
          record.includesOffChainValues = Boolean(body.offChainValues || body.offChain);
        }

        console.log('CARS_SAFE_ACCESS ' + JSON.stringify(record));
      });

      next();
    };

    express.application.use = function patchedUse(...args) {
      if (!this.__carsSafeAccessMiddlewareInstalled) {
        this.__carsSafeAccessMiddlewareInstalled = true;
        originalUse.call(this, safeAccessMiddleware);
      }
      return originalUse.apply(this, args);
    };

    console.log('CARS_SAFE_ACCESS instrumentation installed');
  }
}
`;
}
