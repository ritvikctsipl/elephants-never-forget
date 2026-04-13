#!/usr/bin/env python
"""
Elephants Never Forget — Mechanical Session Logger

Append-only JSONL logger for Claude Code hooks.
Writes raw event data to .claude-sessions/raw/<session-id>.jsonl

Design principles:
- NEVER crash, NEVER block — always exit 0
- Append-only JSONL — atomic writes, no file locking needed
- Fire-and-forget — under 100ms per invocation
- Captures both user prompts and Claude responses (tool outputs)
"""

import json
import sys
import os
from datetime import datetime, timezone


def get_sessions_dir():
    """Get the .claude-sessions directory in the project root."""
    project_dir = os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd())
    return os.path.join(project_dir, ".claude-sessions")


def ensure_dirs(sessions_dir):
    """Create directory structure if missing."""
    os.makedirs(os.path.join(sessions_dir, "raw"), exist_ok=True)
    os.makedirs(os.path.join(sessions_dir, "sessions"), exist_ok=True)


def append_jsonl(filepath, entry):
    """Atomic append of a single JSON line."""
    with open(filepath, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def handle_session_start(input_data, sessions_dir):
    """Log session start. Return previous context for injection."""
    session_id = input_data.get("session_id", "unknown")

    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "event": "session_start",
        "session_id": session_id,
        "source": input_data.get("session_start_source", "startup"),
        "cwd": input_data.get("cwd", ""),
    }

    raw_path = os.path.join(sessions_dir, "raw", f"{session_id}.jsonl")
    append_jsonl(raw_path, entry)

    # Append to global log
    log_path = os.path.join(sessions_dir, "log.md")
    with open(log_path, "a", encoding="utf-8") as f:
        now = datetime.now().strftime("%Y-%m-%d %H:%M")
        f.write(f"- [{now}] SESSION {session_id[:8]} started ({entry['source']})\n")


def handle_user_prompt(input_data, sessions_dir):
    """Log user prompt to session JSONL and global log."""
    session_id = input_data.get("session_id", "unknown")
    prompt = input_data.get("prompt", "")

    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "event": "user_prompt",
        "session_id": session_id,
        "prompt": prompt[:2000],  # Cap at 2000 chars to keep log manageable
    }

    raw_path = os.path.join(sessions_dir, "raw", f"{session_id}.jsonl")
    append_jsonl(raw_path, entry)

    # Append to global log (truncated)
    log_path = os.path.join(sessions_dir, "log.md")
    short_prompt = prompt[:120].replace("\n", " ").strip()
    with open(log_path, "a", encoding="utf-8") as f:
        now = datetime.now().strftime("%H:%M")
        f.write(f"- [{now}] PROMPT: {short_prompt}\n")


def handle_post_tool_use(input_data, sessions_dir):
    """Log tool usage (captures Claude's actions/responses)."""
    session_id = input_data.get("session_id", "unknown")
    tool_name = input_data.get("tool_name", "unknown")
    tool_input = input_data.get("tool_input", {})
    tool_response = input_data.get("tool_response", "")

    # Extract meaningful summary from tool use
    summary = ""
    if tool_name in ("Edit", "Write", "MultiEdit"):
        file_path = tool_input.get("file_path", "")
        summary = f"Modified {os.path.basename(file_path)}"
    elif tool_name == "Read":
        file_path = tool_input.get("file_path", "")
        summary = f"Read {os.path.basename(file_path)}"
    elif tool_name == "Bash":
        cmd = tool_input.get("command", "")[:200]
        summary = f"Ran: {cmd}"
    elif tool_name in ("Grep", "Glob"):
        pattern = tool_input.get("pattern", "")
        summary = f"Searched: {pattern}"
    else:
        summary = f"Used {tool_name}"

    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "event": "tool_use",
        "session_id": session_id,
        "tool_name": tool_name,
        "summary": summary,
        "input_preview": json.dumps(tool_input, ensure_ascii=False)[:500],
        "response_preview": str(tool_response)[:500] if tool_response else "",
    }

    raw_path = os.path.join(sessions_dir, "raw", f"{session_id}.jsonl")
    append_jsonl(raw_path, entry)


def handle_stop(input_data, sessions_dir):
    """Log when Claude finishes responding."""
    session_id = input_data.get("session_id", "unknown")

    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "event": "stop",
        "session_id": session_id,
    }

    raw_path = os.path.join(sessions_dir, "raw", f"{session_id}.jsonl")
    append_jsonl(raw_path, entry)


def handle_pre_compact(input_data, sessions_dir):
    """Critical: capture state before context compression."""
    session_id = input_data.get("session_id", "unknown")

    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "event": "pre_compact",
        "session_id": session_id,
        "note": "Context compaction triggered — ensure session file is up to date",
    }

    raw_path = os.path.join(sessions_dir, "raw", f"{session_id}.jsonl")
    append_jsonl(raw_path, entry)

    log_path = os.path.join(sessions_dir, "log.md")
    with open(log_path, "a", encoding="utf-8") as f:
        now = datetime.now().strftime("%H:%M")
        f.write(f"- [{now}] COMPACT: Context compaction triggered for {session_id[:8]}\n")


def handle_session_end(input_data, sessions_dir):
    """Log session end."""
    session_id = input_data.get("session_id", "unknown")

    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "event": "session_end",
        "session_id": session_id,
    }

    raw_path = os.path.join(sessions_dir, "raw", f"{session_id}.jsonl")
    append_jsonl(raw_path, entry)

    log_path = os.path.join(sessions_dir, "log.md")
    with open(log_path, "a", encoding="utf-8") as f:
        now = datetime.now().strftime("%H:%M")
        f.write(f"- [{now}] SESSION {session_id[:8]} ended\n")


EVENT_HANDLERS = {
    "SessionStart": handle_session_start,
    "UserPromptSubmit": handle_user_prompt,
    "PostToolUse": handle_post_tool_use,
    "Stop": handle_stop,
    "PreCompact": handle_pre_compact,
    "SessionEnd": handle_session_end,
}


def main():
    try:
        input_data = json.load(sys.stdin)
        event = input_data.get("hook_event_name", "")

        sessions_dir = get_sessions_dir()
        ensure_dirs(sessions_dir)

        handler = EVENT_HANDLERS.get(event)
        if handler:
            handler(input_data, sessions_dir)
    except Exception:
        pass  # NEVER crash, NEVER block

    sys.exit(0)


if __name__ == "__main__":
    main()
