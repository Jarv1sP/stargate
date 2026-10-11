"""Explicit existing-project run preparation; separate from read-only inspection."""
import importlib.util
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True


def main():
    try:
        raw = sys.stdin.buffer.read(8193)
        if len(raw) > 8192:
            raise ValueError('Request too large')
        value = json.loads(raw)
        if not isinstance(value, dict) or set(value) != {'config', 'request'}:
            raise ValueError('Invalid preparation envelope')
        config, request = value['config'], value['request']
        if not isinstance(config, dict) or set(config) != {'root', 'basePath', 'runtimeConfig'} or not isinstance(config['runtimeConfig'], dict):
            raise ValueError('Invalid project configuration')
        if not isinstance(request, dict) or set(request) != {'accountId', 'project', 'release', 'jobId', 'projectUUID', 'generation'}:
            raise ValueError('Invalid project preparation request')
        path = Path(__file__).resolve().parents[2] / 'deploy' / 'project-store.py'
        spec = importlib.util.spec_from_file_location('v2_project_run_store', path)
        module = importlib.util.module_from_spec(spec); sys.modules[spec.name] = module; spec.loader.exec_module(module)
        options = {**config['runtimeConfig'], 'root': config['root']}
        existing = module.ProjectStore(config['root'], config['basePath'], config=options, initialize=False)
        observed = existing.inspect_release_metadata(request['accountId'], request['project'], request['release'])
        if observed['projectUUID'] != request['projectUUID'] or observed['generation'] != request['generation']:
            module.fail('project_changed', 'Project instance differs from the registered launch reference')
        store = module.ProjectStore(config['root'], config['basePath'], config=options)
        result = store.prepare_run(request['accountId'], request['project'], request['release'], request['jobId'],
                                   project_uuid=request['projectUUID'], generation=request['generation'])
        print(json.dumps({'result': {'accountId': request['accountId'], **result}}))
        return 0
    except Exception as error:
        code = {'project_changed': 'PROJECT_INSTANCE_CHANGED', 'job_conflict': 'PROJECT_RUN_CONFLICT',
                'project_archived': 'PROJECT_NOT_ACTIVE', 'base_changed': 'PROJECT_RUNTIME_CHANGED'}.get(getattr(error, 'code', None), 'PROJECT_RUN_UNAVAILABLE')
        print(json.dumps({'error': {'code': code}}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
