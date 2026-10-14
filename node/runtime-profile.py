"""One code release, fixed administrator-installed entry configurations.

The forced command chooses a profile before reading a request. Request fields
never choose a configuration or widen an operation allowlist. Background child
commands carry that same fixed profile through systemd/GPUQ explicitly.
"""
import json
import os
import re
from pathlib import Path
import stat
import sys

sys.dont_write_bytecode = True
CORE = Path(__file__).resolve().parent
RELEASE = CORE.parent
PROFILE_ENV = 'STARGATE_CORE_PROFILE'
PROFILES = frozenset({'R6t', 'FGK', '7IM', '1zz', 'fiJU', 'peer'})


def profile(value=None):
    value = os.environ.get(PROFILE_ENV) if value is None else value
    if value is not None and value not in PROFILES:
        raise ValueError('Invalid fixed node profile')
    return value


def config_path(here=None, *, selected=None):
    selected = profile(selected)
    if selected is None:
        # Local development uses one private config; installed entries select a profile.
        return Path(here or CORE)/'node-config.json'
    return RELEASE/'profiles'/selected/'node-config.json'


def read_private(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
            raise ValueError('Untrusted node release file')
        with os.fdopen(os.dup(fd), 'rb') as stream:
            return stream.read()
    finally:
        os.close(fd)


def activate(selected):
    if selected not in PROFILES:
        raise ValueError('Fixed node profile required')
    os.environ[PROFILE_ENV] = selected
    os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
    # No client-provided module path participates in the shared code loader.
    os.environ.pop('PYTHONPATH', None)
    os.environ.pop('PYTHONHOME', None)
    sys.dont_write_bytecode = True
    return config_path(selected=selected)


def check_directories(selected):
    if selected not in PROFILES:
        raise ValueError('Fixed node profile required')
    for directory in (RELEASE, CORE, RELEASE/'profiles', RELEASE/'profiles'/selected):
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
            raise ValueError('Untrusted node release directory')


def child_command(argv, env, *, selected=None, gpu=None):
    """Propagate the installer-selected profile into trusted child programs."""
    selected = profile(selected)
    if selected is None:
        return argv, env
    args = list(argv)
    trusted = frozenset(str(path) for path in CORE.glob('*.py'))

    def script_at(index):
        if index >= len(args) or args[index] not in ('/usr/bin/python3',):
            return None
        index += 1
        while index < len(args) and args[index] in ('-B', '-I', '-E', '-s', '-u'):
            index += 1
        return index if index < len(args) and args[index] in trusted else None

    flags = {PROFILE_ENV: selected, 'PYTHONDONTWRITEBYTECODE': '1'}
    child_env = {**(os.environ if env is None else env), **flags}
    if args and args[0] == '/usr/bin/systemd-run':
        positions = [index for index in range(1, len(args)) if script_at(index) is not None]
        if len(positions) != 1:
            return argv, env
        index = positions[0]
        command = args[index:]
        if '-B' not in command[1:script_at(index)-index]:
            command.insert(1, '-B')
        return args[:index]+['--setenv='+key+'='+value for key, value in flags.items()]+command, child_env
    if args and gpu is not None and args[0] == gpu and '--' in args:
        split = args.index('--')
        if 'submit' in args[1:split] and script_at(split+1) is not None:
            # The scheduler's runner launch requires its original Python argv.
            return args[:split]+['--env='+key+'='+value for key, value in flags.items()]+args[split:], env
        return argv, env
    if script_at(0) is not None:
        if '-B' not in args[1:script_at(0)]:
            args.insert(1, '-B')
        return args, child_env
    return argv, env
