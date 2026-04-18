"""Integration tests: analytics.py + transcript_parser.py on synthetic data."""
import json
import os
import subprocess
import sys

import pytest

from tests.helpers import make_session_file, make_synthetic_transcript


SCRIPT = os.path.join(os.path.dirname(__file__), "..", "scripts", "analytics.py")


def _run_analytics(project_dir, fmt="json"):
    result = subprocess.run(
        [sys.executable, SCRIPT, "--project-dir", project_dir, "--format", fmt],
        capture_output=True, text=True, timeout=20,
    )
    return result


def test_analytics_handles_no_transcripts(project_dir, sessions_dir):
    """Pre-v1.1 data: no transcripts available. Existing metrics must still compute."""
    today = __import__("datetime").datetime.now().strftime("%Y-%m-%d")
    make_session_file(sessions_dir, today, "foo", session_id="s1")
    result = _run_analytics(project_dir)
    assert result.returncode == 0
    data = json.loads(result.stdout)
    assert data["summary"]["total_sessions"] == 1
    # New buckets may be absent or empty when no transcripts
    assert "tokens" not in data or data["tokens"] == {}


def test_analytics_merges_transcript_data_when_present(project_dir, sessions_dir, monkeypatch, tmp_path):
    """With a synthetic transcript in a fake ~/.claude/projects/ tree, token metrics appear."""
    fake_home = tmp_path / "fake_home"
    fake_home.mkdir()
    projects_dir = fake_home / ".claude" / "projects" / "-fake-cwd"
    projects_dir.mkdir(parents=True)
    transcript_path = str(projects_dir / "s1.jsonl")
    make_synthetic_transcript(transcript_path, session_id="s1", num_turns=3, model="claude-opus-4-7")

    today = __import__("datetime").datetime.now().strftime("%Y-%m-%d")
    make_session_file(sessions_dir, today, "foo", session_id="s1")

    env = {**os.environ, "CLAUDE_PROJECT_DIR": project_dir, "HOME": str(fake_home)}
    result = subprocess.run(
        [sys.executable, SCRIPT, "--project-dir", project_dir, "--format", "json"],
        capture_output=True, text=True, env=env, timeout=20,
    )
    assert result.returncode == 0
    data = json.loads(result.stdout)
    assert "tokens" in data
    assert data["tokens"].get("s1", {}).get("total", 0) > 0
