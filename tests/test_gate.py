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
