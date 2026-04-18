"""Shared pytest fixtures for Elephants Never Forget tests."""
import os
import pytest


@pytest.fixture
def sessions_dir(tmp_path):
    """Create a fresh .claude-sessions/ structure in a tmp path. Returns its absolute path."""
    sd = tmp_path / ".claude-sessions"
    (sd / "sessions").mkdir(parents=True)
    (sd / "raw").mkdir()
    (sd / ".opt-out").mkdir()
    (sd / ".active").mkdir()
    return str(sd)


@pytest.fixture
def project_dir(tmp_path, sessions_dir):
    """Return the project_dir path (parent of sessions_dir). Sets CLAUDE_PROJECT_DIR env var."""
    pd = str(tmp_path)
    os.environ["CLAUDE_PROJECT_DIR"] = pd
    yield pd
    del os.environ["CLAUDE_PROJECT_DIR"]
