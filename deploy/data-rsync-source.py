"""Read-only forced SSH command for a platform node, never an interactive login."""
import argparse
import os
from pathlib import Path
import re
import shlex


def restricted_request(root, command, personal=False):
    args=shlex.split(command)
    if len(args)<5 or args[0] not in ('rsync','/usr/bin/rsync') or args[1:3]!=['--server','--sender']:
        raise ValueError('Only read-only rsync is allowed')
    separator=args.index('.')
    if len(args)!=separator+2:raise ValueError('One source directory is required')
    path=args[-1]
    if personal:
        owner,slash,path=path.partition('/')
        if not slash or not re.fullmatch('[a-f0-9]{64}',owner):raise ValueError('Invalid personal data owner')
        root=Path(root)/owner/'data'
        if root.is_symlink() or root.parent.is_symlink():raise ValueError('Invalid personal data directory')
        args[-1]=path
    root=Path(root).resolve(strict=True)
    # rrsync consumes rsync's backslash-escaped arguments, not shell quotes.
    encoded=' '.join(re.sub(r"([\s\\'\"])",r'\\\1',value) for value in args)
    return root,encoded


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);parser.add_argument('--personal',action='store_true')
    options=parser.parse_args()
    root,command=restricted_request(options.root,os.environ.get('SSH_ORIGINAL_COMMAND',''),options.personal)
    os.environ['SSH_ORIGINAL_COMMAND']=command
    os.execv('/usr/bin/rrsync',['rrsync','-ro',str(root)])
