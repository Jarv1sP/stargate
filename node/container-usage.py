"""Existing observer/timer delegates to the same fixed hosts sampler."""
import importlib.util,time
from pathlib import Path
def module(name):
    s=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
def sample(node):
    value=module('node-probe').probe(node.CONFIG)
    value.update(machine=node.CONFIG['machine'],observedAt=time.time());return value
def refresh(node,seconds=5,entries=None):
    d=module('local-data');s=module('project-store');folder=s.private_dir(d.root(node.CONFIG,'root')/'samples',create=True)
    value=sample(node);s.atomic_json(folder/'host.json',value);return value
