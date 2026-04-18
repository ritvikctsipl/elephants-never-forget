#!/usr/bin/env python
"""Elephants Never Forget — Hard Gate.

Runs on UserPromptSubmit and PreToolUse. Fails open on any error (default allow).
Hot-path target: <5ms per invocation when today's session file exists.
"""

import glob
import json
import os
import re
import sys
from datetime import datetime, timezone


def sanitize_session_id(sid):
    """Strip anything not alphanumeric or hyphen. Returns 'unknown' for empty result."""
    return re.sub(r"[^a-zA-Z0-9\-]", "", sid or "") or "unknown"


def get_sessions_dir():
    """Return the .claude-sessions directory for the current project."""
    project_dir = os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd())
    return os.path.join(project_dir, ".claude-sessions")


def session_file_exists_today(sessions_dir):
    """Return True if any sessions/YYYY-MM-DD-*.md file exists for today."""
    today = datetime.now().strftime("%Y-%m-%d")
    pattern = os.path.join(sessions_dir, "sessions", f"{today}-*.md")
    return bool(glob.glob(pattern))


def opt_out_marker_exists(session_id, sessions_dir):
    """Return True if .opt-out/<session-id> exists."""
    sid = sanitize_session_id(session_id)
    return os.path.exists(os.path.join(sessions_dir, ".opt-out", sid))


def log_gate_decision(session_id, event, decision, reason, sessions_dir):
    """Append a gate_decision entry to the session's raw JSONL. Best-effort."""
    try:
        sid = sanitize_session_id(session_id)
        raw_dir = os.path.join(sessions_dir, "raw")
        os.makedirs(raw_dir, exist_ok=True)
        raw_path = os.path.join(raw_dir, f"{sid}.jsonl")
        entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event": "gate_decision",
            "hook_event": event,
            "session_id": sid,
            "decision": decision,
            "reason": reason,
        }
        with open(raw_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass  # best-effort, never crash


REMINDER_TEMPLATE = """<system-reminder>
ELEPHANTS NEVER FORGET — SESSION GATE

No session file exists for today ({today}). Before responding to this prompt,
you MUST:

1. Create `.claude-sessions/sessions/{today}-<slug>.md` where `<slug>` is a
   2-5 word kebab-case summary of the session's intent. Slug rules: only
   `[a-z0-9-]`, maximum 40 characters. Same-day collision? Append `-<first-4-chars-of-session-id>`.

2. Write the required frontmatter (session_id, date, start_time, tags,
   status: active, summary) and an `## Intent` section.

3. Optionally create an empty marker at `.claude-sessions/.active/{session_id_prefix}`.

If the user said "don't track this session", instead create an empty marker at
`.claude-sessions/.opt-out/{session_id_prefix}` — that satisfies the gate.

Until one of these files exists, PreToolUse will deny any tool call other than
a Write into .claude-sessions/sessions/ or .claude-sessions/.opt-out/.
</system-reminder>"""


def handle_user_prompt_submit(input_data, sessions_dir):
    session_id = input_data.get("session_id", "unknown")
    if session_file_exists_today(sessions_dir):
        return
    if opt_out_marker_exists(session_id, sessions_dir):
        return
    sid_prefix = sanitize_session_id(session_id)[:8]
    today = datetime.now().strftime("%Y-%m-%d")
    print(REMINDER_TEMPLATE.format(today=today, session_id_prefix=sid_prefix))
    log_gate_decision(session_id, "UserPromptSubmit", "reminder", "no_session_file", sessions_dir)


DENY_REASON_TEMPLATE = (
    "No session file exists for today ({today}). The Elephants Never Forget gate is "
    "blocking this tool call. Create `.claude-sessions/sessions/{today}-<slug>.md` "
    "first, OR create `.claude-sessions/.opt-out/{session_id_prefix}` to opt out of "
    "tracking for this session."
)


def _is_write_under(tool_name, tool_input, *allowed_prefixes):
    """True if tool_name is Write and tool_input['file_path'] is under any allowed prefix."""
    if tool_name != "Write":
        return False
    fp = tool_input.get("file_path", "") if isinstance(tool_input, dict) else ""
    fp_abs = os.path.abspath(fp) if fp else ""
    for prefix in allowed_prefixes:
        if fp_abs.startswith(os.path.abspath(prefix) + os.sep) or fp_abs == os.path.abspath(prefix):
            return True
    return False


def handle_pretool_use(input_data, sessions_dir):
    session_id = input_data.get("session_id", "unknown")
    tool_name = input_data.get("tool_name", "")
    tool_input = input_data.get("tool_input", {})

    if session_file_exists_today(sessions_dir):
        return  # allow
    if opt_out_marker_exists(session_id, sessions_dir):
        return  # allow

    sessions_subdir = os.path.join(sessions_dir, "sessions")
    opt_out_subdir = os.path.join(sessions_dir, ".opt-out")
    if _is_write_under(tool_name, tool_input, sessions_subdir, opt_out_subdir):
        return  # allow (creation tools)

    sid_prefix = sanitize_session_id(session_id)[:8]
    today = datetime.now().strftime("%Y-%m-%d")
    reason = DENY_REASON_TEMPLATE.format(today=today, session_id_prefix=sid_prefix)
    payload = {"decision": "deny", "reason": reason}
    print(json.dumps(payload))
    log_gate_decision(session_id, "PreToolUse", "deny", tool_name, sessions_dir)


def main():
    try:
        input_data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    event = input_data.get("hook_event_name", "")
    sessions_dir = get_sessions_dir()

    try:
        if event == "UserPromptSubmit":
            handle_user_prompt_submit(input_data, sessions_dir)
        elif event == "PreToolUse":
            handle_pretool_use(input_data, sessions_dir)
    except Exception:
        pass

    sys.exit(0)


if __name__ == "__main__":
    main()
