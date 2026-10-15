#!/usr/bin/python3
"""Forced SSH command: receive install.py + package/ and run the local installer.

The SSH deployment key/sudoers select this command. SSH_ORIGINAL_COMMAND is not
used to choose a config or execute a shell. Node secrets stay in the local JSON.
"""
import argparse
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tarfile
import tempfile

CONFIG = Path('/etc/gpuq-console/node-install.json')
TEMP_ROOT = Path('/var/tmp')


def receive(stream, directory):
    # System-path boundary: no archive entry can leave this fresh private dir.
    with tarfile.open(fileobj=stream, mode='r|') as archive:
        for member in archive:
            name = PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts:
                raise PermissionError('安装包不能越出临时目录。')
            target = directory.joinpath(*name.parts)
            if member.isdir():
                target.mkdir(mode=0o700, parents=True, exist_ok=True)
            elif member.isfile():
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                with archive.extractfile(member) as source, target.open('xb') as output:
                    shutil.copyfileobj(source, output)
                target.chmod(member.mode & 0o777)
            else:
                raise PermissionError('安装包只允许普通文件和目录，不能包含链接或设备。')


def install_stream(stream, config, *, temp_root=None):
    try:
        with tempfile.TemporaryDirectory(prefix='stargate-node-', dir=TEMP_ROOT if temp_root is None else temp_root) as name:
            directory = Path(name)
            receive(stream, directory)
            result = subprocess.run([sys.executable, '-I', '-B', str(directory/'install.py'),
                                     str(directory/'package'), '--config', str(config)],
                                    capture_output=True, text=True)
            if result.stderr:
                print(result.stderr, end='', file=sys.stderr)
            try:
                value = json.loads(result.stdout)
            except ValueError:
                if result.returncode:
                    return {'state': 'FAILED', 'error': '节点安装失败，请查看发布日志后重试。'}, result.returncode
                return {'state': 'UNKNOWN', 'error': '安装结果未知，请核对节点发布目录和服务状态，不要自动重放安装。'}, 1
            return value, result.returncode
    except Exception as error:
        print('节点接收失败：' + str(error), file=sys.stderr)
        return {'state': 'FAILED', 'error': '节点安装包接收或启动失败，请查看发布日志后重试。'}, 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=CONFIG, help='Node-local private installer JSON')
    args = parser.parse_args()
    os.umask(0o077)
    value, code = install_stream(sys.stdin.buffer, args.config)
    print(json.dumps(value, ensure_ascii=False))
    return code


if __name__ == '__main__':
    raise SystemExit(main())
