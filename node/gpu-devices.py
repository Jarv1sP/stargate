"""Resolve allocated physical UUIDs to kernel device nodes, never GPU indices.

NVIDIA inventory/CUDA ordinals need not equal /dev/nvidiaN device minors.
Read the driver's proc records directly: NVML may be intercepted by LD_PRELOAD.
"""
from itertools import islice
import os
from pathlib import Path
import re
import stat

UUID = re.compile(r'GPU-[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\Z')
PCI = re.compile(r'[0-9a-fA-F]{4}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}\.[0-7]\Z')
MAX_GPUS = 128
MAX_INFORMATION_BYTES = 8192


def device_paths(uuids, *, proc_root=Path('/proc/driver/nvidia/gpus'), dev_root=Path('/dev')):
    """Fail closed on ambiguous/missing identity or an unexpected device node.

    Paths are test seams, not node configuration. Production callers pass only
    scheduler-owned UUIDs. No CUDA context, NVML, subprocess, or device open.
    """
    if (not isinstance(uuids, list) or not 1 <= len(uuids) <= 64
            or any(not isinstance(value, str) or not UUID.fullmatch(value) for value in uuids)):
        raise ValueError('Invalid allocated physical GPU UUIDs')
    wanted = [value.lower() for value in uuids]
    if len(set(wanted)) != len(wanted):
        raise ValueError('Duplicate allocated GPU UUID')
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    inventory, minors = {}, set()
    try:
        root = os.open(proc_root, directory_flags)
        try:
            with os.scandir(root) as entries:
                names = [entry.name for entry in islice(entries, MAX_GPUS + 1)]
            if not names or len(names) > MAX_GPUS:
                raise ValueError('GPU driver inventory is empty or oversized')
            for name in names:
                if not PCI.fullmatch(name):
                    raise ValueError('Invalid GPU driver inventory entry')
                directory = os.open(name, directory_flags, dir_fd=root)
                try:
                    descriptor = os.open('information', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                    with os.fdopen(descriptor, 'rb') as stream:
                        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                            raise ValueError('GPU driver information is not a regular proc file')
                        content = stream.read(MAX_INFORMATION_BYTES + 1)
                    if len(content) > MAX_INFORMATION_BYTES:
                        raise ValueError('GPU driver information exceeds bound')
                finally:
                    os.close(directory)
                fields = {}
                for line in content.decode('ascii').splitlines():
                    key, separator, value = line.partition(':')
                    if separator and key.strip() in ('GPU UUID', 'Device Minor'):
                        key, value = key.strip(), value.strip()
                        if key in fields:
                            raise ValueError('Duplicate GPU driver identity field')
                        fields[key] = value
                identity, minor = fields.get('GPU UUID', ''), fields.get('Device Minor', '')
                if not UUID.fullmatch(identity) or not re.fullmatch(r'0|[1-9][0-9]{0,2}', minor) or not 0 <= int(minor) < 255:
                    raise ValueError('Invalid GPU driver UUID or device minor')
                identity, minor = identity.lower(), int(minor)
                if identity in inventory or minor in minors:
                    raise ValueError('Duplicate GPU driver UUID or device minor')
                inventory[identity] = minor
                minors.add(minor)
        finally:
            os.close(root)
        result = []
        for identity in wanted:
            if identity not in inventory:
                raise ValueError('Allocated GPU UUID is missing from driver inventory')
            minor = inventory[identity]
            device = Path(dev_root) / ('nvidia' + str(minor))
            info = device.lstat()  # Do not accept a symlink, ordinary file or renamed device.
            if (not stat.S_ISCHR(info.st_mode) or info.st_uid != 0
                    or os.major(info.st_rdev) != 195 or os.minor(info.st_rdev) != minor):
                raise ValueError('Allocated GPU device node identity mismatch')
            result.append(str(device))
        return result
    except (OSError, UnicodeError) as error:
        raise ValueError('Cannot verify allocated GPU device mapping') from error
