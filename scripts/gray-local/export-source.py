#!/usr/bin/env python3
"""导出确切的被测提交；剧本和隔离栈来自灰测分支。"""
import argparse
import json
from pathlib import Path
import subprocess


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args])


def export_source(trusted, destination, commit='HEAD'):
    repo = Path(git(trusted, 'rev-parse', '--show-toplevel').decode().strip())
    revision = git(repo, 'rev-parse', '--verify', '--end-of-options', commit+'^{commit}').decode().strip()
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    archive = subprocess.Popen(['git', '-C', str(repo), 'archive', revision], stdout=subprocess.PIPE)
    try:
        subprocess.run(['tar', '-xf', '-', '-C', str(destination)], stdin=archive.stdout, check=True)
    finally:
        archive.stdout.close()
        status = archive.wait()
    if status:
        raise ValueError('被测提交导出失败')
    return {'commit': revision, 'source': 'commit'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('trusted')
    parser.add_argument('destination')
    parser.add_argument('--commit', default='HEAD')
    try:
        print(json.dumps(export_source(**vars(parser.parse_args()))))
    except (ValueError, subprocess.CalledProcessError) as error:
        parser.exit(2, '灰度：'+str(error)+'\n')
