import crypto from 'crypto';
import { execFileSync } from 'child_process';
import mysql from 'mysql2/promise';
import { MongoClient } from 'mongodb';

export type ProjectDbMode = 'shared' | 'legacy-per-project';

export interface SharedDbConfig {
  namespace: string;
  mysqlAdminUrl?: string;
  mysqlAppHost: string;
  mongoAdminUrl?: string;
  mongoAppHosts: string;
  mongoReplicaSetName: string;
  mongoAdditionalDatabases: string[];
}

export interface ProjectDbCredentials {
  mysqlDatabase: string;
  mongoDatabase: string;
  user: string;
  mysqlPassword: string;
  mongoPassword: string;
  knexUrl: string;
  mongoUrl: string;
  mysqlWaitHost: string;
  mongoWaitHost: string;
}

export function getProjectDbMode(): ProjectDbMode {
  const mode = process.env.CARS_PROJECT_DB_MODE || 'shared';
  if (mode === 'shared' || mode === 'legacy-per-project') {
    return mode;
  }
  throw new Error(`Invalid CARS_PROJECT_DB_MODE=${mode}; expected shared or legacy-per-project`);
}

export function getSharedDbConfig(): SharedDbConfig {
  const namespace = process.env.SHARED_DB_NAMESPACE || 'cars-operator-system';
  const mongoReplicaSetName = process.env.SHARED_MONGO_REPLICA_SET || 'rs0';
  return {
    namespace,
    mysqlAdminUrl: process.env.SHARED_MYSQL_ADMIN_URL,
    mysqlAppHost: process.env.SHARED_MYSQL_APP_HOST || `shared-mysql-haproxy.${namespace}.svc.cluster.local`,
    mongoAdminUrl: process.env.SHARED_MONGO_ADMIN_URL,
    mongoAppHosts: process.env.SHARED_MONGO_APP_HOSTS ||
      `shared-mongo-0.shared-mongo.${namespace}.svc.cluster.local:27017,shared-mongo-1.shared-mongo.${namespace}.svc.cluster.local:27017`,
    mongoReplicaSetName,
    mongoAdditionalDatabases: parseDatabaseList(process.env.SHARED_MONGO_ADDITIONAL_DATABASES || 'CARS_lookup_services'),
  };
}

export function projectDatabaseName(projectId: string): string {
  assertProjectId(projectId);
  return `cars_project_${projectId}`;
}

export function projectDatabaseUser(projectId: string): string {
  assertProjectId(projectId);
  return `cp_${projectId.substring(0, 24)}`;
}

export function buildProjectDbCredentials(projectId: string, existingSecret?: Record<string, string>): ProjectDbCredentials {
  const config = getSharedDbConfig();
  const mysqlDatabase = projectDatabaseName(projectId);
  const mongoDatabase = projectDatabaseName(projectId);
  const user = projectDatabaseUser(projectId);
  const existingMysqlPassword = extractPasswordFromUrl(existingSecret?.KNEX_URL, user, config.mysqlAppHost);
  const existingMongoPassword = extractPasswordFromUrl(existingSecret?.MONGO_URL, user, config.mongoAppHosts.split(',')[0].split(':')[0]);
  const mysqlPassword = existingMysqlPassword || randomPassword();
  const mongoPassword = existingMongoPassword || randomPassword();
  const mongoWaitHost = config.mongoAppHosts.split(',')[0].split(':')[0];

  return {
    mysqlDatabase,
    mongoDatabase,
    user,
    mysqlPassword,
    mongoPassword,
    knexUrl: `mysql://${encodeURIComponent(user)}:${encodeURIComponent(mysqlPassword)}@${config.mysqlAppHost}:3306/${mysqlDatabase}`,
    mongoUrl: `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(mongoPassword)}@${config.mongoAppHosts}/${mongoDatabase}?replicaSet=${encodeURIComponent(config.mongoReplicaSetName)}&authSource=${encodeURIComponent(mongoDatabase)}&readPreference=primaryPreferred`,
    mysqlWaitHost: config.mysqlAppHost,
    mongoWaitHost,
  };
}

export function readProjectDbSecret(namespace: string, secretName: string): Record<string, string> | undefined {
  try {
    const raw = execFileSync('kubectl', ['-n', namespace, 'get', 'secret', secretName, '-o', 'json'], { encoding: 'utf8' });
    const doc = JSON.parse(raw);
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(doc.data || {})) {
      result[key] = Buffer.from(String(value), 'base64').toString('utf8');
    }
    return result;
  } catch {
    return undefined;
  }
}

export async function ensureSharedProjectDatabases(credentials: ProjectDbCredentials): Promise<void> {
  const config = getSharedDbConfig();
  if (!config.mysqlAdminUrl) {
    throw new Error('SHARED_MYSQL_ADMIN_URL is required when CARS_PROJECT_DB_MODE=shared');
  }
  if (!config.mongoAdminUrl) {
    throw new Error('SHARED_MONGO_ADMIN_URL is required when CARS_PROJECT_DB_MODE=shared');
  }

  await ensureSharedMysqlDatabase(config.mysqlAdminUrl, credentials);
  await ensureSharedMongoDatabase(config.mongoAdminUrl, credentials);
}

async function ensureSharedMysqlDatabase(adminUrl: string, credentials: ProjectDbCredentials): Promise<void> {
  const connection = await mysql.createConnection(adminUrl);
  try {
    const db = mysqlIdentifier(credentials.mysqlDatabase);
    const user = mysqlString(credentials.user);
    const password = mysqlString(credentials.mysqlPassword);
    await connection.query(`CREATE DATABASE IF NOT EXISTS ${db}`);
    await connection.query(`CREATE USER IF NOT EXISTS ${user}@'%' IDENTIFIED BY ${password}`);
    await connection.query(`ALTER USER ${user}@'%' IDENTIFIED BY ${password}`);
    await connection.query(`GRANT ALL PRIVILEGES ON ${db}.* TO ${user}@'%'`);
    await connection.query('FLUSH PRIVILEGES');
  } finally {
    await connection.end();
  }
}

async function ensureSharedMongoDatabase(adminUrl: string, credentials: ProjectDbCredentials): Promise<void> {
  const config = getSharedDbConfig();
  const client = new MongoClient(adminUrl);
  await client.connect();
  try {
    const db = client.db(credentials.mongoDatabase);
    const roles = mongoRoles(credentials.mongoDatabase, config.mongoAdditionalDatabases);
    try {
      await db.command({
        createUser: credentials.user,
        pwd: credentials.mongoPassword,
        roles,
      });
    } catch (error: any) {
      const message = `${String(error?.codeName || '')} ${String(error?.message || '')}`;
      if (!message.includes('Duplicate') && !message.includes('already exists')) {
        throw error;
      }
      const existing = await db.command({ usersInfo: credentials.user });
      await db.command({
        updateUser: credentials.user,
        pwd: credentials.mongoPassword,
        roles: mergeMongoRoles(existing.users?.[0]?.roles || [], roles),
      });
    }
  } finally {
    await client.close();
  }
}

function parseDatabaseList(raw: string): string[] {
  return raw
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => {
      if (!/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new Error(`Unsafe MongoDB database name in SHARED_MONGO_ADDITIONAL_DATABASES: ${value}`);
      }
      return value;
    });
}

function mongoRoles(projectDatabase: string, additionalDatabases: string[]): Array<{ role: string; db: string }> {
  return mergeMongoRoles([], [
    { role: 'readWrite', db: projectDatabase },
    ...additionalDatabases.map(db => ({ role: 'readWrite', db })),
  ]);
}

function mergeMongoRoles(existing: Array<{ role: string; db: string }>, wanted: Array<{ role: string; db: string }>): Array<{ role: string; db: string }> {
  const merged: Array<{ role: string; db: string }> = [];
  for (const role of [...existing, ...wanted]) {
    if (!merged.some(item => item.role === role.role && item.db === role.db)) {
      merged.push({ role: role.role, db: role.db });
    }
  }
  return merged;
}

function assertProjectId(projectId: string): void {
  if (!/^[a-f0-9]{32}$/.test(projectId)) {
    throw new Error(`Invalid CARS project id for shared DB provisioning: ${projectId}`);
  }
}

function randomPassword(): string {
  return crypto.randomBytes(27).toString('base64url');
}

function extractPasswordFromUrl(rawUrl: string | undefined, expectedUser: string, expectedHostHint: string): string | undefined {
  if (!rawUrl) {
    return undefined;
  }
  try {
    const parsed = new URL(rawUrl);
    if (decodeURIComponent(parsed.username) !== expectedUser) {
      return undefined;
    }
    if (!rawUrl.includes(expectedHostHint)) {
      return undefined;
    }
    return decodeURIComponent(parsed.password || '');
  } catch {
    return undefined;
  }
}

function mysqlIdentifier(value: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    throw new Error(`Unsafe MySQL identifier: ${value}`);
  }
  return `\`${value}\``;
}

function mysqlString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
