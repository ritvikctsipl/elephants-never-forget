#!/usr/bin/env python
"""Elephants Never Forget — Transcript Parser.

Pure, stateless module that reads a Claude Code transcript JSONL and computes
derived metrics (token usage, cost estimate, inter-turn pacing, context pressure).

Runtime: stdlib only. Defensive: never raises; returns {} or None on failure.
"""

import glob
import json
import os
from pathlib import Path


def parse_transcript(path):
    """Read a transcript JSONL at `path`. Return a dict with messages, usage, tools, compactions.

    Structure:
        {
            "messages": [dict, ...],
            "usage_per_message": [dict, ...],  # one per assistant message with usage
            "tool_uses": [dict, ...],
            "compactions": [dict, ...],
            "model": str | None,
        }

    Returns {} on any failure (missing file, permission error).
    Per-line parse failures are skipped silently.
    """
    if not path or not os.path.isfile(path):
        return {}
    try:
        messages = []
        usage_per_message = []
        tool_uses = []
        compactions = []
        model = None
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                messages.append(entry)
                msg = entry.get("message", {}) if isinstance(entry.get("message"), dict) else {}
                if msg.get("usage"):
                    usage_per_message.append({
                        "timestamp": entry.get("timestamp"),
                        "usage": msg["usage"],
                    })
                if not model and msg.get("model"):
                    model = msg["model"]
                content = msg.get("content", []) if isinstance(msg.get("content"), list) else []
                for c in content:
                    if isinstance(c, dict) and c.get("type") == "tool_use":
                        tool_uses.append({
                            "timestamp": entry.get("timestamp"),
                            "name": c.get("name"),
                            "input": c.get("input"),
                        })
                if entry.get("type") == "system" and entry.get("subtype") == "compact_boundary":
                    compactions.append({"timestamp": entry.get("timestamp")})
        return {
            "messages": messages,
            "usage_per_message": usage_per_message,
            "tool_uses": tool_uses,
            "compactions": compactions,
            "model": model,
        }
    except (OSError, PermissionError):
        return {}


def find_transcript_path(session_id, cwd=None):
    """Locate the transcript JSONL for a given session_id.

    Tries Claude Code's conventional layout first:
        ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
    where <encoded-cwd> is the cwd with '/' replaced by '-', prefixed with '-'.

    Falls back to a glob search under ~/.claude/projects/.
    Returns the first match, or None.
    """
    if not session_id:
        return None
    home = str(Path.home())
    projects_root = os.path.join(home, ".claude", "projects")
    if not os.path.isdir(projects_root):
        return None

    # Direct path
    if cwd:
        encoded = cwd.replace(os.sep, "-")
        if not encoded.startswith("-"):
            encoded = "-" + encoded
        direct = os.path.join(projects_root, encoded, f"{session_id}.jsonl")
        if os.path.isfile(direct):
            return direct

    # Fallback glob
    pattern = os.path.join(projects_root, "*", f"{session_id}.jsonl")
    matches = glob.glob(pattern)
    return matches[0] if matches else None


def compute_usage_totals(transcript):
    """Sum token usage across all assistant messages.

    Returns dict with keys: input, output, cache_read, cache_creation, total, cache_hit_rate.
    cache_hit_rate is cache_read / (cache_read + input), expressed as a percentage.
    Empty transcript → all zeros.
    """
    totals = {"input": 0, "output": 0, "cache_read": 0, "cache_creation": 0}
    for entry in transcript.get("usage_per_message", []):
        u = entry.get("usage", {})
        totals["input"] += int(u.get("input_tokens", 0) or 0)
        totals["output"] += int(u.get("output_tokens", 0) or 0)
        totals["cache_read"] += int(u.get("cache_read_input_tokens", 0) or 0)
        totals["cache_creation"] += int(u.get("cache_creation_input_tokens", 0) or 0)
    totals["total"] = sum(totals.values())
    denom = totals["cache_read"] + totals["input"]
    totals["cache_hit_rate"] = round(totals["cache_read"] / denom * 100, 2) if denom > 0 else 0.0
    return totals
