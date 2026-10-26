"""Durable bodies for small members of one private incremental-copy staging area."""
import os,sqlite3,stat
from pathlib import Path


class CopyBatches:
    def __init__(self,root,*,write=False):
        self.db=None;file=Path(root)/'.copy-batches.sqlite3'
        flags=(os.O_RDWR|os.O_CREAT if write else os.O_RDONLY)|os.O_NOFOLLOW|os.O_NONBLOCK
        try:fd=os.open(file,flags,0o600)
        except FileNotFoundError:
            if write:raise
            return
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):raise ValueError('复制缓存不是普通文件。')
        finally:os.close(fd)
        self.db=sqlite3.connect(file if write else file.absolute().as_uri()+'?mode=ro',uri=not write)
        if write:
            self.db.execute('PRAGMA synchronous=FULL')
            self.db.execute('CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,body BLOB NOT NULL)')

    def __enter__(self):return self

    def __exit__(self,*args):
        if self.db:self.db.close()

    def size(self,path):
        row=self.db.execute('SELECT length(body) FROM files WHERE path=?',(path,)).fetchone() if self.db else None
        return row[0] if row else None

    def body(self,path):
        row=self.db.execute('SELECT body FROM files WHERE path=?',(path,)).fetchone() if self.db else None
        return row[0] if row else None

    def put(self,entries,raw,start):
        with self.db:
            self.db.executemany('INSERT OR REPLACE INTO files VALUES(?,?)',
                [(row['path'],memoryview(raw)[row['remoteOffset']-start:row['remoteOffset']-start+row['size']]) for row in entries])
