"""One explicit runtime cohort for fresh installs and both upgrade paths."""
import ast
import json
import os
import tempfile
from pathlib import Path

HERE=Path(__file__).resolve().parent


def manifest(source=HERE):
    path=Path(source)/'node-runtime.json'
    if path.is_symlink() or not path.is_file():raise SystemExit('Missing deployment manifest: '+str(path))
    value=json.loads(path.read_text())
    if value.get('version')!=1:raise SystemExit('Unsupported node runtime manifest')
    return value


def runtime_plan(profile,source=HERE):
    value=manifest(source)
    if profile not in value['profiles']:raise SystemExit('Unknown node runtime profile')
    selected=value['profiles'][profile]
    names=[*value['dependencies'],*selected['extra'],*value['activation']]
    if len(names)!=len(set(names)) or any(not isinstance(name,str) or Path(name).name!=name for name in names):raise SystemExit('Invalid node runtime manifest files')
    return [(name,selected['runner'] if name=='sandbox-runner.py' else name) for name in names]


def detected_profile(payload):
    tree=ast.parse(payload)
    # Both runners use the shared memory policy. Only the Ray runner exports
    # the discovered cgroup budget; importing the policy no longer selects Ray.
    return 'ray-p0' if any(isinstance(node,ast.Attribute) and node.attr=='read_budget' for node in ast.walk(tree)) else 'common-p0'


def preflight(source,profile):
    """Read and compile the complete cohort before copying any entry point."""
    plan=runtime_plan(profile,source);payloads={}
    for name,original in plan:
        path=Path(source)/original
        if path.is_symlink() or not path.is_file():raise SystemExit('Missing deployment dependency: '+original)
        payload=path.read_bytes();compile(payload,str(path),'exec');payloads[name]=payload
    validate_dependencies(payloads)
    return plan,payloads


def validate_dependencies(payloads):
    for name,payload in payloads.items():
        references={node.value for node in ast.walk(ast.parse(payload)) if isinstance(node,ast.Constant) and isinstance(node.value,str)
                    and node.value.endswith('.py') and node.value[:-3] and Path(node.value).name==node.value}
        missing=references-set(payloads)
        if missing:raise SystemExit('Runtime manifest misses dependencies of '+name+': '+', '.join(sorted(missing)))


def atomic_install(payload,target):
    target=Path(target)
    if target.exists() and target.read_bytes()==payload:target.chmod(0o700);return
    fd,pending=tempfile.mkstemp(prefix='.node-runtime-',dir=target.parent)
    try:
        with os.fdopen(fd,'wb') as stream:stream.write(payload);stream.flush();os.fchmod(stream.fileno(),0o700);os.fsync(stream.fileno())
        os.replace(pending,target)
        directory=os.open(target.parent,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(directory)
        finally:os.close(directory)
    finally:
        if os.path.exists(pending):os.unlink(pending)
