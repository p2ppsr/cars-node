import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const projects = await knex('projects')
    .select('id', 'frontend_custom_domain', 'backend_custom_domain')
    .whereNotNull('frontend_custom_domain')
    .orWhereNotNull('backend_custom_domain');
  const claims = new Map<string, number>();
  for (const project of projects) {
    for (const rawDomain of [project.frontend_custom_domain, project.backend_custom_domain]) {
      if (!rawDomain) continue;
      const domain = String(rawDomain).toLowerCase();
      const existing = claims.get(domain);
      if (existing != null && existing !== Number(project.id)) {
        throw new Error(`Custom domain ${domain} is already assigned to multiple CARS projects`);
      }
      claims.set(domain, Number(project.id));
    }
  }

  await knex.schema.createTable('cars_domain_claims', table => {
    table.string('domain', 253).primary();
    table.integer('project_id').unsigned().notNullable()
      .references('id').inTable('projects').onDelete('CASCADE').index();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });
  if (claims.size > 0) {
    await knex('cars_domain_claims').insert(
      [...claims].map(([domain, project_id]) => ({ domain, project_id })),
    );
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('cars_domain_claims');
}
