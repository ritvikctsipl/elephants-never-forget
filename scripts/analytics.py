#!/usr/bin/env python
"""
Elephants Never Forget — Analytics Engine

Parses .claude-sessions/ data and computes metrics about session patterns,
decision quality, and collaboration habits.

Usage:
    python analytics.py [--project-dir PATH] [--format json|markdown|html]

Default: reads from CLAUDE_PROJECT_DIR or cwd, outputs markdown.
"""

import json
import sys
import os
import re
import glob
import argparse
from datetime import datetime, timedelta
from collections import Counter, defaultdict

# v1.1.0: transcript-derived metrics
try:
    import transcript_parser
except ImportError:
    # allow module to load even if parser is missing; analytics will skip transcript data
    transcript_parser = None


# ── Unicode chart helpers (zero dependencies) ──────────────────────────

SPARK_CHARS = "▁▂▃▄▅▆▇█"
BLOCK_FULL = "█"
BLOCK_EMPTY = "░"


def sparkline(values):
    """Generate Unicode sparkline from a list of numbers."""
    if not values:
        return ""
    mn, mx = min(values), max(values)
    rng = mx - mn or 1
    return "".join(SPARK_CHARS[min(7, int((v - mn) / rng * 7))] for v in values)


def bar(value, max_value, width=16):
    """Generate Unicode progress bar."""
    if max_value == 0:
        return BLOCK_EMPTY * width
    filled = int(value / max_value * width)
    return BLOCK_FULL * filled + BLOCK_EMPTY * (width - filled)


def pct(numerator, denominator):
    """Safe percentage calculation."""
    if denominator == 0:
        return 0.0
    return round(numerator / denominator * 100, 1)


# ── Data parsers ───────────────────────────────────────────────────────

def parse_frontmatter(content):
    """Extract YAML frontmatter from markdown file."""
    if not content.startswith("---"):
        return {}, content
    end = content.find("---", 3)
    if end == -1:
        return {}, content
    fm_text = content[3:end].strip()
    body = content[end + 3:].strip()

    fm = {}
    for line in fm_text.split("\n"):
        if ":" in line:
            key, _, val = line.partition(":")
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if val.startswith("[") and val.endswith("]"):
                val = [t.strip().strip('"').strip("'") for t in val[1:-1].split(",")]
            fm[key] = val
    return fm, body


def parse_session_file(filepath):
    """Parse a session markdown file into structured data."""
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
    except (FileNotFoundError, PermissionError):
        return None

    fm, body = parse_frontmatter(content)

    session = {
        "file": os.path.basename(filepath),
        "session_id": fm.get("session_id", ""),
        "date": fm.get("date", ""),
        "start_time": fm.get("start_time", ""),
        "tags": fm.get("tags", []),
        "status": fm.get("status", ""),
        "summary": fm.get("summary", ""),
        "decisions": [],
        "reversals": [],
        "errors": [],
        "friction_events": [],
        "files_touched": [],
        "open_items": [],
    }

    current_section = None
    for line in body.split("\n"):
        stripped = line.strip()
        if stripped.startswith("## "):
            current_section = stripped[3:].lower()
        elif current_section == "decisions" and stripped.startswith("- "):
            session["decisions"].append(stripped[2:])
        elif current_section == "reversals" and stripped.startswith("- "):
            session["reversals"].append(stripped[2:])
        elif current_section in ("errors & fixes", "errors and fixes") and stripped.startswith("- "):
            session["errors"].append(stripped[2:])
        elif current_section == "friction events" and stripped.startswith("- "):
            session["friction_events"].append(stripped[2:])
        elif current_section == "files touched" and stripped.startswith("- "):
            session["files_touched"].append(stripped[2:])
        elif current_section == "open items" and stripped.startswith("- ["):
            done = stripped[3] == "x"
            session["open_items"].append({"text": stripped[6:], "done": done})

    return session


def parse_decisions_file(filepath):
    """Parse decisions.md into structured decision records."""
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
    except (FileNotFoundError, PermissionError):
        return []

    decisions = []
    current_topic = ""
    for line in content.split("\n"):
        stripped = line.strip()
        if stripped.startswith("## "):
            current_topic = stripped[3:]
        elif stripped.startswith("- [") and not stripped.startswith("- ~~"):
            date_match = re.match(r"- \[(\d{4}-\d{2}-\d{2})\]", stripped)
            is_superseded = "SUPERSEDED" in stripped
            confidence = "unknown"
            for level in ("high", "medium", "low"):
                if f"Confidence: {level}" in stripped:
                    confidence = level
                    break
            decisions.append({
                "topic": current_topic,
                "date": date_match.group(1) if date_match else "",
                "text": stripped,
                "confidence": confidence,
                "superseded": is_superseded,
            })
        elif stripped.startswith("- ~~") and "SUPERSEDED" in stripped:
            date_match = re.match(r"- ~~\[(\d{4}-\d{2}-\d{2})\]", stripped)
            decisions.append({
                "topic": current_topic,
                "date": date_match.group(1) if date_match else "",
                "text": stripped,
                "confidence": "unknown",
                "superseded": True,
            })

    return decisions


def parse_raw_jsonl(filepath):
    """Parse a raw session JSONL file."""
    events = []
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        events.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
    except (FileNotFoundError, PermissionError):
        pass
    return events


# ── Metric calculations ────────────────────────────────────────────────

def compute_metrics(sessions_dir):
    """Compute all analytics metrics from .claude-sessions/ data."""
    # Load all session files
    session_files = sorted(glob.glob(os.path.join(sessions_dir, "sessions", "*.md")))
    sessions = []
    for f in session_files:
        s = parse_session_file(f)
        if s:
            sessions.append(s)

    # Load decisions
    decisions = parse_decisions_file(os.path.join(sessions_dir, "decisions.md"))

    # Load all raw JSONL files
    raw_files = glob.glob(os.path.join(sessions_dir, "raw", "*.jsonl"))
    all_events = []
    session_events = {}
    for rf in raw_files:
        events = parse_raw_jsonl(rf)
        sid = os.path.basename(rf).replace(".jsonl", "")
        session_events[sid] = events
        all_events.extend(events)

    # ── Basic counts ──
    total_sessions = len(sessions)
    total_decisions = sum(len(s["decisions"]) for s in sessions)
    total_reversals = sum(len(s["reversals"]) for s in sessions)
    total_errors = sum(len(s["errors"]) for s in sessions)
    total_friction = sum(len(s["friction_events"]) for s in sessions)
    total_files = sum(len(s["files_touched"]) for s in sessions)

    completed = [s for s in sessions if s["status"] == "completed"]
    active = [s for s in sessions if s["status"] == "active"]

    # ── All tags ──
    all_tags = []
    for s in sessions:
        if isinstance(s["tags"], list):
            all_tags.extend(s["tags"])
    tag_counts = Counter(all_tags)

    # ── Open items tracking ──
    all_open = []
    for s in sessions:
        all_open.extend(s["open_items"])
    open_done = sum(1 for o in all_open if o["done"])
    open_total = len(all_open)

    # ── Decision confidence distribution ──
    confidence_counts = Counter()
    for d in decisions:
        if not d["superseded"]:
            confidence_counts[d["confidence"]] += 1

    # ── Decision stability (decisions surviving > 7 days) ──
    today = datetime.now().date()
    stable_decisions = 0
    active_decisions = [d for d in decisions if not d["superseded"]]
    for d in active_decisions:
        if d["date"]:
            try:
                d_date = datetime.strptime(d["date"], "%Y-%m-%d").date()
                if (today - d_date).days > 7:
                    stable_decisions += 1
            except ValueError:
                pass

    # ── Sessions by date (for sparkline) ──
    sessions_by_date = Counter()
    for s in sessions:
        if s["date"]:
            sessions_by_date[s["date"]] += 1

    # ── Sessions by day of week ──
    day_of_week_counts = Counter()
    for s in sessions:
        if s["date"]:
            try:
                d = datetime.strptime(s["date"], "%Y-%m-%d")
                day_of_week_counts[d.strftime("%a")] += 1
            except ValueError:
                pass

    # ── Tool usage from raw events ──
    tool_counts = Counter()
    prompt_counts_per_session = {}
    for sid, events in session_events.items():
        prompts = sum(1 for e in events if e.get("event") == "user_prompt")
        prompt_counts_per_session[sid] = prompts
        for e in events:
            if e.get("event") == "tool_use":
                tool_counts[e.get("tool_name", "unknown")] += 1

    # ── Session durations from raw events ──
    session_durations = []
    for sid, events in session_events.items():
        starts = [e for e in events if e.get("event") == "session_start"]
        ends = [e for e in events if e.get("event") == "session_end"]
        if starts and ends:
            try:
                t_start = datetime.fromisoformat(starts[0]["timestamp"])
                t_end = datetime.fromisoformat(ends[-1]["timestamp"])
                duration_min = (t_end - t_start).total_seconds() / 60
                session_durations.append(duration_min)
            except (ValueError, KeyError):
                pass

    # ── Error recurrence (same error text across sessions) ──
    error_texts = []
    for s in sessions:
        for e in s["errors"]:
            # Extract error message between backticks if present
            match = re.search(r"`([^`]+)`", e)
            if match:
                error_texts.append(match.group(1))
    error_counts = Counter(error_texts)
    recurring_errors = {k: v for k, v in error_counts.items() if v > 1}

    # ── Friction by type ──
    friction_types = Counter()
    for s in sessions:
        for f in s["friction_events"]:
            if "redirected" in f.lower():
                friction_types["Redirected approach"] += 1
            elif "abandoned" in f.lower():
                friction_types["Abandoned approach"] += 1
            else:
                friction_types["Other friction"] += 1

    # ── Reversal rate per topic in decisions.md ──
    topic_decision_counts = Counter()
    topic_reversal_counts = Counter()
    for d in decisions:
        topic_decision_counts[d["topic"]] += 1
        if d["superseded"]:
            topic_reversal_counts[d["topic"]] += 1

    # ── Prompts per session stats ──
    prompt_values = list(prompt_counts_per_session.values())
    avg_prompts = round(sum(prompt_values) / len(prompt_values), 1) if prompt_values else 0

    # ── Session focus (sessions with <= 3 tags = focused) ──
    focused_sessions = sum(1 for s in sessions if isinstance(s["tags"], list) and len(s["tags"]) <= 3)

    # ── Build metrics dict ──
    metrics = {
        "summary": {
            "total_sessions": total_sessions,
            "completed_sessions": len(completed),
            "active_sessions": len(active),
            "total_decisions": total_decisions,
            "total_reversals": total_reversals,
            "total_errors": total_errors,
            "total_friction_events": total_friction,
            "total_files_touched": total_files,
        },
        "planning": {
            "reversal_rate": pct(total_reversals, total_decisions),
            "decision_stability": pct(stable_decisions, len(active_decisions)) if active_decisions else 0,
            "confidence_distribution": dict(confidence_counts),
            "reversals_by_topic": dict(topic_reversal_counts),
            "decisions_by_topic": dict(topic_decision_counts),
        },
        "clarity": {
            "friction_rate": pct(total_friction, total_sessions),
            "avg_friction_per_session": round(total_friction / total_sessions, 2) if total_sessions else 0,
            "friction_types": dict(friction_types),
            "avg_prompts_per_session": avg_prompts,
        },
        "efficiency": {
            "completion_rate": pct(len(completed), total_sessions),
            "open_items_completion": pct(open_done, open_total),
            "open_items_pending": open_total - open_done,
            "session_focus_rate": pct(focused_sessions, total_sessions),
            "avg_session_duration_min": round(sum(session_durations) / len(session_durations), 1) if session_durations else 0,
        },
        "patterns": {
            "top_topics": tag_counts.most_common(10),
            "top_tools": tool_counts.most_common(10),
            "sessions_by_day": dict(day_of_week_counts),
            "recurring_errors": dict(recurring_errors),
        },
        "trends": {
            "sessions_by_date": dict(sorted(sessions_by_date.items())),
            "session_durations": session_durations,
            "prompts_per_session": prompt_values,
        },
    }

    # ── v1.1.0: transcript-derived metrics (tokens/cost/pacing/pressure) ──
    tokens_by_sid = {}
    cost_by_sid = {}
    pacing_by_sid = {}
    pressure_by_sid = {}
    cwd = os.path.dirname(os.path.abspath(sessions_dir))  # project root
    if transcript_parser is not None:
        for s in sessions:
            sid = s.get("session_id") or ""
            if not sid:
                continue
            tpath = transcript_parser.find_transcript_path(sid, cwd=cwd)
            if not tpath:
                continue
            t = transcript_parser.parse_transcript(tpath)
            if not t:
                continue
            tokens_by_sid[sid] = transcript_parser.compute_usage_totals(t)
            cost_by_sid[sid] = transcript_parser.estimate_cost(
                tokens_by_sid[sid], model=t.get("model"))
            pacing_by_sid[sid] = transcript_parser.compute_pacing(t)
            pressure_by_sid[sid] = transcript_parser.compute_context_pressure(
                t, model=t.get("model"))
    metrics["tokens"] = tokens_by_sid
    metrics["cost"] = cost_by_sid
    metrics["pacing"] = pacing_by_sid
    metrics["pressure"] = pressure_by_sid

    return metrics


# ── Output formatters ──────────────────────────────────────────────────

def format_markdown(metrics):
    """Format metrics as a markdown dashboard for inline display."""
    m = metrics
    s = m["summary"]
    p = m["planning"]
    c = m["clarity"]
    e = m["efficiency"]
    pat = m["patterns"]
    t = m["trends"]

    lines = []
    lines.append("## Session Analytics Dashboard")
    lines.append("")

    # ── Overview ──
    lines.append("### Overview")
    lines.append("")
    lines.append(f"| Metric | Value |")
    lines.append(f"|--------|-------|")
    lines.append(f"| Sessions | {s['total_sessions']} ({s['completed_sessions']} completed, {s['active_sessions']} active) |")
    lines.append(f"| Decisions tracked | {s['total_decisions']} |")
    lines.append(f"| Reversals | {s['total_reversals']} |")
    lines.append(f"| Errors resolved | {s['total_errors']} |")
    lines.append(f"| Files touched | {s['total_files_touched']} |")

    if t.get("sessions_by_date"):
        dates = sorted(t["sessions_by_date"].keys())
        vals = [t["sessions_by_date"][d] for d in dates]
        lines.append(f"| Activity trend | {sparkline(vals[-14:])} (last 14 days) |")

    if e["avg_session_duration_min"] > 0:
        lines.append(f"| Avg session length | {e['avg_session_duration_min']} min |")

    lines.append("")

    # ── Planning Score ──
    lines.append("### Planning Quality")
    lines.append("")
    rev_rate = p["reversal_rate"]
    stability = p["decision_stability"]
    planning_emoji = "Excellent" if rev_rate < 10 else "Good" if rev_rate < 20 else "Needs attention" if rev_rate < 35 else "Review your planning process"
    lines.append(f"| Metric | Value | Assessment |")
    lines.append(f"|--------|-------|------------|")
    lines.append(f"| Reversal rate | {rev_rate}% | {bar(100 - rev_rate, 100)} |")
    lines.append(f"| Decision stability (>7d) | {stability}% | {bar(stability, 100)} |")
    lines.append(f"| Overall | | {planning_emoji} |")
    lines.append("")

    # Confidence distribution
    conf = p["confidence_distribution"]
    if conf:
        total_conf = sum(conf.values())
        lines.append("**Decision confidence:**")
        for level in ("high", "medium", "low", "unknown"):
            if level in conf:
                count = conf[level]
                lines.append(f"- {level.capitalize()}: {count} ({pct(count, total_conf)}%)  {bar(count, total_conf)}")
        lines.append("")

    # Reversals by topic
    if p["reversals_by_topic"]:
        lines.append("**Reversals by topic:**")
        for topic, count in sorted(p["reversals_by_topic"].items(), key=lambda x: -x[1]):
            total_in_topic = p["decisions_by_topic"].get(topic, count)
            lines.append(f"- {topic}: {count}/{total_in_topic} decisions reversed ({pct(count, total_in_topic)}%)")
        lines.append("")

    # ── Clarity Score ──
    lines.append("### Instruction Clarity")
    lines.append("")
    friction_assessment = "Clear communicator" if c["avg_friction_per_session"] < 0.5 else "Generally clear" if c["avg_friction_per_session"] < 1 else "Some ambiguity" if c["avg_friction_per_session"] < 2 else "Consider planning prompts more carefully"
    lines.append(f"| Metric | Value | Assessment |")
    lines.append(f"|--------|-------|------------|")
    lines.append(f"| Friction rate | {c['friction_rate']}% of sessions | {friction_assessment} |")
    lines.append(f"| Avg redirects/session | {c['avg_friction_per_session']} | |")
    lines.append(f"| Avg prompts/session | {c['avg_prompts_per_session']} | |")
    lines.append("")

    if c["friction_types"]:
        lines.append("**Friction breakdown:**")
        for ftype, count in sorted(c["friction_types"].items(), key=lambda x: -x[1]):
            lines.append(f"- {ftype}: {count}")
        lines.append("")

    # ── Efficiency ──
    lines.append("### Efficiency")
    lines.append("")
    lines.append(f"| Metric | Value |")
    lines.append(f"|--------|-------|")
    lines.append(f"| Session completion rate | {e['completion_rate']}% {bar(e['completion_rate'], 100)} |")
    lines.append(f"| Open items completion | {e['open_items_completion']}% ({e['open_items_pending']} pending) |")
    lines.append(f"| Session focus (<=3 topics) | {e['session_focus_rate']}% |")
    lines.append("")

    # ── Patterns ──
    lines.append("### Where Your Time Goes")
    lines.append("")
    if pat["top_topics"]:
        total_tags = sum(c for _, c in pat["top_topics"])
        for topic, count in pat["top_topics"][:6]:
            lines.append(f"- **{topic}**: {count} sessions ({pct(count, total_tags)}%)  {bar(count, pat['top_topics'][0][1])}")
        lines.append("")

    # Day of week
    if pat["sessions_by_day"]:
        lines.append("**Sessions by day:**")
        day_order = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        max_day = max(pat["sessions_by_day"].values()) if pat["sessions_by_day"] else 1
        for day in day_order:
            count = pat["sessions_by_day"].get(day, 0)
            lines.append(f"- {day}: {bar(count, max_day, 12)} {count}")
        lines.append("")

    # Recurring errors
    if pat["recurring_errors"]:
        lines.append("### Recurring Errors (seen in multiple sessions)")
        lines.append("")
        for err, count in sorted(pat["recurring_errors"].items(), key=lambda x: -x[1]):
            lines.append(f"- `{err[:80]}` ({count} times)")
        lines.append("")

    # ── Token Spend (v1.1.0) ──
    tokens = metrics.get("tokens", {})
    if tokens:
        lines.append("### Token Spend")
        lines.append("")
        total_input = sum(v.get("input", 0) for v in tokens.values())
        total_output = sum(v.get("output", 0) for v in tokens.values())
        total_cache_read = sum(v.get("cache_read", 0) for v in tokens.values())
        total_cache_creation = sum(v.get("cache_creation", 0) for v in tokens.values())
        overall_total = total_input + total_output + total_cache_read + total_cache_creation
        avg_hit_rate = (
            sum(v.get("cache_hit_rate", 0.0) for v in tokens.values()) / len(tokens)
            if tokens else 0.0
        )
        lines.append("| Metric | Value |")
        lines.append("|--------|-------|")
        lines.append(f"| Total input tokens | {total_input:,} |")
        lines.append(f"| Total output tokens | {total_output:,} |")
        lines.append(f"| Total cache_read tokens | {total_cache_read:,} |")
        lines.append(f"| Total cache_creation tokens | {total_cache_creation:,} |")
        lines.append(f"| Overall total | {overall_total:,} |")
        lines.append(f"| Avg cache hit rate | {round(avg_hit_rate, 1)}% {bar(avg_hit_rate, 100)} |")
        lines.append("")

    # ── Estimated Cost (v1.1.0) ──
    cost = metrics.get("cost", {})
    known_costs = [v for v in cost.values() if v.get("cost_usd") is not None]
    if known_costs:
        lines.append("### Estimated Cost")
        lines.append("")
        total_cost = sum(v.get("cost_usd", 0.0) for v in known_costs)
        lines.append(f"| Metric | Value |")
        lines.append(f"|--------|-------|")
        lines.append(f"| Sessions with known pricing | {len(known_costs)} / {len(cost)} |")
        lines.append(f"| Total estimated spend | ${total_cost:.2f} |")
        if len(known_costs) > 0:
            per_sess = total_cost / len(known_costs)
            lines.append(f"| Avg cost per session | ${per_sess:.2f} |")
        disclaimer = known_costs[0].get("disclaimer", "")
        lines.append("")
        lines.append(f"_{disclaimer}_")
        unknown_count = len(cost) - len(known_costs)
        if unknown_count > 0:
            lines.append(f"_{unknown_count} session(s) had unknown models; not priced._")
        lines.append("")

    # ── Context Pressure (v1.1.0) ──
    pressure = metrics.get("pressure", {})
    if pressure:
        known_pressure = [v for v in pressure.values() if v.get("max_utilization_pct") is not None]
        lines.append("### Context Pressure")
        lines.append("")
        total_compactions = sum(v.get("compaction_count", 0) for v in pressure.values())
        lines.append(f"| Metric | Value |")
        lines.append(f"|--------|-------|")
        lines.append(f"| Total compactions across sessions | {total_compactions} |")
        if known_pressure:
            max_seen = max(v.get("max_utilization_pct", 0.0) for v in known_pressure)
            avg_seen = sum(v.get("max_utilization_pct", 0.0) for v in known_pressure) / len(known_pressure)
            lines.append(f"| Peak utilization seen | {max_seen:.1f}% {bar(max_seen, 100)} |")
            lines.append(f"| Avg peak utilization | {avg_seen:.1f}% {bar(avg_seen, 100)} |")
        lines.append("")

    # ── Pacing (v1.1.0) ──
    pacing = metrics.get("pacing", {})
    if pacing:
        lines.append("### Pacing")
        lines.append("")
        medians = [v.get("inter_turn_median_ms", 0.0) for v in pacing.values() if v.get("inter_turn_median_ms", 0.0) > 0]
        total_idle = sum(len(v.get("idle_gaps_sec", [])) for v in pacing.values())
        lines.append(f"| Metric | Value |")
        lines.append(f"|--------|-------|")
        if medians:
            avg_median = sum(medians) / len(medians)
            lines.append(f"| Avg median inter-turn latency | {avg_median/1000:.1f}s |")
        lines.append(f"| Total idle gaps (>60s) | {total_idle} |")
        lines.append("")

    # ── Insights ──
    lines.append("### Insights")
    lines.append("")
    insights = generate_insights(metrics)
    for insight in insights:
        lines.append(f"- {insight}")
    lines.append("")

    return "\n".join(lines)


def generate_insights(metrics):
    """Generate actionable insights from metrics."""
    insights = []
    s = metrics["summary"]
    p = metrics["planning"]
    c = metrics["clarity"]
    e = metrics["efficiency"]
    pat = metrics["patterns"]

    # Planning insights
    if p["reversal_rate"] > 25:
        insights.append(
            f"**High reversal rate ({p['reversal_rate']}%)**: You're reversing 1 in 4 decisions. "
            f"Consider spending more time on initial requirements before committing to an approach."
        )
    elif p["reversal_rate"] > 0 and p["reversal_rate"] <= 10:
        insights.append(
            f"**Stable decision-making ({p['reversal_rate']}% reversal rate)**: Your planning is solid. "
            f"Most decisions stick."
        )

    # Reversal topics
    if p["reversals_by_topic"]:
        worst_topic = max(p["reversals_by_topic"].items(), key=lambda x: x[1])
        if worst_topic[1] >= 2:
            insights.append(
                f"**{worst_topic[0]}** is your most-reversed topic area ({worst_topic[1]} reversals). "
                f"This area might benefit from more upfront research."
            )

    # Confidence insights
    conf = p["confidence_distribution"]
    low_conf = conf.get("low", 0)
    total_conf = sum(conf.values()) if conf else 0
    if total_conf > 0 and pct(low_conf, total_conf) > 30:
        insights.append(
            f"**{pct(low_conf, total_conf)}% of decisions are low-confidence**: "
            f"Many choices feel uncertain. Consider gathering more info before deciding."
        )

    # Friction insights
    if c["avg_friction_per_session"] >= 2:
        insights.append(
            f"**High friction ({c['avg_friction_per_session']} redirects/session)**: "
            f"Try writing a brief goal at the start of each session to reduce mid-session pivots."
        )

    # Completion insights
    if e["completion_rate"] < 70 and s["total_sessions"] >= 5:
        insights.append(
            f"**Low completion rate ({e['completion_rate']}%)**: "
            f"Many sessions end without finishing. Consider smaller, more focused goals per session."
        )

    if e["open_items_pending"] > 10:
        insights.append(
            f"**{e['open_items_pending']} open items pending**: "
            f"Backlog is growing. Consider a cleanup session to close outstanding items."
        )

    # Focus insights
    if e["session_focus_rate"] < 50 and s["total_sessions"] >= 5:
        insights.append(
            f"**Low session focus ({e['session_focus_rate']}%)**: "
            f"Most sessions span many topics. Single-topic sessions tend to be more productive."
        )

    # Recurring errors
    if pat["recurring_errors"]:
        insights.append(
            f"**{len(pat['recurring_errors'])} recurring errors**: "
            f"Some errors keep coming back. Consider documenting fixes in the project."
        )

    if not insights:
        insights.append("Not enough data yet to generate insights. Keep using the system!")

    return insights


def format_json(metrics):
    """Format metrics as JSON."""
    return json.dumps(metrics, indent=2, default=str)


# ── Main ───────────────────────────────────────────────────────────────

def main():
    # Ensure Unicode output works on Windows
    if sys.platform == "win32":
        sys.stdout.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description="Elephants Never Forget — Analytics")
    parser.add_argument("--project-dir", default=os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd()))
    parser.add_argument("--format", choices=["json", "markdown"], default="markdown")
    args = parser.parse_args()

    sessions_dir = os.path.join(args.project_dir, ".claude-sessions")

    if not os.path.isdir(sessions_dir):
        print("No .claude-sessions/ directory found. Start tracking sessions first.")
        sys.exit(1)

    metrics = compute_metrics(sessions_dir)

    if args.format == "json":
        print(format_json(metrics))
    else:
        print(format_markdown(metrics))


if __name__ == "__main__":
    main()
