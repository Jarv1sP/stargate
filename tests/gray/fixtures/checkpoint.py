"""CPU 级别 SDK 进度、保存让位和原任务断点恢复夹具。"""
import json
import time
from pathlib import Path
from gpuq.progress import ProgressReporter
from gpuq.checkpoint import checkpoint_at_epoch_end, resume_checkpoint_path

resume = resume_checkpoint_path()
state = json.loads(Path(resume).read_text()) if resume else {'epoch': 0}
reporter = ProgressReporter(report_interval_seconds=0)

def save():
    target = Path('/workspace/gray-checkpoint.json')
    target.write_text(json.dumps(state))
    print('GRAY_SAVED', flush=True)
    return {'checkpoint_path': str(target), 'resume_epoch': state['epoch']}

if resume:
    assert state['epoch'] > 0
    print('GRAY_RESUMED', flush=True)
    reporter.update(phase='resumed', epochs_completed=state['epoch'], epochs_total=300, force=True)
else:
    for epoch in range(300):
        state['epoch'] = epoch + 1
        assert reporter.update(phase='training', epochs_completed=state['epoch'], epochs_total=300, force=True)
        print('GRAY_PROGRESS', state['epoch'], flush=True)
        checkpoint_at_epoch_end(save)
        time.sleep(1)
reporter.close()
