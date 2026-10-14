"""Task output deletion uses the existing shared seven-day trash."""
import importlib.util
from pathlib import Path


def process(node,args):
    s=importlib.util.spec_from_file_location('outputs_data',Path(__file__).with_name('local-data.py'))
    d=importlib.util.module_from_spec(s);s.loader.exec_module(d)
    root=node.projects().store.workspace_output('','',jobid=args['jobId'],create=False)
    relative=d.relative(args.get('path',''),empty=True)
    source=root/relative
    s=importlib.util.spec_from_file_location('outputs_trash',Path(__file__).with_name('project-purge.py'))
    trash=importlib.util.module_from_spec(s);s.loader.exec_module(trash)
    row=trash.Trash(node.CONFIG).delete(source,args['key'],'output',args.get('actor',{'userId':args['userId']}),
        jobId=args['jobId'],path=relative,originalPathDisplay='/outputs/'+relative)
    return {**row,'complete':True,'freedBytes':0}
