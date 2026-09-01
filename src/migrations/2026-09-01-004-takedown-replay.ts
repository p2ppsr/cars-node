import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('cars_takedown_operations', table => {
    table.string('operation_id', 64).primary();
    table.enum('status', ['pending', 'succeeded', 'failed']).notNullable().defaultTo('pending').index();
    table.integer('attempts').unsigned().notNullable().defaultTo(1);
    table.text('error').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now()).index();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('cars_takedown_operations');
}
