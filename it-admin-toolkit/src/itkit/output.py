"""Shared output helpers: aligned tables for humans, JSON/CSV for scripts."""
from __future__ import annotations

import csv
import io
import json
import os
import sys

COLORS = {"OK": "32", "WARN": "33", "EXPIRED": "31", "ERROR": "31", "HIGH": "31"}


def use_color() -> bool:
    return sys.stdout.isatty() and os.environ.get("NO_COLOR") is None


def color(text: str, level: str) -> str:
    code = COLORS.get(level)
    return f"\033[{code}m{text}\033[0m" if code and use_color() else text


def table(rows: list[list], headers: list[str]) -> str:
    cells = [[str(c) if c is not None else "-" for c in r] for r in rows]
    widths = [max(len(h), *(len(r[i]) for r in cells)) if cells else len(h) for i, h in enumerate(headers)]
    line = "  ".join(h.ljust(w) for h, w in zip(headers, widths))
    sep = "  ".join("-" * w for w in widths)
    body = ["  ".join(c.ljust(w) for c, w in zip(r, widths)) for r in cells]
    return "\n".join([line, sep, *body])


def to_json(data) -> str:
    return json.dumps(data, indent=2, ensure_ascii=False, default=str)


def to_csv(rows: list[dict]) -> str:
    if not rows:
        return ""
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=list(rows[0]))
    w.writeheader()
    for r in rows:
        w.writerow({k: ";".join(map(str, v)) if isinstance(v, list) else v for k, v in r.items()})
    return buf.getvalue()
