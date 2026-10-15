#!/usr/bin/env python3
"""只导出被测代码；运行剧本、栈和豁免仍从可信仓库读取。"""
import argparse
import json
from pathlib import Path
import shutil
import subprocess


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args])


def export_source(trusted, destination, commit=None, worktree=None, allow_dirty=False):
    if allow_dirty and not worktree:
        raise ValueError('--allow-dirty 必须与 --worktree 一起使用')
    repo = Path(git(worktree or trusted, 'rev-parse', '--show-toplevel').decode().strip())
    revision = git(repo, 'rev-parse', '--verify', '--end-of-options', (commit or ('HEAD' if worktree else 'origin/main'))+'^{commit}').decode().strip()
    # npm ci 生成的依赖由被测导出目录重新安装，不依赖开发者私有 Git 排除表。
    untracked = git(repo, 'ls-files', '--others', '--exclude-standard', '--exclude=node_modules/', '-z') if worktree else b''
    dirty = bool(worktree and (git(repo, 'status', '--porcelain', '--untracked-files=no') or untracked))
    if dirty and not allow_dirty:
        raise ValueError('被测工作树有未提交改动；请先提交，或明确加 --allow-dirty')
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    if dirty:
        # 包含未忽略的新文件及当前已跟踪文件；不复制 .git、忽略文件或已删除文件。
        names = set((git(repo, 'ls-files', '--cached', '-z') + untracked).split(b'\0'))
        for raw in sorted(names):
            if not raw:
                continue
            relative = Path(raw.decode())
            source, target = repo/relative, destination/relative
            if source.is_file() or source.is_symlink():
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target, follow_symlinks=False)
    else:
        archive = subprocess.Popen(['git', '-C', str(repo), 'archive', revision], stdout=subprocess.PIPE)
        try:
            subprocess.run(['tar', '-xf', '-', '-C', str(destination)], stdin=archive.stdout, check=True)
        finally:
            archive.stdout.close()
        if archive.wait():
            raise ValueError('被测提交导出失败')
    return {'commit': revision, 'dirty': dirty, 'source': 'worktree' if worktree else 'commit'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('trusted')
    parser.add_argument('destination')
    source = parser.add_mutually_exclusive_group()
    source.add_argument('--commit')
    source.add_argument('--worktree')
    parser.add_argument('--allow-dirty', action='store_true')
    try:
        print(json.dumps(export_source(**vars(parser.parse_args()))))
    except (ValueError, subprocess.CalledProcessError) as error:
        parser.exit(2, '灰度：'+str(error)+'\n')
