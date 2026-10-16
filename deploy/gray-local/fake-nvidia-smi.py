#!/usr/bin/env python3
"""SIMULATED nvidia-smi for the gray stack's cpu tier only (never installed on
real nodes). Answers exactly the CSV queries the node programs and GPUQ issue,
for the fake GPUs listed in /etc/gray-sim/gpus.json. Like the real tool it
only shows GPUs whose device node exists here, so a sandbox or container sees
exactly its allocated GPUs. Compute processes: none, nothing runs on a
simulated GPU."""
import json
import os
import sys

GPUS = [g for g in json.load(open('/etc/gray-sim/gpus.json')) if os.path.exists(f"/dev/nvidia{g['minor']}")]
args = sys.argv[1:]
query = next((a.split('=', 1) for a in args if a.startswith('--query-')), None)
ids = next((args[i + 1].split(',') for i, a in enumerate(args) if a in ('--id', '-i') and i + 1 < len(args)), None)
if not query:
    for gpu in GPUS:
        print(f"GPU {gpu['index']}: {gpu['name']} (UUID: {gpu['uuid']})")
    raise SystemExit(0)
kind, fields = query[0], query[1].split(',')
if kind == '--query-compute-apps':
    raise SystemExit(0)
if kind != '--query-gpu':
    print(f'gray-sim: unsupported query {kind}', file=sys.stderr)
    raise SystemExit(2)
values = {'index': lambda g: g['index'], 'uuid': lambda g: g['uuid'], 'name': lambda g: g['name'],
          'pci.bus_id': lambda g: g['pci'],
          'memory.total': lambda g: 8192, 'memory.used': lambda g: 0, 'memory.free': lambda g: 8192,
          'utilization.gpu': lambda g: 0, 'temperature.gpu': lambda g: 30, 'power.draw': lambda g: 10.0,
          'power.limit': lambda g: 100.0}
for gpu in GPUS:
    if ids and gpu['uuid'] not in ids and str(gpu['index']) not in ids:
        continue
    row = []
    for field in fields:
        if field not in values:
            print(f'gray-sim: unsupported field {field}', file=sys.stderr)
            raise SystemExit(2)
        row.append(str(values[field](gpu)))
    print(', '.join(row))
