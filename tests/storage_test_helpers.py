"""Synthetic local mount tables for disposable storage fixtures only."""
import os
from pathlib import Path
import shutil
from unittest.mock import patch


def copy_node_sources(target):
    """Keep disposable executors on the same real source closure as node/."""
    source = Path(__file__).resolve().parents[1] / 'node'
    for path in sorted([*source.glob('*.py'), source / 'gpuq-network', source / 'gpuq-ray']):
        shutil.copy2(path, Path(target) / path.name)


def synthetic_capacity(testcase):
    """Dedicated fixture disk; do not depend on the host's 64GiB free floor."""
    capacity = os.statvfs_result((4096, 4096, 2**28, 2**27, 2**27,
                                 2**24, 2**23, 2**23, 0, 255))
    for name in ('statvfs', 'fstatvfs'):
        guard = patch.object(os, name, return_value=capacity)
        guard.start()
        testcase.addCleanup(guard.stop)


def isolated_platform_pin(testcase):
    """Treat a disposable fixture as a node without the host's live root pin.

    Only the exact administrator enable-directory lstat is simulated. All
    other path, FD, inode and mount checks remain real; dedicated root-guard
    tests keep their own temporary enable path and are unaffected.
    """
    original = Path.lstat
    def lstat(path, *args, **kwargs):
        if str(path) == '/etc/gpuq-platform-root':
            raise FileNotFoundError(path)
        return original(path, *args, **kwargs)
    guard = patch.object(Path, 'lstat', new=lstat)
    guard.start()
    testcase.addCleanup(guard.stop)


def local_data_mounts(*points, mount_id_offset=0):
    """Keep real directory/FD guards while simulating dedicated test disks.

    Tests cannot mount actual block devices. Only /proc/self/mountinfo is
    substituted; all file reads, inode checks and O_NOFOLLOW operations remain
    real inside their TemporaryDirectory.
    """
    original = Path.read_text
    points = [Path(point).resolve() for point in points]

    def read_text(path, *args, **kwargs):
        if str(path) != "/proc/self/mountinfo":
            return original(path, *args, **kwargs)
        rows = ["1 0 999:999 / / rw - ext4 /dev/test-root rw"]
        for index, point in enumerate(points, start=2 + mount_id_offset):
            device = point.stat().st_dev
            target = str(point).replace("\\", r"\134").replace(" ", r"\040")
            rows.append(f"{index} 1 {os.major(device)}:{os.minor(device)} / {target} rw - ext4 /dev/test-data rw")
        return "\n".join(rows) + "\n"

    return patch.object(Path, "read_text", new=read_text)
