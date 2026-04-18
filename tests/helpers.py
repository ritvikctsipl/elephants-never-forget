"""Builders for synthetic .claude-sessions/ trees and synthetic transcripts."""
import json
import os
from datetime import datetime, timedelta, timezone


def make_session_file(sessions_dir, date_str, slug, session_id="a1b2c3d4", tags=None, status="completed"):
    """Create a session markdown file in sessions_dir/sessions/. Returns the file path."""
    tags = tags or ["test"]
    content = (
        f"---\n"
        f"session_id: {session_id}\n"
        f"date: {date_str}\n"
        f"start_time: \"10:00\"\n"
        f"tags: [{', '.join(tags)}]\n"
        f"status: {status}\n"
        f"summary: \"Test session\"\n"
        f"---\n\n"
        f"## Intent\nTest intent.\n"
    )
    path = os.path.join(sessions_dir, "sessions", f"{date_str}-{slug}.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return path


def make_opt_out_marker(sessions_dir, session_id):
    """Create an empty .opt-out/<session-id> marker."""
    path = os.path.join(sessions_dir, ".opt-out", session_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "w").close()
    return path


def make_active_marker(sessions_dir, session_id):
    """Create an empty .active/<session-id> marker."""
    path = os.path.join(sessions_dir, ".active", session_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "w").close()
    return path


def make_synthetic_transcript(path, session_id, num_turns=5, input_tokens_per_turn=1000,
                               output_tokens_per_turn=500, cache_read_tokens=200,
                               cache_creation_tokens=100, model="claude-opus-4-7",
                               compaction_at=None):
    """Write a synthetic transcript JSONL to `path`. Matches Claude Code's transcript schema
    closely enough for the parser to exercise all paths.

    compaction_at: if set, inject a compaction marker after that turn index.
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)
    t0 = datetime(2026, 4, 17, 10, 0, 0, tzinfo=timezone.utc)
    with open(path, "w", encoding="utf-8") as f:
        for i in range(num_turns):
            ts = (t0 + timedelta(seconds=i * 30)).isoformat()
            user_line = {
                "type": "user",
                "timestamp": ts,
                "sessionId": session_id,
                "message": {"role": "user", "content": f"prompt {i}"},
            }
            f.write(json.dumps(user_line) + "\n")
            assistant_ts = (t0 + timedelta(seconds=i * 30 + 5)).isoformat()
            assistant_line = {
                "type": "assistant",
                "timestamp": assistant_ts,
                "sessionId": session_id,
                "message": {
                    "role": "assistant",
                    "model": model,
                    "content": [{"type": "text", "text": f"reply {i}"}],
                    "usage": {
                        "input_tokens": input_tokens_per_turn,
                        "output_tokens": output_tokens_per_turn,
                        "cache_read_input_tokens": cache_read_tokens,
                        "cache_creation_input_tokens": cache_creation_tokens,
                    },
                },
            }
            f.write(json.dumps(assistant_line) + "\n")
            if compaction_at is not None and i == compaction_at:
                comp_line = {
                    "type": "system",
                    "timestamp": assistant_ts,
                    "sessionId": session_id,
                    "subtype": "compact_boundary",
                }
                f.write(json.dumps(comp_line) + "\n")
