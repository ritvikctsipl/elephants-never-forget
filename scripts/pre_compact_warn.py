#!/usr/bin/env python
"""
Elephants Never Forget — PreCompact Warning

Outputs a warning to stdout so Claude knows context is about to compress.
Also logs the event to the raw JSONL.
"""

import json
import sys
import os
from datetime import datetime, timezone


def main():
    try:
        input_data = json.load(sys.stdin)
        session_id = input_data.get("session_id", "unknown")
        project_dir = os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd())
        sessions_dir = os.path.join(project_dir, ".claude-sessions")

        # Log to raw JSONL
        raw_dir = os.path.join(sessions_dir, "raw")
        os.makedirs(raw_dir, exist_ok=True)
        raw_path = os.path.join(raw_dir, f"{session_id}.jsonl")
        entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event": "pre_compact",
            "session_id": session_id,
        }
        with open(raw_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

        # Log to global log
        log_path = os.path.join(sessions_dir, "log.md")
        with open(log_path, "a", encoding="utf-8") as f:
            now = datetime.now().strftime("%H:%M")
            f.write(f"- [{now}] COMPACT: Context compaction triggered for {session_id[:8]}\n")

        # OUTPUT TO STDOUT — this is what Claude sees as a warning
        print("ELEPHANTS NEVER FORGET: Context compaction is about to occur.")
        print(f"Session: {session_id[:8]}")
        print("ACTION REQUIRED: Update your session file NOW before context is lost.")
        print(f"File: .claude-sessions/sessions/ (find today's session file)")

    except Exception:
        pass

    sys.exit(0)


if __name__ == "__main__":
    main()
