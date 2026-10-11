"""Existing native finalizer contract with a temporary read-only scheduler."""
import ast
from contextlib import closing
from pathlib import Path
import sqlite3


def install(fixture):
    definition=ast.parse((Path(__file__).resolve().parents[1]/'deploy/node-executor.py').read_text())
    function=next(row for row in definition.body if isinstance(row,ast.FunctionDef) and row.name=='scheduler_terminal_confirmed')
    scope={}
    exec(compile(ast.Module(body=[function],type_ignores=[]),'<native-finalizer>','exec'),scope)
    fixture.node.scheduler_terminal_confirmed=scope['scheduler_terminal_confirmed']
    database=fixture.root/'scheduler.sqlite'
    with closing(sqlite3.connect(database)) as db:
        db.execute('CREATE TABLE jobs(id TEXT,submit_key TEXT UNIQUE,state TEXT)');db.commit()
    fixture.node.CONFIG['database']=str(database)
    snapshots={}
    fixture.node.gpu=lambda action,key:snapshots[key]
    def state(key,value,**changes):
        native='J'+key.replace('-','')[:12]
        with closing(sqlite3.connect(database)) as db:
            db.execute('INSERT OR REPLACE INTO jobs VALUES(?,?,?)',(native,key,value));db.commit()
        snapshots[native]={'job':{'state':value,'active_attempt_id':None},'attempts':[],
                          'leases':[],'scale_up_reservations':[],**changes}
    fixture.native_state=state
