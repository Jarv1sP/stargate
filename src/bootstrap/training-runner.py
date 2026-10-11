"""Fixed node-runner composition; no HTTP, schema migration or task submission."""
import importlib.util
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[2]
ENTRYPOINT = ROOT / 'scripts/v2-training-runner.py'


def load_module(name, relative):
    spec = importlib.util.spec_from_file_location('v2_runner_' + name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


Plans = load_module('plans', 'src/infrastructure/node-runtime-plan.py')
Authority = load_module('authority', 'src/infrastructure/native-execution-authority.py')
Inputs = load_module('inputs', 'src/infrastructure/training-runtime-inputs.py')
Mounts = load_module('mounts', 'src/infrastructure/training-data-mounts.py')
Runtime = load_module('runtime', 'src/infrastructure/training-runtime.py')
Command = load_module('command', 'src/infrastructure/training-command.py')
Budget = load_module('budget', 'src/infrastructure/training-budget.py')
Engine = load_module('engine', 'src/infrastructure/bwrap-training-engine.py')
OciEngine = load_module('oci_engine', 'src/infrastructure/oci-training-engine.py')
Network = load_module('network', 'src/infrastructure/sandbox-network.py')
Projects = load_module('projects', 'deploy/project-store.py')
Cache = load_module('cache', 'deploy/dataset-cache.py')
Shared = load_module('shared', 'deploy/shared-data.py')
Control = load_module('control', 'deploy/training-control.py')
Resources = load_module('resources', 'deploy/job-resources.py')
Devices = load_module('devices', 'deploy/gpu-devices.py')
Oci = load_module('oci', 'deploy/personal-oci.py')
from gpuq.protocol import Client


class RunnerConfigError(ValueError):
    code = 'INVALID_RUNNER_CONFIG'


class EngineUnavailable(RuntimeError):
    code = 'RUNNER_ENGINE_UNAVAILABLE'


def runner_prefix(config_path):
    """The compiler and operator use this exact interpreter/entrypoint form."""
    return [sys.executable, '-I', '-B', str(ENTRYPOINT), '--config', str(config_path)]


def load_config(path):
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise RunnerConfigError('Config path must be absolute')
    with path.open(encoding='utf-8') as stream:
        value = json.load(stream)
    required = {'schema', 'machineId', 'database', 'gpuqSocket', 'root', 'basePath', 'controlRoot', 'gpuqArchive'}
    defaults = {'directories': {}, 'managedRoots': [], 'leaseVersions': [], 'runtimeConfig': {},
                'bwrap': '/usr/bin/bwrap', 'slirp': '/usr/bin/slirp4netns', 'slirpLibraryPath': None}
    if not isinstance(value, dict) or not required <= value.keys() or value.keys() - required - defaults.keys():
        raise RunnerConfigError('Missing or unknown runner configuration fields')
    config = {**defaults, **value}
    if type(config['schema']) is not int or config['schema'] != 1:
        raise RunnerConfigError('Unsupported runner configuration schema')
    if not isinstance(config['machineId'], str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', config['machineId']):
        raise RunnerConfigError('Invalid machineId')
    for field in ('database', 'gpuqSocket', 'root', 'basePath', 'controlRoot', 'gpuqArchive', 'bwrap', 'slirp'):
        item = config[field]
        if not isinstance(item, str) or not Path(item).is_absolute() or '\0' in item or '..' in Path(item).parts:
            raise RunnerConfigError('Invalid absolute path: ' + field)
    library = config['slirpLibraryPath']
    if library is not None and (not isinstance(library, str) or not Path(library).is_absolute() or '\0' in library or '..' in Path(library).parts):
        raise RunnerConfigError('Invalid slirpLibraryPath')
    for field, expected in [('directories', dict), ('runtimeConfig', dict), ('managedRoots', list), ('leaseVersions', list)]:
        if not isinstance(config[field], expected):
            raise RunnerConfigError('Invalid field: ' + field)
    return config


def run(config_path, *, dispatch_id, plan_digest):
    config = load_config(config_path)
    launch = Plans.NodeRuntimePlans(database=config['database'], machine_id=config['machineId'],
        runner=runner_prefix(config_path)).load(dispatch_id=dispatch_id, plan_digest=plan_digest)
    kind = launch['plan']['project']['runtime']['kind']
    if kind not in {'base', 'oci'}:
        raise EngineUnavailable('Unsupported project runtime')
    authority = Authority.NativeExecutionAuthority(native=Client(config['gpuqSocket'], timeout=5),
        control_root=config['controlRoot'], machine_id=config['machineId'], binding=launch['binding'])
    projects = Projects.ProjectStore(config['root'], config['basePath'], initialize=False,
        config={**config['runtimeConfig'], 'root': config['root']})
    data = Mounts.TrainingDataMounts(Cache, Shared, directories=config['directories'],
        roots=config['managedRoots'], lease_versions=config['leaseVersions'])
    runtime = Runtime.TrainingRuntime(authority=authority,
        inputs=Inputs.TrainingRuntimeInputs(projects=projects, data=data), plan=launch['plan'])
    budget = Budget.TrainingBudget(Resources, systemd=Authority.systemd_runner)
    command = Command.TrainingCommand(Control, config=config)
    if kind == 'base':
        network = Network.SlirpNetwork(binary=config['slirp'], library_path=config['slirpLibraryPath'])
        engine = Engine.BwrapTrainingEngine(network=network, devices=Devices.mount_paths, bwrap=config['bwrap'])
    else:
        def owner(account):
            return Oci.PersonalOCI({**config['runtimeConfig'], 'root': config['root']}, account, initialize=False)
        def devices(owner, uuids):
            Oci.protected_file(Oci.CDI, owner.policy['cdiSHA256'])
            return Oci.cdi_devices(Oci.CDI.read_bytes(), uuids)
        engine = OciEngine.OciTrainingEngine(owners=owner, devices=devices, systemd=Authority.systemd_runner)
    return runtime.run(budget=budget, command=command, engine=engine)
