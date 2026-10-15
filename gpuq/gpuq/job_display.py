"""Human labels are presentation, NEVER execution/admission identity."""
from __future__ import annotations
from collections.abc import Mapping
from typing import Any

CAPABILITY = "job-display-v1"


def _text(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"display {field} must be text")
    return value


def normalize_display(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("display metadata requires name, description and submitter")
    actor = value["submitter"]
    if not isinstance(actor, dict):
        raise ValueError("display submitter requires name and username")
    return {
        "name": _text(value["name"], "name"),
        "description": _text(value["description"], "description"),
        "submitter": {
            "name": _text(actor["name"], "submitter name"),
            "username": _text(actor["username"], "username"),
        },
    }


def labels(job: Mapping[str, Any]) -> tuple[str, str]:
    value = job.get("display_metadata")
    if value:
        metadata = normalize_display(value)
        actor = metadata["submitter"]
        # Show login identity as well when the chosen display name differs.
        submitter = actor["name"] if actor["name"] == actor["username"] else f'{actor["name"]} ({actor["username"]})'
        return submitter, metadata["name"]
    return str(job.get("owner") or "-"), str(job.get("name") or "-")
