"""Consistent online backup of the account database and its invitation key."""
import argparse
import os
import shutil
import sqlite3
from pathlib import Path


def backup(database, destination):
    database, destination = Path(database).resolve(), Path(destination).resolve()
    os.umask(0o077)
    destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as source:
        with sqlite3.connect(destination / database.name) as target:
            source.backup(target)
    shutil.copy2(str(database) + '.key', destination / (database.name + '.key'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('database', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    backup(args.database, args.destination)
