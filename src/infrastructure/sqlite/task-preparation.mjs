import {readTransaction} from './transaction.mjs';
import {SqliteTrainingDispatches} from './training-dispatches.mjs';
import {SqliteTaskAuthority} from './task-authority.mjs';
import {SqliteTrainingCatalog} from './training-catalog.mjs';
import {ApplicationError} from '../../domain/errors.mjs';

/** Read the fixed target and currently authorized inputs; never choose another node. */
export class SqliteTaskPreparation {
  constructor({database}) {
    this.database = database;
    this.dispatches = new SqliteTrainingDispatches({database});
    this.tasks = new SqliteTaskAuthority({database});
    this.projects = new SqliteTrainingCatalog({database});
  }
  read(jobId) {
    return readTransaction(this.database, () => {
      const {binding, context} = this.dispatches.preparationWithinTransaction(jobId);
      const snapshot = this.projects.snapshotTaskWithinTransaction(context);
      const instance = snapshot.instances.find(row => row.machineId === binding.machineId);
      if (!instance || !snapshot.candidates.some(row => row.machineId === binding.machineId)) {
        throw new ApplicationError('NODE_LAUNCH_PROJECT_CHANGED');
      }
      for (const source of context.submission.dataSources) {
        this.tasks.requireDataReadWithinTransaction(context, {machineId: binding.machineId, source});
      }
      return {binding, submission: context.submission, project: {id: context.submission.project.id,
        project: instance.project, release: context.submission.project.release, projectUUID: instance.projectUUID, generation: instance.generation}};
    });
  }
}
