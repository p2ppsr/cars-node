import Knex from 'knex';
import db from './db';

export function advisoryConnection(connection: any, host: string) {
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/.test(host)) {
    throw new Error('Invalid CARS_ADVISORY_MYSQL_HOST');
  }
  if (typeof connection === 'string') {
    let value: URL;
    try { value = new URL(connection); }
    catch { throw new Error('Invalid SQL connection configuration for advisory locks'); }
    value.hostname = host;
    return value.toString();
  }
  if (!connection || typeof connection !== 'object') throw new Error('Unsupported SQL connection configuration');
  return { ...connection, host };
}

// Named MySQL locks are local to one mysqld, even in Galera. Operators can
// retain one explicit authority while ordinary data pools change proxies.
const authority = process.env.CARS_ADVISORY_MYSQL_HOST;
export const advisoryDb = authority ? Knex({
  ...db.client.config,
  connection: advisoryConnection(db.client.config.connection, authority),
  pool: { min: 0, max: 4 },
  acquireConnectionTimeout: 5000,
}) : db;
