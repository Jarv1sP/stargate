import {PrepareNodeWorkload} from '../application/prepare-node-workload.mjs';
import {TrainingLaunchCompiler} from '../infrastructure/training-launch-compiler.mjs';
import {SqliteNodeDispatchBindings} from '../infrastructure/sqlite/node-dispatch-bindings.mjs';
import {ProjectRunPreparer} from '../infrastructure/project-run-preparer.mjs';
import {ManagedDataLeaser} from '../infrastructure/managed-data-leaser.mjs';
import {GpuqPoolReader} from '../infrastructure/gpuq-pool-reader.mjs';
import {GpuqPolicy} from '../infrastructure/gpuq-policy.mjs';
import {GpuqLaunchSpec} from '../infrastructure/gpuq-launch-spec.mjs';
import {ValidateTrainingResources} from '../application/validate-training-resources.mjs';
import {createNodePreparationHandler} from '../api/node-preparation-handler.mjs';
import {PrepareTaskLaunch} from '../application/prepare-task-launch.mjs';
import {SqliteTaskPreparation} from '../infrastructure/sqlite/task-preparation.mjs';
import {HttpNodePreparation} from '../infrastructure/http-node-preparation.mjs';

export function assembleTaskPreparation({database, nodes, ...options}) {
  return new PrepareTaskLaunch({contexts: new SqliteTaskPreparation({database}), nodes: new HttpNodePreparation({...options, nodes})});
}

export function assembleNodePreparation({database, machineId, credential, socketPath, runner, cwd,
  root, basePath, runtimeConfig, roots, leaseVersions, python, timeoutMs, reportError}) {
  const compiler = new TrainingLaunchCompiler({runner, cwd,
    resources: new ValidateTrainingResources({policy: new GpuqPolicy({python})}), launchSpec: new GpuqLaunchSpec({python})});
  const preparation = new PrepareNodeWorkload({compiler, bindings: new SqliteNodeDispatchBindings({database, machineId}),
    projects: new ProjectRunPreparer({machineId, root, basePath, runtimeConfig, python, timeoutMs}),
    leaser: new ManagedDataLeaser({machineId, roots, leaseVersions, python, timeoutMs}),
    pools: new GpuqPoolReader({machineId, socketPath, python, timeoutMs})});
  return createNodePreparationHandler({machineId, credential, preparation, reportError});
}
