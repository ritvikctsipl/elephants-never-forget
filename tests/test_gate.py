"""Tests for scripts/gate.py — the hard-gate hook script."""
import json
import os
import subprocess
import sys

import pytest

from tests.helpers import make_session_file, make_opt_out_marker


SCRIPT = os.path.join(os.path.dirname(__file__), "..", "scripts", "gate.py")


def run_gate(stdin_payload, project_dir, env_extra=None):
    """Invoke scripts/gate.py as a subprocess with the given JSON on stdin."""
    env = {**os.environ, "CLAUDE_PROJECT_DIR": project_dir}
    if env_extra:
        env.update(env_extra)
    result = subprocess.run(
        [sys.executable, SCRIPT],
        input=json.dumps(stdin_payload),
        capture_output=True, text=True, env=env, timeout=5,
    )
    return result


def test_helpers_importable():
    """gate.py exposes session_file_exists_today, opt_out_marker_exists, sanitize_session_id."""
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
    import gate
    assert callable(gate.session_file_exists_today)
    assert callable(gate.opt_out_marker_exists)
    assert callable(gate.sanitize_session_id)


def test_user_prompt_submit_silent_when_session_file_exists(project_dir, sessions_dir):
    today = __import__("datetime").datetime.now().strftime("%Y-%m-%d")
    make_session_file(sessions_dir, today, "foo", session_id="s1")
    result = run_gate(
        {"hook_event_name": "UserPromptSubmit", "session_id": "s1", "prompt": "hi"},
        project_dir=project_dir,
    )
    assert result.returncode == 0
    assert result.stdout.strip() == "", "should be silent when session file exists"


def test_user_prompt_submit_silent_when_opt_out(project_dir, sessions_dir):
    make_opt_out_marker(sessions_dir, "s1")
    result = run_gate(
        {"hook_event_name": "UserPromptSubmit", "session_id": "s1", "prompt": "hi"},
        project_dir=project_dir,
    )
    assert result.returncode == 0
    assert result.stdout.strip() == ""


def test_user_prompt_submit_injects_reminder_when_no_session_file(project_dir, sessions_dir):
    result = run_gate(
        {"hook_event_name": "UserPromptSubmit", "session_id": "s1", "prompt": "hi"},
        project_dir=project_dir,
    )
    assert result.returncode == 0
    assert "<system-reminder>" in result.stdout
    assert ".claude-sessions/sessions/" in result.stdout
    assert "</system-reminder>" in result.stdout


def test_pretool_allows_when_session_file_exists(project_dir, sessions_dir):
    today = __import__("datetime").datetime.now().strftime("%Y-%m-%d")
    make_session_file(sessions_dir, today, "foo", session_id="s1")
    result = run_gate(
        {
            "hook_event_name": "PreToolUse",
            "session_id": "s1",
            "tool_name": "Read",
            "tool_input": {"file_path": "/tmp/foo.txt"},
        },
        project_dir=project_dir,
    )
    assert result.returncode == 0
    assert result.stdout.strip() == ""


def test_pretool_allows_opt_out(project_dir, sessions_dir):
    make_opt_out_marker(sessions_dir, "s1")
    result = run_gate(
        {"hook_event_name": "PreToolUse", "session_id": "s1",
         "tool_name": "Read", "tool_input": {"file_path": "/tmp/foo.txt"}},
        project_dir=project_dir,
    )
    assert result.returncode == 0
    assert result.stdout.strip() == ""


def test_pretool_allows_write_to_sessions_dir(project_dir, sessions_dir):
    today = __import__("datetime").datetime.now().strftime("%Y-%m-%d")
    target = os.path.join(sessions_dir, "sessions", f"{today}-foo.md")
    result = run_gate(
        {"hook_event_name": "PreToolUse", "session_id": "s1",
         "tool_name": "Write", "tool_input": {"file_path": target}},
        project_dir=project_dir,
    )
    assert result.returncode == 0
    assert result.stdout.strip() == ""


def test_pretool_allows_write_to_opt_out_dir(project_dir, sessions_dir):
    target = os.path.join(sessions_dir, ".opt-out", "s1")
    result = run_gate(
        {"hook_event_name": "PreToolUse", "session_id": "s1",
         "tool_name": "Write", "tool_input": {"file_path": target}},
        project_dir=project_dir,
    )
    assert result.returncode == 0
    assert result.stdout.strip() == ""


def test_pretool_denies_read_when_no_session_file(project_dir, sessions_dir):
    result = run_gate(
        {"hook_event_name": "PreToolUse", "session_id": "s1",
         "tool_name": "Read", "tool_input": {"file_path": "/tmp/foo.txt"}},
        project_dir=project_dir,
    )
    assert result.returncode == 0
    payload = json.loads(result.stdout.strip())
    assert payload.get("decision") == "deny"
    assert "session" in payload.get("reason", "").lower()


def test_pretool_denies_bash_when_no_session_file(project_dir, sessions_dir):
    result = run_gate(
        {"hook_event_name": "PreToolUse", "session_id": "s1",
         "tool_name": "Bash", "tool_input": {"command": "echo hi"}},
        project_dir=project_dir,
    )
    assert result.returncode == 0
    payload = json.loads(result.stdout.strip())
    assert payload.get("decision") == "deny"


def test_malformed_stdin_fails_open(project_dir):
    result = subprocess.run(
        [sys.executable, SCRIPT],
        input="not json at all",
        capture_output=True, text=True, env={**os.environ, "CLAUDE_PROJECT_DIR": project_dir},
        timeout=5,
    )
    assert result.returncode == 0
    assert result.stdout.strip() == ""
