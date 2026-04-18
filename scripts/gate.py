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


def main():
    # Handlers not yet implemented; they come in Task 4 and Task 5.
    # Default: exit 0 (allow) on any invocation until handlers are added.
    sys.exit(0)


if __name__ == "__main__":
    main()
