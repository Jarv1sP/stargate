import {readTransaction} from './transaction.mjs';
import {SqliteTrainingDispatches} from './training-dispatches.mjs';
import {SqliteTaskAuthority} from './task-authority.mjs';
import {SqliteTrainingCatalog} from './training-catalog.mjs';
import {requireLaunchPreparation} from '../../domain/launch-authorization.mjs';

/** Coordinator-owned authorization, not a session extension or a node disk scan. */
export class SqliteLaunchAuthorization {
  constructor({database}) {
    this.database = database;
    this.dispatches = new SqliteTrainingDispatches({database});
    this.tasks = new SqliteTaskAuthority({database});
    this.projects = new SqliteTrainingCatalog({database});
  }
  acquire({binding, project, inputs}) {
    return readTransaction(this.database, () => {
      const approval = this.dispatches.authorizeInitialAllocationWithinTransaction(binding);
      const context = this.tasks.contextWithinTransaction(binding.jobId);
      const snapshot = this.projects.snapshotTaskWithinTransaction(context);
      requireLaunchPreparation({submission: context.submission, machineId: binding.machineId, project, inputs, snapshot});
      for (const source of context.submission.dataSources) {
        this.tasks.requireDataReadWithinTransaction(context, {machineId: binding.machineId, source});
      }
      return {...approval, scope: 'launch-ready'};
    });
  }
}
