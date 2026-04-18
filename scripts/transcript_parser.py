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


# Public pricing as of 2026-01 (USD per million tokens). Update when rates change.
PRICING_TABLE_V1 = {
    "claude-opus-4-7":    {"input": 15.00, "output": 75.00, "cache_read": 1.50,  "cache_creation": 18.75},
    "claude-opus-4-6":    {"input": 15.00, "output": 75.00, "cache_read": 1.50,  "cache_creation": 18.75},
    "claude-sonnet-4-6":  {"input":  3.00, "output": 15.00, "cache_read": 0.30,  "cache_creation":  3.75},
    "claude-sonnet-4-5":  {"input":  3.00, "output": 15.00, "cache_read": 0.30,  "cache_creation":  3.75},
    "claude-haiku-4-5":   {"input":  0.80, "output":  4.00, "cache_read": 0.08,  "cache_creation":  1.00},
}
_PRICING_AS_OF = "2026-01"


def _normalize_model(model):
    """Strip suffixes like '[1m]' and version-date suffixes; lowercase."""
    if not model:
        return None
    m = model.lower().strip()
    # Strip bracketed suffix: 'claude-opus-4-7[1m]' -> 'claude-opus-4-7'
    if "[" in m:
        m = m.split("[", 1)[0]
    # Strip date suffix: 'claude-haiku-4-5-20251001' -> 'claude-haiku-4-5'
    parts = m.rsplit("-", 1)
    if len(parts) == 2 and parts[1].isdigit() and len(parts[1]) == 8:
        m = parts[0]
    return m


def estimate_cost(usage, model=None):
    """Compute estimated cost in USD from a usage dict and model identifier.

    Returns {
        "cost_usd": float | None,
        "disclaimer": str,
        "model": str | None,
        "pricing_version": "v1",
    }
    Unknown model → cost_usd=None with explanation.
    """
    model_norm = _normalize_model(model)
    pricing = PRICING_TABLE_V1.get(model_norm)
    if not pricing:
        return {
            "cost_usd": None,
            "disclaimer": f"Unknown model '{model}'. Cost cannot be estimated.",
            "model": model,
            "pricing_version": "v1",
        }
    cost = (
        usage.get("input", 0)          * pricing["input"]         +
        usage.get("output", 0)         * pricing["output"]        +
        usage.get("cache_read", 0)     * pricing["cache_read"]    +
        usage.get("cache_creation", 0) * pricing["cache_creation"]
    ) / 1_000_000.0
    return {
        "cost_usd": round(cost, 4),
        "disclaimer": f"Estimate based on public rates as of {_PRICING_AS_OF}; may drift.",
        "model": model,
        "pricing_version": "v1",
    }


from datetime import datetime as _dt


def _parse_ts(s):
    if not s:
        return None
    try:
        # Accept both Z and +00:00 suffixes
        return _dt.fromisoformat(s.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def _percentile(values, p):
    """Nearest-rank percentile. values must be sorted."""
    if not values:
        return 0.0
    idx = min(len(values) - 1, int(round((p / 100.0) * (len(values) - 1))))
    return values[idx]


def compute_pacing(transcript):
    """Compute inter-turn latencies and idle gaps.

    Returns {
        "inter_turn_median_ms": float,
        "inter_turn_p95_ms": float,
        "idle_gaps_sec": [float],    # gaps > 60s between consecutive messages
        "prompt_to_first_tool_ms": [float],  # user prompt -> first tool_use after it
    }
    """
    messages = transcript.get("messages", [])
    deltas_ms = []
    idle_gaps = []
    prev_ts = None
    for m in messages:
        ts = _parse_ts(m.get("timestamp"))
        if ts is None:
            continue
        if prev_ts is not None:
            delta = (ts - prev_ts).total_seconds()
            deltas_ms.append(delta * 1000.0)
            if delta > 60:
                idle_gaps.append(round(delta, 1))
        prev_ts = ts

    prompt_to_tool = []
    tool_uses = transcript.get("tool_uses", [])
    user_ts_list = [_parse_ts(m.get("timestamp")) for m in messages if m.get("type") == "user"]
    user_ts_list = [t for t in user_ts_list if t is not None]
    for u_ts in user_ts_list:
        following_tools = [
            _parse_ts(t.get("timestamp")) for t in tool_uses
            if _parse_ts(t.get("timestamp")) and _parse_ts(t.get("timestamp")) > u_ts
        ]
        if following_tools:
            delta_s = (min(following_tools) - u_ts).total_seconds()
            prompt_to_tool.append(round(delta_s * 1000.0, 1))

    deltas_sorted = sorted(deltas_ms)
    return {
        "inter_turn_median_ms": round(_percentile(deltas_sorted, 50), 1),
        "inter_turn_p95_ms": round(_percentile(deltas_sorted, 95), 1),
        "idle_gaps_sec": idle_gaps,
        "prompt_to_first_tool_ms": prompt_to_tool,
    }


# Context window sizes in tokens. Missing model → window_tokens=None, utilization=None.
MODEL_WINDOWS = {
    "claude-opus-4-7":    200_000,
    "claude-opus-4-6":    200_000,
    "claude-sonnet-4-6":  200_000,
    "claude-sonnet-4-5":  200_000,
    "claude-haiku-4-5":   200_000,
}


def compute_context_pressure(transcript, model=None):
    """Estimate context window utilization over the session.

    Reconstructs cumulative input token load between compactions. Utilization is
    the peak cumulative load divided by the model's window size.

    Returns {
        "window_tokens": int | None,
        "max_utilization_pct": float | None,
        "compaction_count": int,
        "utilization_trend": [(timestamp, pct), ...],
    }
    Unknown model → window_tokens and max_utilization_pct are None; trend is empty.
    """
    model_norm = _normalize_model(model)
    window = MODEL_WINDOWS.get(model_norm)
    compactions = transcript.get("compactions", [])
    compaction_count = len(compactions)

    if window is None:
        return {
            "window_tokens": None,
            "max_utilization_pct": None,
            "compaction_count": compaction_count,
            "utilization_trend": [],
        }

    compact_ts = sorted(c.get("timestamp") for c in compactions if c.get("timestamp"))
    running = 0
    max_load = 0
    trend = []
    next_compact_idx = 0
    for entry in transcript.get("usage_per_message", []):
        ts = entry.get("timestamp")
        if next_compact_idx < len(compact_ts) and ts and ts >= compact_ts[next_compact_idx]:
            running = 0  # post-compaction: context has been summarized
            next_compact_idx += 1
        u = entry.get("usage", {})
        running += int(u.get("input_tokens", 0) or 0) + int(u.get("cache_read_input_tokens", 0) or 0)
        max_load = max(max_load, running)
        pct = round(running / window * 100, 2)
        trend.append((ts, pct))

    return {
        "window_tokens": window,
        "max_utilization_pct": round(max_load / window * 100, 2),
        "compaction_count": compaction_count,
        "utilization_trend": trend,
    }
