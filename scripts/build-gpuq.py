#!/usr/bin/env python3
"""Build a source-only zipapp; never bundle caches, configuration or databases."""
from pathlib import Path
import zipfile
root=Path(__file__).resolve().parents[1]
if not (root/'gpuq').is_dir():
    raise SystemExit('PENDING: 待 node/gpuq 入库；未生成空归档')
target=root/'build/gpuq.pyz';target.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(target,'w',compression=zipfile.ZIP_DEFLATED) as archive:
    for path in sorted((root/'gpuq').rglob('*.py')):
        if '__pycache__' not in path.parts:
            info=zipfile.ZipInfo(str(path.relative_to(root/'gpuq')),(2026,1,1,0,0,0))
            info.compress_type=zipfile.ZIP_DEFLATED
            archive.writestr(info,path.read_bytes())
print(target)
