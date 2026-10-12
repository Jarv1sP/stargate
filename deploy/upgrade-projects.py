#!/usr/bin/env python3
"""Upgrade projects on an already installed P0 node, without restarting anything.

The existing config is read, backed up byte-for-byte and NEVER rewritten.
Compile a pinned in-memory copy of every source before making any change;
install the manifest's runtime dependencies before its runner and dispatchers.
Existing GPUQ databases, unit definitions and user data are never modified.
"""
import argparse
import ast
import contextlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import time
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
import node_runtime


FILES = tuple(name for name,_ in node_runtime.runtime_plan('common-p0'))
RAY_FILES = tuple(node_runtime.manifest()['profiles']['ray-p0']['extra'])
P0_HELPERS = ('node-executor.py', 'terminal-helper.py', 'job-diagnostics.py')
MAX_FILE_BYTES = 8 * 1024 * 1024
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def file_plan(profile,source=None):
    return node_runtime.runtime_plan(profile,source or Path(__file__).resolve().parent)


def functions(payload):
    return {node.name: node for node in ast.parse(payload).body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}


def require_calls(payload, contracts):
    """Check callable signatures without importing/executing a node helper."""
    definitions = functions(payload)
    for name, count in contracts.items():
        node = definitions.get(name)
        if node is None or isinstance(node,ast.AsyncFunctionDef): raise ValueError('Missing synchronous helper function: ' + name)
        positional = len(node.args.posonlyargs) + len(node.args.args)
        required = positional - len(node.args.defaults)
        if required > count or positional < count and node.args.vararg is None or any(value is None for value in node.args.kw_defaults):
            raise ValueError('Incompatible helper function: ' + name)
    return definitions


def strings(tree):
    return {node.value for node in ast.walk(tree) if isinstance(node, ast.Constant) and isinstance(node.value, str)}


def runner_profile(payload):
    require_calls(payload, {'main':0,'project_runtime':5,'start_job_capture':7,'finish_job_capture':5})
    return node_runtime.detected_profile(payload)


def p0_prerequisites(directory):
    """Require an existing compatible P0 installation, never half-upgrade it."""
    observed = {}
    try:
        for name in (*P0_HELPERS, 'sandbox-runner.py'):
            observed[directory/name] = checked_file(directory/name, private=False)
        node = require_calls(observed[directory/'node-executor.py'][0], {
            'projects':0,'terminal_op':2,'terminal_pointers':1,'terminal_alive':2,
            'stop_terminal':1,'job_diagnostics':2,'job_log_result':3,'dataset_open_mounts':1,'process':2})
        if not {'clientId','writerToken','leaseExpiresAt','terminal.detach'} <= strings(node['terminal_op']):
            raise ValueError('Independent terminal writer-lease protocol is missing')
        if not {'projects.','diagnostics','terminal.detach'} <= strings(node['process']):
            raise ValueError('P0 project/diagnostic/terminal dispatch is missing')
        if not {'data','offset','exited','exitCode','close','exchange'} <= strings(ast.parse(observed[directory/'terminal-helper.py'][0])):
            raise ValueError('Terminal helper reply protocol is incompatible')
        require_calls(observed[directory/'job-diagnostics.py'][0], {
            'start_capture':7,'finish_capture':4,'bundle':3,'summary':1,'prune':1,'_confirmed_stopped':1})
        profile = runner_profile(observed[directory/'sandbox-runner.py'][0])
        units = Path.home()/'.config/systemd/user'
        for name in ('gpuq-diagnostics-gc.service','gpuq-diagnostics-gc.timer'):
            observed[units/name] = checked_file(units/name, private=False)
        service = observed[units/'gpuq-diagnostics-gc.service'][0].decode().replace('%h',str(Path.home()))
        timer = observed[units/'gpuq-diagnostics-gc.timer'][0].decode()
        if ('ExecStart=/usr/bin/python3 '+str(directory/'job-diagnostics.py')+' --gc' not in service.splitlines() or
                'KillMode=control-group' not in service.splitlines() or
                'Unit=gpuq-diagnostics-gc.service' not in timer.splitlines()):
            raise ValueError('Diagnostic GC unit does not match this program directory')
        timer_preflight()
        return observed, profile
    except (OSError, ValueError, SyntaxError, subprocess.SubprocessError) as error:
        raise SystemExit('Compatible P0 terminal/diagnostic prerequisites are missing or unavailable. Run the reviewed deploy/install-node.py workflow first; no files were changed. '+str(error)) from error


def timer_preflight():
    for action in ('is-enabled','is-active'):
        subprocess.run(['/usr/bin/systemctl','--user',action,'--quiet','gpuq-diagnostics-gc.timer'],
                       check=True,capture_output=True,timeout=5)


def cpu_preflight(payload):
    # Execute the same precompiled, pinned check bytes that were reviewed, not
    # a source path that can be replaced after preflight. No --configure/sudo.
    result = subprocess.run(['/usr/bin/python3','-c',payload.decode(),'--check'],
                            check=True,text=True,capture_output=True,timeout=30)
    proof = json.loads(result.stdout)
    if (not isinstance(proof,dict) or not isinstance(proof.get('cpuMax'),str) or
            type(proof.get('memoryMax')) is not int or type(proof.get('pidsMax')) is not int):
        raise ValueError('Kernel CPU/memory/PID enforcement proof is malformed')
    quota, period = map(int, proof['cpuMax'].split())
    if not (0 < quota <= period and 0 < proof['memoryMax'] <= 134217728 and 0 < proof['pidsMax'] <= 32):
        raise ValueError('Kernel CPU/memory/PID enforcement proof is invalid')
    return proof


def unchanged(observed):
    return all(checked_file(path,private=False) == expected for path,expected in observed.items())


def checked_path(path):
    path = Path(path)
    if (not path.is_absolute() or path == Path('/') or '..' in path.parts or
            any(ord(character) < 32 for character in str(path))):
        raise SystemExit('An absolute non-root path without traversal is required')
    return path


@contextlib.contextmanager
def opened_directory(path):
    """Reject symbolic links in every component, not just the last one."""
    path = checked_path(path)
    descriptor = os.open('/', DIR_FLAGS)
    try:
        for part in path.parts[1:]:
            child = os.open(part, DIR_FLAGS, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        yield descriptor
    finally:
        os.close(descriptor)


def checked_directory(path, private=False, allow_root=False):
    with opened_directory(path) as descriptor:
        info = os.fstat(descriptor)
        owners = {os.getuid(), 0} if allow_root else {os.getuid()}
        if info.st_uid not in owners or info.st_mode & (0o077 if private else 0o022):
            raise SystemExit('Unsafe directory owner or permissions: ' + path.name)
        return info.st_dev, info.st_ino


def stamp(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def checked_file(path, private=True, allow_root=False):
    with opened_directory(path.parent) as parent:
        descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            info = os.fstat(descriptor)
            owners = {os.getuid(), 0} if allow_root else {os.getuid()}
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid not in owners or
                    info.st_mode & (0o077 if private else 0o022) or info.st_mode & 0o6000 or
                    info.st_size > MAX_FILE_BYTES):
                raise SystemExit('Unsafe or oversized node file: ' + path.name)
            chunks, remaining = [], MAX_FILE_BYTES + 1
            while remaining:
                chunk = os.read(descriptor, min(remaining, 1024 * 1024))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            current = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
            if not remaining or stamp(info) != stamp(os.fstat(descriptor)) or stamp(info) != stamp(current):
                raise SystemExit('Node file changed while being read: ' + path.name)
            return b''.join(chunks), stamp(info)
        finally:
            os.close(descriptor)


def safe_file(path, private=True):
    """Compatibility helper for local callers; no chmod or ownership repair."""
    checked_file(path, private=private)


def atomic_copy(source, destination, mode=0o700):
    """Install the exact precompiled bytes, never re-open a mutable source."""
    payload = source if isinstance(source, bytes) else checked_file(source, private=False, allow_root=True)[0]
    descriptor, name = tempfile.mkstemp(prefix='.project-upgrade-', dir=destination.parent)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write(payload)
            output.flush()
            os.fchmod(output.fileno(), mode)
            os.fsync(output.fileno())
        os.replace(name, destination)
        with opened_directory(destination.parent) as parent:
            os.fsync(parent)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', required=True, type=Path)
    parser.add_argument('--source', default=Path(__file__).resolve().parent, type=Path)
    parser.add_argument('--runtime-profile', choices=('common-p0','ray-p0'), required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args(argv)
    if os.getuid() == 0 or os.geteuid() != os.getuid():
        raise SystemExit('Run as the existing execution service user, not root')
    directory, source_directory = checked_path(args.directory), checked_path(args.source)
    directory_identity = checked_directory(directory, private=True)
    checked_directory(source_directory, allow_root=True)
    config_file = directory / 'node-config.json'
    config_bytes, config_stamp = checked_file(config_file)
    config = json.loads(config_bytes)
    if not isinstance(config, dict) or not all(key in config for key in ('root', 'conda', 'gpu', 'database')):
        raise SystemExit('Upgrade the execution/dataset base before project support')
    for key in ('root', 'conda'):
        if not isinstance(config[key], str):
            raise SystemExit('Existing project storage/base must be an absolute directory')
        path = checked_path(Path(config[key]))
        checked_directory(path, allow_root=key == 'conda')
    prerequisites, current_profile = p0_prerequisites(directory)
    if current_profile == 'ray-p0' and args.runtime_profile != 'ray-p0':
        raise SystemExit('Project upgrade cannot downgrade an installed Ray runner. Keep --runtime-profile ray-p0, or review a separate install-node.py profile change; nothing installed.')
    plan = file_plan(args.runtime_profile,source_directory)
    payloads, previous = {}, {'node-config.json': config_bytes}
    for name, source_name in plan:
        payload, _ = checked_file(source_directory / source_name, private=False, allow_root=True)
        compile(payload, str(source_directory / source_name), 'exec')
        payloads[name] = payload
        destination = directory / name
        # lexists catches dangling symlinks too: they must not be overwritten.
        if os.path.lexists(destination):
            previous[name] = checked_file(destination, private=False)[0]
    if runner_profile(payloads['sandbox-runner.py']) != args.runtime_profile:
        raise SystemExit('Source runner does not match the explicit runtime profile; nothing installed.')
    node_runtime.validate_dependencies(payloads)
    enforcement = None
    if args.runtime_profile == 'ray-p0':
        check, _ = checked_file(source_directory/'cpu-delegation.py',private=False,allow_root=True)
        compile(check,str(source_directory/'cpu-delegation.py'),'exec')
        try: enforcement = cpu_preflight(check)
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
            raise SystemExit('Ray CPU/memory/PID enforcement preflight failed before any write. No delegation was configured; see docs/RAY_RESOURCES.md and request administrator review.') from error
    summary = {'files': [name for name,_ in plan], 'runtimeProfile':args.runtime_profile,
               'configurationUnchanged': True, 'dispatcherUnchanged':False,
               'schedulerUnchanged': True, 'restartRequired': False,
               'p0PrerequisitesVerified':True,'kernelEnforcement':enforcement}
    if not args.apply:
        print(json.dumps({'dryRun': True, **summary}))
        return

    # Recheck the config and directory before the first write. Never overwrite
    # an operator's concurrent config update, nor pretend it was our change.
    if (checked_directory(directory, private=True) != directory_identity or
            checked_file(config_file) != (config_bytes, config_stamp) or not unchanged(prerequisites)):
        raise SystemExit('Node configuration/directory/P0 prerequisites changed during preflight; nothing installed')
    backup = directory / ('before-projects-' + str(time.time_ns()))
    backup.mkdir(mode=0o700)
    for name, content in previous.items():
        atomic_copy(content, backup / name, mode=0o600 if name == 'node-config.json' else 0o700)
    with opened_directory(directory) as descriptor:
        os.fsync(descriptor)
    # Runtime dependencies first, runner next, then dispatcher/probe activation:
    # no entry point can start with a partially copied helper dependency graph.
    # No users/, jobs/, terminal pointers, unit definitions or GPUQ DB are changed.
    try:
        if checked_file(config_file) != (config_bytes, config_stamp) or not unchanged(prerequisites):
            raise SystemExit('Node configuration/P0 prerequisites changed while backing up; nothing installed')
        for name, _ in plan:
            if name not in previous or previous[name]!=payloads[name]:atomic_copy(payloads[name], directory / name)
            else:(directory/name).chmod(0o700)
    except OSError as error:
        raise SystemExit('Project upgrade did not finish; private backup retained at ' + str(backup) + '; no service was restarted') from error
    if checked_file(config_file) != (config_bytes, config_stamp):
        raise SystemExit('Config changed externally during installation; no config was overwritten; review retained backup at ' + str(backup))
    print(json.dumps({'upgraded': True, 'backup': str(backup), **summary}))


if __name__ == '__main__':
    main()
