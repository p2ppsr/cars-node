import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
    await knex.schema.createTable('auth_sessions', table => {
        table.string('sessionNonce', 64).primary();
        table.string('peerNonce', 64).nullable();
        table.string('peerIdentityKey', 130).nullable();
        table.boolean('isAuthenticated').notNullable();
        table.bigInteger('lastUpdate').notNullable();
        table.boolean('certificatesRequired').nullable();
        table.boolean('certificatesValidated').nullable();
        table.bigInteger('expiresAt').notNullable();
        table.index(['peerIdentityKey', 'lastUpdate'], 'idx_auth_sessions_identity_updated');
        table.index('expiresAt', 'idx_auth_sessions_expires');
    });
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists('auth_sessions');
}
