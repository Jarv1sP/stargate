#!/usr/bin/env python3
"""GPUQ launch entrypoint: an existing dispatch reference, never a host command."""
import argparse
import importlib.util
from pathlib import Path
import sys

# Set before loading the immutable runtime cohort, including compatibility helpers.
sys.dont_write_bytecode = True


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument('--config', required=True, type=Path, help='absolute node-private configuration path')
    parser.add_argument('--dispatch-id', required=True)
    parser.add_argument('--plan-digest', required=True)
    args = parser.parse_args(argv)
    try:
        path = Path(__file__).resolve().parents[1] / 'src/bootstrap/training-runner.py'
        spec = importlib.util.spec_from_file_location('v2_training_runner', path)
        bootstrap = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = bootstrap
        spec.loader.exec_module(bootstrap)
        result = bootstrap.run(args.config, dispatch_id=args.dispatch_id, plan_digest=args.plan_digest)
        return result if result >= 0 else 128 - result
    except KeyboardInterrupt:
        return 130
    except Exception as error:
        print('GPUQ V2 runner:', getattr(error, 'code', 'RUNNER_FAILED'), str(error), file=sys.stderr)
        return 125


if __name__ == '__main__':
    raise SystemExit(main())
