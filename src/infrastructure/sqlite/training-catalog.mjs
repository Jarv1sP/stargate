import {transaction, readTransaction} from './transaction.mjs';
import {SqliteSessionReader} from './session-reader.mjs';
import {requireActiveSession} from '../../domain/session-policy.mjs';
import {trainingCandidates, projectCandidates} from '../../domain/training-candidates.mjs';
import {SqliteTaskAuthority} from './task-authority.mjs';

export function createTrainingCatalogSchema(database) {
  transaction(database, () => database.exec(`
    CREATE TABLE v2_projects (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES v2_accounts(id),
      revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0), archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1))
    );
    CREATE TABLE v2_project_releases (
      project_id TEXT NOT NULL REFERENCES v2_projects(id), release TEXT NOT NULL,
      PRIMARY KEY(project_id,release)
    );
    CREATE TABLE v2_release_locations (
      project_id TEXT NOT NULL, release TEXT NOT NULL, machine_id TEXT NOT NULL REFERENCES v2_machines(id),
      PRIMARY KEY(project_id,release,machine_id),
      FOREIGN KEY(project_id,release) REFERENCES v2_project_releases(project_id,release)
    );
  `));
}

export class SqliteTrainingCatalog {
  constructor({database}) {this.database = database; this.sessions = new SqliteSessionReader({database});}
  candidates(actor, request, now) {
    return readTransaction(this.database, () => this.#candidates(actor, request, now));
  }
  snapshot(actor, request, now) {
    return readTransaction(this.database, () => this.#withInstances(this.#candidates(actor, request, now), request));
  }
  snapshotForTask(jobId) {
    return readTransaction(this.database, () => this.snapshotTaskWithinTransaction(
      new SqliteTaskAuthority({database: this.database}).contextWithinTransaction(jobId)));
  }
  snapshotTaskWithinTransaction({accountId, accountRole, submission}) {
    const facts = this.#facts(accountId, submission);
    return this.#withInstances(projectCandidates(accountId, accountRole, submission, facts), submission);
  }
  #withInstances(result, request) {
    const allowed = new Set(result.candidates.map(row => row.machineId));
    const instances = this.database.prepare('SELECT * FROM v2_project_instances WHERE project_id=? ORDER BY machine_id')
      .all(request.project.id).filter(row => allowed.has(row.machine_id)).map(row => ({machineId: row.machine_id,
        project: row.project_slug, projectUUID: row.project_uuid, generation: row.generation}));
    return {...result, instances};
  }
  #candidates(actor, request, now) {
    const session = this.sessions.findByActor(actor);
    requireActiveSession(session, now);
    return trainingCandidates(actor, request, {...this.#facts(actor.id, request), session}, now);
  }
  #facts(accountId, request) {
    const db = this.database;
      const row = db.prepare('SELECT * FROM v2_projects WHERE id=?').get(request.project.id);
      const project = row ? {id: row.id, ownerId: row.owner_id, revision: row.revision, archived: row.archived === 1} : null;
      const releaseExists = !!db.prepare('SELECT 1 FROM v2_project_releases WHERE project_id=? AND release=?').get(request.project.id, request.project.release);
      const machines = db.prepare(`SELECT m.id,m.enabled,m.cards,g.account_id granted,g.max_cards,
        EXISTS(SELECT 1 FROM v2_release_locations l WHERE l.machine_id=m.id AND l.project_id=? AND l.release=?) release_registered
        FROM v2_machines m LEFT JOIN v2_machine_grants g ON g.machine_id=m.id AND g.account_id=? ORDER BY m.id`)
        .all(request.project.id, request.project.release, accountId).map(value => ({id: value.id, enabled: value.enabled === 1,
          cards: value.cards, granted: value.granted !== null, maxCards: value.max_cards, releaseRegistered: value.release_registered === 1}));
      const totalCards = db.prepare('SELECT total_cards FROM v2_compute_policies WHERE account_id=?').get(accountId)?.total_cards ?? null;
      return {project, releaseExists, machines, totalCards};
  }
}
