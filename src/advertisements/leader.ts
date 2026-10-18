import type { Knex } from 'knex';

/** A cached connection is not proof that its server-local named lock survived. */
export class MySqlLeaderLease {
  private connection: any;
  isLeader = false;

  constructor(private readonly knex: Knex, private readonly lockName: string) {}

  async acquire(): Promise<boolean> {
    if (this.connection) {
      const connection = this.connection;
      try {
        const query = typeof connection.promise === 'function' ? connection.promise() : connection;
        const [rows] = await query.query('SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS owned', [this.lockName]);
        if (Number(rows?.[0]?.owned) === 1) return true;
      } catch (error) {
        this.connection = undefined;
        this.isLeader = false;
        // Knex validates this flag before reusing a released pool resource.
        connection.__knex__disposed = true;
        await this.knex.client.releaseConnection(connection);
        throw error;
      }
      this.connection = undefined;
      this.isLeader = false;
      await this.knex.client.releaseConnection(connection);
      return false;
    }
    const connection = await this.knex.client.acquireConnection();
    const query = typeof connection.promise === 'function' ? connection.promise() : connection;
    try {
      const [rows] = await query.query('SELECT GET_LOCK(?, 0) AS acquired', [this.lockName]);
      this.isLeader = Number(rows?.[0]?.acquired) === 1;
      if (this.isLeader) this.connection = connection;
      else await this.knex.client.releaseConnection(connection);
      return this.isLeader;
    } catch (error) {
      this.isLeader = false;
      connection.__knex__disposed = true;
      await this.knex.client.releaseConnection(connection);
      throw error;
    }
  }

  async release(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.isLeader = false;
    if (!connection) return;
    try {
      const query = typeof connection.promise === 'function' ? connection.promise() : connection;
      await query.query('SELECT RELEASE_LOCK(?)', [this.lockName]);
      await this.knex.client.releaseConnection(connection);
    } catch (error) {
      connection.__knex__disposed = true;
      await this.knex.client.releaseConnection(connection);
      throw error;
    }
  }
}
