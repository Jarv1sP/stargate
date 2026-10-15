"""G09 long job: hold a CUDA context in this process and one child, then sleep."""
import json
import os
import subprocess
import sys
import time

CHILD = 'import time,torch;x=torch.ones(1,device="cuda");time.sleep(3600)'
uuids = []
try:
    out = subprocess.run(['nvidia-smi', '--query-gpu=uuid', '--format=csv,noheader'],
                         capture_output=True, text=True, timeout=30)
    uuids = [line.strip() for line in out.stdout.splitlines() if line.strip()]
except (OSError, subprocess.SubprocessError):
    pass
child = None
try:
    import torch
    x = torch.ones(1, device='cuda')
    child = subprocess.Popen([sys.executable, '-c', CHILD])
except ImportError:
    child = subprocess.Popen(['sleep', '3600'])
print('GRAY-SLEEPER ' + json.dumps({'visibleGpuUuids': uuids, 'pid': os.getpid(), 'child': child.pid}), flush=True)
for i in range(3600):
    print(f'tick {i}', flush=True)
    time.sleep(1)
