"""Installer-only live relaxation of platform limits; never restart workloads."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import sys


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
                        mask.write_text('\n')
                except FileNotFoundError:
                    pass  # The payload exited; there is nothing left to relax.
        except (FileNotFoundError, subprocess.CalledProcessError):
            if subprocess.run(['systemctl', '--user', 'is-active', '--quiet', unit]).returncode:
                continue  # Completion during deployment is normal.
            raise
        changed.append(unit)
    return changed


if __name__ == '__main__':
    print(json.dumps({'relaxedUnits': refresh(json.loads(Path(sys.argv[1]).read_text()))}))
