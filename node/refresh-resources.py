"""Installer-only live relaxation of platform limits; never restart workloads."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import sys


def rebind_runners(config, runner):
    """Update the platform wrapper used by future attempts, not user commands."""
    changed = 0
    with sqlite3.connect(config['database']) as db:
        rows = db.execute("SELECT id,argv_json,env_json FROM jobs WHERE state NOT IN ('SUCCEEDED','FAILED','CANCELED','LOST')").fetchall()
        for job, raw, environment in rows:
            argv = json.loads(raw)
            if len(argv) != 3 or json.loads(environment).get('GPUQ_CONSOLE_OCI') != '1':
                continue
            entry = Path(argv[1])
            if entry.name != 'oci-runner.py' or entry.parent.name != 'node' or entry.parent.parent.parent != runner.parent.parent.parent:
                continue
            if entry == runner:
                continue
            argv[1] = str(runner)
            db.execute('UPDATE jobs SET argv_json=? WHERE id=?', (json.dumps(argv), job))
            changed += 1
    return changed


def refresh(config, *, cgroups=Path('/sys/fs/cgroup')):
    module = importlib.util.spec_from_file_location('shared_resources', Path(__file__).with_name('job-resources.py'))
    resources = importlib.util.module_from_spec(module)
    module.loader.exec_module(resources)
    pool = resources.memory_pool(config)
    if pool:
        subprocess.run(['systemctl', '--user', 'set-property', '--runtime', 'gpuq-workloads.slice',
                        'MemoryMax='+str(pool['maxBytes'])], check=True)
    with sqlite3.connect('file:'+config['database']+'?mode=ro', uri=True) as db:
        jobs = {(unit if unit.endswith('.service') else unit+'.service'): key
                for unit, key in db.execute('SELECT a.unit_name,j.submit_key FROM attempts a JOIN jobs j ON j.id=a.job_id') if unit}
    units = subprocess.check_output(['systemctl', '--user', 'list-units', '--type=service', '--state=running',
                                     '--plain', '--no-legend', '--no-pager', 'gpuq-*', 'amax-term-*'], text=True)
    changed = []
    for line in units.splitlines():
        unit = line.split()[0]
        terminal = unit.startswith('amax-term-')
        key = unit.removeprefix('amax-term-').removesuffix('.service') if terminal else jobs.get(unit)
        if not key:
            continue
        file = Path(config['root'])/('terminals' if terminal else 'jobs')/(key+'.json')
        if not file.exists():
            continue  # Native GPUQ jobs have no platform resource policy.
        try:
            spec = json.loads(file.read_text())
            group = subprocess.check_output(['systemctl', '--user', 'show', unit, '-p', 'ControlGroup', '--value'], text=True).strip()
            if not group:
                continue  # Job completed during enumeration.
            path = resources.cgroup_path(group, cgroups)
            budget = resources.requested_limits(spec, terminal, config)
            properties = ['CPUQuota='+str(budget['cpu']*100)+'%']
            if 'memoryLimitGiB' not in spec:
                old = (path/'memory.max').read_text().strip()
                if old != 'max':
                    properties.append('MemoryMax='+str(max(int(old), budget['memory'])))
            subprocess.run(['systemctl', '--user', 'set-property', '--runtime', unit, *properties], check=True)
            # Podman split-cgroup payload and conmon are direct children. Leave
            # user-created descendant cgroups and explicit process affinity alone.
            for mask in path.glob('*/cpuset.cpus'):
                try:
                    if mask.read_text().strip():
                        mask.write_text((path/'cpuset.cpus.effective').read_text())
                except FileNotFoundError:
                    pass  # The payload exited; there is nothing left to relax.
        except (FileNotFoundError, subprocess.CalledProcessError):
            if subprocess.run(['systemctl', '--user', 'is-active', '--quiet', unit]).returncode:
                continue  # Completion during deployment is normal.
            raise
        changed.append(unit)
    return changed


if __name__ == '__main__':
    config = json.loads(Path(sys.argv[1]).read_text())
    runner = Path(__file__).resolve().parents[2]/'current/node/oci-runner.py'
    rebound = rebind_runners(config, runner)
    print(json.dumps({'reboundRunners': rebound, 'relaxedUnits': refresh(config)}))
