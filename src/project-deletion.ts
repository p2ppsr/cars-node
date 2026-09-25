import type { Knex } from 'knex';
import logger from './logger';
import { assertProjectId, deleteProjectNamespace } from './namespace-lifecycle';
import { sendAdminNotificationEmail } from './utils/email';

// Only an explicitly authorized, recent deletion may explain resources being
// absent during teardown. A stalled deletion still fails the drift gate.
export const DELETION_TRANSITION_MS = 5 * 60_000;

export function activeDeletionIds(projects: any[], now = Date.now()): string[] {
  return projects.filter(project => {
    if (!project.deletion_requested_at) return false;
    const requested = new Date(project.deletion_requested_at).getTime();
    return Number.isFinite(requested) && requested <= now && now - requested < DELETION_TRANSITION_MS;
  }).map(project => String(project.project_uuid));
}

export async function requestProjectDeletion(db: Knex, projectId: string, identityKey: string): Promise<void> {
  assertProjectId(projectId);
  // A repeated request must not extend the bounded transition indefinitely.
  await db('projects').where({ project_uuid: projectId }).whereNull('deletion_requested_at').update({
    deletion_requested_at: db.fn.now(), deletion_requested_by: identityKey,
  });
}

export async function completeProjectDeletion(
  db: Knex,
  projectId: string,
  removeNamespace = deleteProjectNamespace,
  notify = sendAdminNotificationEmail,
): Promise<boolean> {
  assertProjectId(projectId);
  // Keep the advisory lock on one dedicated connection across the external
  // operation. A process loss releases it; durable intent survives the loss.
  return db.transaction(async lock => {
    const lockName = `cars.delete.${projectId}`;
    const [rows] = await lock.raw('SELECT GET_LOCK(?, 0) AS acquired', [lockName]);
    if (Number(rows?.[0]?.acquired) !== 1) return false;
    try {
      const project = await db('projects').where({ project_uuid: projectId }).first();
      if (!project) return true;
      if (!project.deletion_requested_at) throw new Error('Project deletion has not been authorized');
      await db('projects').where({ id: project.id }).update({ deletion_attempted_at: db.fn.now() });
      await removeNamespace(projectId);
      const admins = await db('project_admins')
        .join('users', 'users.identity_key', 'project_admins.identity_key')
        .where({ 'project_admins.project_id': project.id }).select('users.email');
      await db.transaction(async trx => {
        for (const table of ['project_accounting', 'deploys', 'project_admins', 'logs']) {
          await trx(table).where({ project_id: project.id }).del();
        }
        await trx('projects').where({ id: project.id }).del();
      });
      try {
        await notify(admins.map((admin: any) => admin.email), project,
          `Project "${project.name}" (ID: ${projectId}) has been deleted.\nOriginated by: ${project.deletion_requested_by}\nAll resources have been removed.`,
          `Project Deleted: ${project.name}`);
      } catch (error: any) {
        logger.error({ projectId, error: error.message, alert: 'cars.project_delete.notification_failed' }, 'Deletion notification failed');
      }
      return true;
    } catch (error: any) {
      await db('projects').where({ project_uuid: projectId }).update({ deletion_error: String(error.message).slice(0, 1000) });
      throw error;
    } finally {
      await lock.raw('SELECT RELEASE_LOCK(?)', [lockName]);
    }
  });
}

export async function reconcileProjectDeletions(db: Knex): Promise<void> {
  const projects = await db('projects').whereNotNull('deletion_requested_at')
    .orderBy('deletion_attempted_at', 'asc').orderBy('deletion_requested_at', 'asc')
    .limit(5).select('project_uuid');
  for (const project of projects) {
    try {
      await completeProjectDeletion(db, project.project_uuid);
    } catch (error: any) {
      logger.error({ projectId: project.project_uuid, error: error.message, alert: 'cars.project_delete.reconciliation_failed' }, 'Durable project deletion will be reconciled again');
    }
  }
}

export function startProjectDeletionReconciler(db: Knex): NodeJS.Timeout {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await reconcileProjectDeletions(db); }
    catch (error: any) { logger.error({ error: error.message, alert: 'cars.project_delete.reconciler_failed' }, 'Project deletion reconciliation failed'); }
    finally { running = false; }
  };
  void tick();
  const timer = setInterval(() => void tick(), 10_000);
  timer.unref();
  return timer;
}
