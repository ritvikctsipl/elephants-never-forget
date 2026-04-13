#!/usr/bin/env python
"""
Elephants Never Forget — SessionStart Context Injector

Reads index.md, decisions.md, and the most recent session files from
.claude-sessions/ and outputs them as context for Claude.

Output goes to stdout and is injected into Claude's context window.

Token budget: aims to inject ~3,000-5,000 tokens total.
- index.md: up to 4,000 chars (~1,000 tokens)
- decisions.md: up to 4,000 chars (~1,000 tokens)
- Recent session files: up to 8,000 chars (~2,000 tokens) for the last 3
"""

import json
import sys
import os
import glob


def read_file_safe(path, max_chars=4000):
    """Read a file safely, truncating at a line boundary near max_chars."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read(max_chars + 200)  # Read a bit extra
        if len(content) > max_chars:
            # Truncate at last newline before max_chars
            truncated = content[:max_chars]
            last_nl = truncated.rfind("\n")
            if last_nl > 0:
                truncated = truncated[:last_nl]
            return truncated + "\n... (truncated — read full file for more)"
        return content
    except (FileNotFoundError, PermissionError):
        return ""


def get_recent_sessions(sessions_dir, max_files=3, max_chars_each=2700):
    """Read the most recent session files (by filename date sort)."""
    pattern = os.path.join(sessions_dir, "sessions", "*.md")
    files = sorted(glob.glob(pattern), reverse=True)  # Newest first by name

    results = []
    for fpath in files[:max_files]:
        content = read_file_safe(fpath, max_chars_each)
        if content:
            fname = os.path.basename(fpath)
            results.append(f"### {fname}\n{content}")
    return results


def main():
    try:
        input_data = json.load(sys.stdin)
        project_dir = os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd())
        sessions_dir = os.path.join(project_dir, ".claude-sessions")
        session_id = input_data.get("session_id", "unknown")

        index_content = read_file_safe(os.path.join(sessions_dir, "index.md"))
        decisions_content = read_file_safe(os.path.join(sessions_dir, "decisions.md"))
        recent_sessions = get_recent_sessions(sessions_dir)

        if not index_content and not decisions_content and not recent_sessions:
            sys.exit(0)

        parts = []
        parts.append("=== ELEPHANTS NEVER FORGET: Cross-Session Context ===")
        parts.append(f"Current session: {session_id[:8]}")
        parts.append("")

        if index_content:
            parts.append("## Session Index")
            parts.append(index_content)
            parts.append("")

        if decisions_content:
            parts.append("## Standing Decisions")
            parts.append(decisions_content)
            parts.append("")

        if recent_sessions:
            parts.append("## Recent Sessions (Hot Tier — last 3)")
            parts.extend(recent_sessions)
            parts.append("")

        parts.append("---")
        parts.append("Use the elephants-never-forget skill to maintain this session's log.")

        print("\n".join(parts))

    except Exception:
        pass

    sys.exit(0)


if __name__ == "__main__":
    main()
