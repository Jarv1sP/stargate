#!/usr/bin/env python3
"""固定种子 600 张 28×28 灰度图片及 labels.csv；只统计文件数与总字节数。"""
import json
import random
import sys
from pathlib import Path
NAME='gray-digits'
SEED=20261014
COUNT,SIZE,CLASSES=600,28,10

def image(rng, label):
    """A class-specific stripe pattern plus noise: learnable, but not trivial."""
    pixels = bytearray(SIZE * SIZE)
    for y in range(SIZE):
        for x in range(SIZE):
            on = ((x + label * 3) // 4 + (y if label % 2 else -y) // 7) % 2 == 0
            value = (170 if on else 40) + rng.randint(-35, 35)
            pixels[y * SIZE + x] = max(0, min(255, value))
    return b'P5\n%d %d\n255\n' % (SIZE, SIZE) + bytes(pixels)


def files():
    rng = random.Random(SEED)
    out, labels = {}, ['file,label']
    for index in range(COUNT):
        label = index % CLASSES
        name = f'images/{index:04d}.pgm'
        out[name] = image(rng, label)
        labels.append(f'{name},{label}')
    out['labels.csv'] = ('\n'.join(labels) + '\n').encode()
    return dict(sorted(out.items()))


if __name__=='__main__':
    root=Path(sys.argv[1])/NAME
    content=files()
    for name,data in content.items():
        path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
    print(json.dumps(dict(directory=str(root),files=len(content),bytes=sum(map(len,content.values())))))
