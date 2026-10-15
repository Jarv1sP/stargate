"""纯 Python CPU 训练夹具：从 /datasets 读取，按文件数与总字节数核对，写 /outputs。"""
import json
import math
import os
import random
import subprocess
import sys
from pathlib import Path

root = Path(sys.argv[1] if len(sys.argv) > 1 else '/datasets/gray-digits')
names = sorted(str(p.relative_to(root)) for p in root.rglob('*') if p.is_file())
total_bytes = sum((root / n).stat().st_size for n in names)


def pixels(path):
    data = (root / path).read_bytes()
    header_end = data.index(b'255\n') + 4
    return [b / 255.0 for b in data[header_end:]][::4]  # 196 features keeps CPU time small


rows = [line.split(',') for line in (root / 'labels.csv').read_text().splitlines()[1:]]
samples = [(pixels(name), int(label)) for name, label in rows]
features, classes = len(samples[0][0]), 10
rng = random.Random(7)
weights = [[0.0] * features for _ in range(classes)]
losses = []
for epoch in range(4):
    rng.shuffle(samples)
    total = 0.0
    for x, y in samples:
        scores = [sum(w * v for w, v in zip(weights[c], x)) for c in range(classes)]
        top = max(scores)
        exps = [math.exp(s - top) for s in scores]
        norm = sum(exps)
        probs = [e / norm for e in exps]
        total -= math.log(max(probs[y], 1e-12))
        for c in range(classes):
            grad = probs[c] - (1.0 if c == y else 0.0)
            if grad:
                row = weights[c]
                for i, v in enumerate(x):
                    row[i] -= 0.05 * grad * v
    losses.append(round(total / len(samples), 6))
correct = sum(max(range(classes), key=lambda c: sum(w * v for w, v in zip(weights[c], x))) == y for x, y in samples)
try:
    out = subprocess.run(['nvidia-smi', '--query-gpu=uuid', '--format=csv,noheader'], capture_output=True, text=True, timeout=30)
    gpus = [line.strip() for line in out.stdout.splitlines() if line.strip()]
except (OSError, subprocess.SubprocessError):
    gpus = None
result = json.dumps({'dataset': root.name, 'bytes': total_bytes, 'files': len(names), 'loss': losses,
                     'accuracy': round(correct / len(samples), 4), 'visibleGpuUuids': gpus,
                     'cudaVisibleDevices': os.environ.get('CUDA_VISIBLE_DEVICES')}, sort_keys=True).encode()
os.makedirs('/outputs', exist_ok=True)
Path('/outputs/result.json').write_bytes(result)
print('GRAY-TRAIN ' + result.decode(), flush=True)
