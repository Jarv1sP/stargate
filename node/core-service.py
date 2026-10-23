#!/usr/bin/python3
"""Fixed service launch into the common core; not a public RPC entry."""
import importlib.util
import os
from pathlib import Path
import sys

sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent


def load(name,file):
    spec=importlib.util.spec_from_file_location(name,HERE/file)
    module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module)
    return module


def main(argv):
    runtime=load('stargate_service_runtime','runtime-profile.py')
    if (len(argv)!=4 or argv[1]!='--profile'
            or (argv[2],argv[3]) not in {('FGK','--direct-upload-daemon'),
                                       ('1zz','--direct-upload-daemon'),
                                       ('R6t','--container-usage-refresh'),
                                       ('peer','--transfer-peer-daemon'),('7IM','--storage-collect')}):
        raise ValueError('Fixed reviewed service profile required')
    runtime.activate(argv[2]);runtime.check_directories(argv[2])
    node=load('stargate_personal_http_node','node-executor.py')
    node.platform_root_check()
    if argv[3]=='--storage-collect':
        return node.storage_collect()
    if argv[3]=='--transfer-peer-daemon':
        peer=load('stargate_transfer_peer','transfer-peer.py')
        return peer.serve(node,node.transfers())
    if argv[3]=='--container-usage-refresh':
        observer=load('stargate_container_observer','container-usage.py')
        return 0 if observer.refresh(node,seconds=5,entries=100000) else 0
    direct=load('stargate_personal_http','direct-upload.py')
    return direct.serve(node)


if __name__=='__main__':
    os.umask(0o077)
    main(sys.argv)
