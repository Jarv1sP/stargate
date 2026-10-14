"""Human labels are presentation, NEVER execution/admission identity."""
from __future__ import annotations
from collections.abc import Mapping
from typing import Any
import unicodedata

CAPABILITY = "job-display-v1"


def _text(value: Any, chars: int, byte_limit: int, field: str, *, multiline: bool = False) -> str:
    if not isinstance(value, str) or len(value) > chars:
        raise ValueError(f"invalid display {field}")
    try:
        if len(value.encode("utf-8")) > byte_limit:
            raise ValueError(f"display {field} is too large")
    except UnicodeError as error:
        raise ValueError(f"invalid display {field} Unicode") from error
    if any(unicodedata.category(c) in ("Cc", "Cf", "Cs", "Zl", "Zp")
           and not (multiline and c in "\n\t") for c in value):
        raise ValueError(f"display {field} contains a control character")
    if not multiline and not value.strip():
        raise ValueError(f"display {field} is empty")
    return value


def normalize_display(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"name", "description", "submitter"}:
        raise ValueError("display metadata requires name, description and submitter")
    actor = value["submitter"]
    if not isinstance(actor, dict) or set(actor) != {"name", "username"}:
        raise ValueError("display submitter requires name and username")
    return {
        "name": _text(value["name"], 64, 256, "name"),
        "description": _text(value["description"], 2000, 6000, "description", multiline=True),
        "submitter": {
            "name": _text(actor["name"], 32, 128, "submitter name"),
            "username": _text(actor["username"], 24, 96, "username"),
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
