"""Shared task presentation; native GPUQ's current command contract."""
def normalize(value):
    value=value or {};actor=value.get('submitter') or {}
    return {'name':str(value.get('name') or ''),'description':str(value.get('description') or ''),
            'submitter':{'name':str(actor.get('name') or ''),'username':str(actor.get('username') or '')}}
def apply(node,native,metadata):
    # These flags are mandatory in the unchanged native coordinator; use its fresh values.
    return node.gpu('set-display',native['id'],'--expected-submit-key='+native['submit_key'],
        '--expected-owner='+native['owner'],'--expected-name='+native['name'],
        '--name='+metadata['name'],'--description='+metadata['description'],
        '--submitter-name='+metadata['submitter']['name'],'--username='+metadata['submitter']['username'])
def edit(node,operation,args):
    native=node.gpu('show',args['nodeJobId']).get('job')
    if not native:raise ValueError('任务状态未知，请按原编号查询。')
    job=args.get('job') or {};metadata=normalize(native.get('display_metadata') or
        {'name':job.get('name',native.get('name')),'submitter':{'name':job.get('username',native.get('owner')),'username':job.get('username',native.get('owner'))}})
    if operation=='tasks.display.set':
        metadata=normalize({**metadata,'name':args.get('name',metadata['name']),'description':args.get('description',metadata['description'])})
        result=apply(node,native,metadata)
        if result.get('display_metadata'):metadata=normalize(result['display_metadata'])
    return {'nodeJobId':native['id'],'available':True,'name':metadata['name'],'description':metadata['description'],'metadata':metadata}
def sync(node,job,metadata,native):
    if metadata is None:return {'state':'UNCHANGED'}
    # Existing human edits remain presentation state; no account comparison.
    existing=native.get('display_metadata')
    if existing:return {'state':'PRESERVED','metadata':normalize(existing)}
    apply(node,native,normalize(metadata));return {'state':'SYNCED'}
