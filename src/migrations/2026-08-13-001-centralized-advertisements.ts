import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('projects', table => {
    table.string('private_key', 64).nullable().alter();
  });

  await knex.schema.createTable('cars_advertised_capabilities', table => {
    table.bigIncrements('id').primary();
    table.integer('project_id').unsigned().notNullable().references('id').inTable('projects').onDelete('CASCADE');
    table.integer('deploy_id').unsigned().nullable().references('id').inTable('deploys').onDelete('SET NULL');
    table.string('network', 12).notNullable();
    table.enum('protocol', ['SHIP', 'SLAP']).notNullable();
    table.string('domain', 255).notNullable();
    table.string('capability', 255).notNullable();
    table.boolean('active').notNullable().defaultTo(true);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.unique(['project_id', 'protocol', 'domain', 'capability'], { indexName: 'cars_capability_project_protocol_domain_name_uq' });
    table.index(['network', 'active'], 'cars_capability_network_active_idx');
  });

  await knex.schema.createTable('cars_advertisement_operations', table => {
    table.bigIncrements('id').primary();
    table.enum('action', ['create', 'revoke']).notNullable();
    table.string('network', 12).notNullable();
    table.string('identity_key', 66).notNullable();
    table.enum('protocol', ['SHIP', 'SLAP']).notNullable();
    table.string('domain', 255).notNullable();
    table.string('capability', 255).notNullable();
    table.string('txid', 64).nullable();
    table.enum('status', ['pending', 'succeeded', 'failed']).notNullable().defaultTo('pending');
    table.integer('attempts').unsigned().notNullable().defaultTo(1);
    table.text('error').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.index(['status', 'created_at'], 'cars_ad_operation_status_created_idx');
    table.index(['identity_key', 'protocol', 'domain', 'capability'], 'cars_ad_operation_capability_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('cars_advertisement_operations');
  await knex.schema.dropTableIfExists('cars_advertised_capabilities');
  await knex.schema.alterTable('projects', table => {
    table.string('private_key', 64).notNullable().alter();
  });
}
