# Elephants Never Forget v1.1.0 — Hard Gate + Transcript Analytics + Skill Audit

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship ENF plugin v1.1.0 with a hard gate that enforces session-file creation, transcript-derived token/cost/pacing analytics, and rewritten skills — all while keeping the plugin lightweight (hot-path hooks <5ms, cold-path work only on explicit user invocation, stdlib-only runtime).

**Architecture:** Three orthogonal subsystems. Enforcement adds `scripts/gate.py` wired to `UserPromptSubmit` and `PreToolUse` hooks; fails open on error. Analytics adds `scripts/transcript_parser.py` (pure, stateless) consumed by the existing `analytics.py` / `dashboard.py`. Skills are rewritten via `superpowers:writing-skills` guidance. New runtime artifacts: empty markers under `.claude-sessions/.opt-out/<sid>` and `.claude-sessions/.active/<sid>`.

**Tech Stack:** Python 3.8+ stdlib only at runtime; `pytest` as dev-only test dependency; Chart.js (CDN, already used) for dashboard charts; JSON hook I/O protocol.

**Source spec:** `docs/superpowers/specs/2026-04-17-improve-enf-plugin-design.md` — read it before starting. Acceptance criteria in Section 11 of the spec are the ship bar.

---

## File Structure

Files this plan creates or modifies:

**New files:**
- `scripts/gate.py` — UserPromptSubmit + PreToolUse enforcement (one responsibility: deny non-creation tools when today's session file is missing)
- `scripts/transcript_parser.py` — pure stateless module for reading Claude Code transcripts and deriving token/cost/pacing metrics
- `tests/conftest.py` — pytest fixtures shared across tests
- `tests/helpers.py` — builders for synthetic `.claude-sessions/` trees and synthetic transcripts
- `tests/test_gate.py` — unit tests for gate.py
- `tests/test_transcript_parser.py` — unit tests for transcript_parser.py
- `tests/test_analytics_integration.py` — integration test: analytics.py + transcript_parser.py on synthetic data
- `pytest.ini` — minimal pytest config (testpaths = tests)

**Modified files:**
- `hooks/hooks.json` — register gate.py for UserPromptSubmit (chained after session_logger) and PreToolUse (new)
- `scripts/analytics.py` — add transcript parse pass + 4 new markdown sections (Token Spend, Cost, Context Pressure, Pacing)
- `scripts/dashboard.py` — add 5 new Chart.js charts
- `scripts/generate_test_data.py` — add `generate_synthetic_transcript(...)` helper
- `skills/elephants-never-forget/SKILL.md` — full rewrite via writing-skills
- `skills/session-analytics/SKILL.md` — full rewrite via writing-skills
- `README.md` — add "The Gate" section; refresh analytics metrics list
- `.claude-plugin/plugin.json` — bump version to 1.1.0
- `.gitignore` — add `tests/__pycache__/` if not already covered

**Runtime artifacts (created by skill at runtime, not by the plan):**
- `.claude-sessions/.opt-out/<session-id>` — opt-out marker
- `.claude-sessions/.active/<session-id>` — active marker (convention; not required by gate)

---

## Phase 0: Test harness setup

### Task 1: Create `pytest.ini` and test directory skeleton

**Files:**
- Create: `pytest.ini`
- Create: `tests/__init__.py`
- Create: `tests/conftest.py`
- Modify: `.gitignore`

- [ ] **Step 1: Create pytest.ini**

Write `pytest.ini`:

```ini
[pytest]
testpaths = tests
python_files = test_*.py
python_classes = Test*
python_functions = test_*
addopts = -v --tb=short
```

- [ ] **Step 2: Create tests/__init__.py**

Write empty `tests/__init__.py`:

```python
```

- [ ] **Step 3: Create tests/conftest.py with tmpdir-based sessions_dir fixture**

Write `tests/conftest.py`:

```python
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
```

- [ ] **Step 4: Update .gitignore**

Add these lines to `.gitignore` if not present:

```
tests/__pycache__/
.pytest_cache/
```

- [ ] **Step 5: Verify pytest discovers the suite (empty)**

Run: `python -m pytest --collect-only`
Expected: exit 0, message "no tests ran in 0.XXs" or similar — no discovery errors.

- [ ] **Step 6: Commit**

```bash
git add pytest.ini tests/__init__.py tests/conftest.py .gitignore
git commit -m "test: add pytest harness and tmpdir fixtures for sessions_dir"
```

### Task 2: Add `tests/helpers.py` builder utilities

**Files:**
- Create: `tests/helpers.py`

- [ ] **Step 1: Write the helpers module**

Write `tests/helpers.py`:

```python
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
```

- [ ] **Step 2: Sanity check the helpers import without errors**

Run: `python -c "from tests.helpers import make_session_file, make_synthetic_transcript; print('ok')"`
Expected: prints `ok`, exits 0.

- [ ] **Step 3: Commit**

```bash
git add tests/helpers.py
git commit -m "test: add helpers for synthetic sessions and transcripts"
```

---

## Phase 1: Enforcement subsystem (gate.py + hooks wiring)

### Task 3: `gate.py` skeleton and shared helpers

**Files:**
- Create: `scripts/gate.py`
- Create: `tests/test_gate.py`

- [ ] **Step 1: Write the failing test for shared helpers**

Write `tests/test_gate.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_gate.py::test_helpers_importable -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'gate'`.

- [ ] **Step 3: Write gate.py with helpers only (no handlers yet)**

Write `scripts/gate.py`:

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_gate.py::test_helpers_importable -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/gate.py tests/test_gate.py
git commit -m "feat(gate): add gate.py skeleton with shared filesystem helpers"
```

### Task 4: `gate.py` UserPromptSubmit handler — inject reminder when no session file

**Files:**
- Modify: `scripts/gate.py`
- Modify: `tests/test_gate.py`

- [ ] **Step 1: Add failing tests for UserPromptSubmit handler**

Append to `tests/test_gate.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_gate.py -v -k user_prompt_submit`
Expected: 3 failures (handler not implemented; current gate.py just exits 0 with no stdout — so "silent" tests pass but "injects_reminder" fails). Inspect the actual failures before moving on.

- [ ] **Step 3: Implement UserPromptSubmit handler**

In `scripts/gate.py`, replace the `main()` function with:

```python
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


def main():
    try:
        input_data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)  # fail-open on malformed input

    event = input_data.get("hook_event_name", "")
    sessions_dir = get_sessions_dir()

    try:
        if event == "UserPromptSubmit":
            handle_user_prompt_submit(input_data, sessions_dir)
        # PreToolUse handler added in Task 5
    except Exception:
        pass  # fail-open on any unexpected error

    sys.exit(0)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_gate.py -v -k user_prompt_submit`
Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/gate.py tests/test_gate.py
git commit -m "feat(gate): UserPromptSubmit handler injects session-start reminder"
```

### Task 5: `gate.py` PreToolUse handler — deny non-creation tools when no session file

**Files:**
- Modify: `scripts/gate.py`
- Modify: `tests/test_gate.py`

- [ ] **Step 1: Add failing tests for PreToolUse handler**

Append to `tests/test_gate.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_gate.py -v -k pretool`
Expected: the first 4 `pretool_allows_*` tests PASS (because gate currently exits 0 silently on unknown events), but the two `pretool_denies_*` tests FAIL (no deny logic yet).

- [ ] **Step 3: Implement PreToolUse handler**

In `scripts/gate.py`, add after `handle_user_prompt_submit`:

```python
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
```

Then update `main()` to dispatch PreToolUse:

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_gate.py -v`
Expected: all gate tests PASS (9 total: 3 UserPromptSubmit + 4 allow cases + 2 deny cases + 1 malformed stdin).

- [ ] **Step 5: Commit**

```bash
git add scripts/gate.py tests/test_gate.py
git commit -m "feat(gate): PreToolUse handler denies non-creation tools without session file"
```

### Task 6: Wire `gate.py` into `hooks/hooks.json`

**Files:**
- Modify: `hooks/hooks.json`

- [ ] **Step 1: Read the current hooks.json to confirm the exact structure**

Run: `cat hooks/hooks.json`
Expected: the existing file with hooks for SessionStart, UserPromptSubmit, PostToolUse, Stop, PreCompact, SessionEnd (no PreToolUse block yet).

- [ ] **Step 2: Add gate.py to the UserPromptSubmit chain and add a new PreToolUse block**

Edit `hooks/hooks.json`. Replace the entire `UserPromptSubmit` array with:

```json
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python \"${CLAUDE_PLUGIN_ROOT}/scripts/session_logger.py\"",
            "timeout": 10,
            "async": true
          },
          {
            "type": "command",
            "command": "python \"${CLAUDE_PLUGIN_ROOT}/scripts/gate.py\"",
            "timeout": 5
          }
        ]
      }
    ],
```

Add a new `PreToolUse` array (place it between `UserPromptSubmit` and `PostToolUse`):

```json
    "PreToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "python \"${CLAUDE_PLUGIN_ROOT}/scripts/gate.py\"",
            "timeout": 5
          }
        ]
      }
    ],
```

Keep all other hook blocks (SessionStart, PostToolUse, Stop, PreCompact, SessionEnd) unchanged.

- [ ] **Step 3: Verify JSON validity**

Run: `python -c "import json; json.load(open('hooks/hooks.json'))" && echo "valid"`
Expected: prints `valid`.

- [ ] **Step 4: Commit**

```bash
git add hooks/hooks.json
git commit -m "feat(hooks): register gate.py for UserPromptSubmit and PreToolUse"
```

### Task 7: Smoke test Phase 1 in a scratch project

**Files:** none (manual verification)

- [ ] **Step 1: Create a scratch project directory**

Run: `mkdir -p /tmp/ene-smoke && cd /tmp/ene-smoke && git init`
Expected: initialized empty git repo.

- [ ] **Step 2: Manually invoke gate.py with UserPromptSubmit — no session file**

Run:

```bash
cd /tmp/ene-smoke
CLAUDE_PROJECT_DIR=/tmp/ene-smoke echo '{"hook_event_name":"UserPromptSubmit","session_id":"test1234","prompt":"hi"}' | \
  python "${CLAUDE_PLUGIN_ROOT:-/path/to/elephants_never_forget}/scripts/gate.py"
```

(If `CLAUDE_PLUGIN_ROOT` is not set, substitute the absolute path to the plugin repo.)

Expected: prints a `<system-reminder>` block to stdout, exit 0.

- [ ] **Step 3: Manually invoke gate.py with PreToolUse Read — no session file**

Run:

```bash
CLAUDE_PROJECT_DIR=/tmp/ene-smoke echo '{"hook_event_name":"PreToolUse","session_id":"test1234","tool_name":"Read","tool_input":{"file_path":"/tmp/foo"}}' | \
  python "${CLAUDE_PLUGIN_ROOT:-/path/to/elephants_never_forget}/scripts/gate.py"
```

Expected: prints `{"decision": "deny", "reason": "..."}` JSON on stdout, exit 0.

- [ ] **Step 4: Create a session file and re-run — gate should allow**

Run:

```bash
mkdir -p /tmp/ene-smoke/.claude-sessions/sessions
TODAY=$(date +%Y-%m-%d)
echo "---
session_id: test1234
date: $TODAY
---" > /tmp/ene-smoke/.claude-sessions/sessions/$TODAY-smoke-test.md

CLAUDE_PROJECT_DIR=/tmp/ene-smoke echo '{"hook_event_name":"PreToolUse","session_id":"test1234","tool_name":"Read","tool_input":{"file_path":"/tmp/foo"}}' | \
  python "${CLAUDE_PLUGIN_ROOT:-/path/to/elephants_never_forget}/scripts/gate.py"
```

Expected: no stdout, exit 0 (silent allow).

- [ ] **Step 5: Time the hot-path (session file exists) invocation**

Run:

```bash
CLAUDE_PROJECT_DIR=/tmp/ene-smoke time python "${CLAUDE_PLUGIN_ROOT:-/path/to/elephants_never_forget}/scripts/gate.py" < <(echo '{"hook_event_name":"PreToolUse","session_id":"test1234","tool_name":"Read","tool_input":{"file_path":"/tmp/foo"}}')
```

Expected: real time <100ms (python startup dominates; gate logic itself is <5ms).

- [ ] **Step 6: Clean up scratch**

Run: `rm -rf /tmp/ene-smoke`

- [ ] **Step 7: No commit (verification only)** — move on to Phase 2.

---

## Phase 2: Analytics subsystem (transcript_parser.py + integrations)

### Task 8: `transcript_parser.py` — `parse_transcript` and `find_transcript_path`

**Files:**
- Create: `scripts/transcript_parser.py`
- Create: `tests/test_transcript_parser.py`

- [ ] **Step 1: Write failing tests for parse_transcript**

Write `tests/test_transcript_parser.py`:

```python
"""Tests for scripts/transcript_parser.py."""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import transcript_parser as tp  # noqa: E402

from tests.helpers import make_synthetic_transcript


def test_parse_transcript_missing_file_returns_empty():
    assert tp.parse_transcript("/no/such/path.jsonl") == {}


def test_parse_transcript_well_formed(tmp_path):
    path = str(tmp_path / "t.jsonl")
    make_synthetic_transcript(path, session_id="sid", num_turns=3)
    result = tp.parse_transcript(path)
    assert result != {}
    assert len(result["messages"]) == 6  # 3 user + 3 assistant
    assert len(result["usage_per_message"]) == 3  # only assistant has usage
    assert result["model"] == "claude-opus-4-7"


def test_parse_transcript_skips_malformed_lines(tmp_path):
    path = str(tmp_path / "t.jsonl")
    with open(path, "w") as f:
        f.write('{"type": "user", "sessionId": "s", "message": {}}\n')
        f.write('not-json\n')  # should be skipped
        f.write('{"type": "assistant", "sessionId": "s", "message": {"usage": {"input_tokens": 100, "output_tokens": 50}}}\n')
    result = tp.parse_transcript(path)
    assert len(result["messages"]) == 2
    assert len(result["usage_per_message"]) == 1


def test_find_transcript_path_returns_none_for_unknown(tmp_path):
    assert tp.find_transcript_path("nonexistent-session", cwd=str(tmp_path)) is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_transcript_parser.py -v`
Expected: `ModuleNotFoundError: No module named 'transcript_parser'`.

- [ ] **Step 3: Implement parse_transcript and find_transcript_path**

Write `scripts/transcript_parser.py`:

```python
#!/usr/bin/env python
"""Elephants Never Forget — Transcript Parser.

Pure, stateless module that reads a Claude Code transcript JSONL and computes
derived metrics (token usage, cost estimate, inter-turn pacing, context pressure).

Runtime: stdlib only. Defensive: never raises; returns {} or None on failure.
"""

import glob
import json
import os
from pathlib import Path


def parse_transcript(path):
    """Read a transcript JSONL at `path`. Return a dict with messages, usage, tools, compactions.

    Structure:
        {
            "messages": [dict, ...],
            "usage_per_message": [dict, ...],  # one per assistant message with usage
            "tool_uses": [dict, ...],
            "compactions": [dict, ...],
            "model": str | None,
        }

    Returns {} on any failure (missing file, permission error).
    Per-line parse failures are skipped silently.
    """
    if not path or not os.path.isfile(path):
        return {}
    try:
        messages = []
        usage_per_message = []
        tool_uses = []
        compactions = []
        model = None
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                messages.append(entry)
                msg = entry.get("message", {}) if isinstance(entry.get("message"), dict) else {}
                if msg.get("usage"):
                    usage_per_message.append({
                        "timestamp": entry.get("timestamp"),
                        "usage": msg["usage"],
                    })
                if not model and msg.get("model"):
                    model = msg["model"]
                content = msg.get("content", []) if isinstance(msg.get("content"), list) else []
                for c in content:
                    if isinstance(c, dict) and c.get("type") == "tool_use":
                        tool_uses.append({
                            "timestamp": entry.get("timestamp"),
                            "name": c.get("name"),
                            "input": c.get("input"),
                        })
                if entry.get("type") == "system" and entry.get("subtype") == "compact_boundary":
                    compactions.append({"timestamp": entry.get("timestamp")})
        return {
            "messages": messages,
            "usage_per_message": usage_per_message,
            "tool_uses": tool_uses,
            "compactions": compactions,
            "model": model,
        }
    except (OSError, PermissionError):
        return {}


def find_transcript_path(session_id, cwd=None):
    """Locate the transcript JSONL for a given session_id.

    Tries Claude Code's conventional layout first:
        ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
    where <encoded-cwd> is the cwd with '/' replaced by '-', prefixed with '-'.

    Falls back to a glob search under ~/.claude/projects/.
    Returns the first match, or None.
    """
    if not session_id:
        return None
    home = str(Path.home())
    projects_root = os.path.join(home, ".claude", "projects")
    if not os.path.isdir(projects_root):
        return None

    # Direct path
    if cwd:
        encoded = cwd.replace(os.sep, "-")
        if not encoded.startswith("-"):
            encoded = "-" + encoded
        direct = os.path.join(projects_root, encoded, f"{session_id}.jsonl")
        if os.path.isfile(direct):
            return direct

    # Fallback glob
    pattern = os.path.join(projects_root, "*", f"{session_id}.jsonl")
    matches = glob.glob(pattern)
    return matches[0] if matches else None
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_transcript_parser.py -v`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/transcript_parser.py tests/test_transcript_parser.py
git commit -m "feat(analytics): transcript_parser with parse_transcript + find_transcript_path"
```

### Task 9: `transcript_parser.py` — `compute_usage_totals`

**Files:**
- Modify: `scripts/transcript_parser.py`
- Modify: `tests/test_transcript_parser.py`

- [ ] **Step 1: Add failing test**

Append to `tests/test_transcript_parser.py`:

```python
def test_compute_usage_totals_basic(tmp_path):
    path = str(tmp_path / "t.jsonl")
    make_synthetic_transcript(
        path, session_id="s", num_turns=3,
        input_tokens_per_turn=1000, output_tokens_per_turn=500,
        cache_read_tokens=200, cache_creation_tokens=100,
    )
    t = tp.parse_transcript(path)
    totals = tp.compute_usage_totals(t)
    assert totals["input"] == 3000
    assert totals["output"] == 1500
    assert totals["cache_read"] == 600
    assert totals["cache_creation"] == 300
    assert totals["total"] == 3000 + 1500 + 600 + 300
    # cache_hit_rate = cache_read / (cache_read + input (uncached))
    # With input_tokens already excluding cached, cache_hit_rate = 600 / (600 + 3000) = 16.67%
    assert 10.0 < totals["cache_hit_rate"] < 20.0


def test_compute_usage_totals_empty():
    totals = tp.compute_usage_totals({})
    assert totals == {
        "input": 0, "output": 0, "cache_read": 0, "cache_creation": 0,
        "total": 0, "cache_hit_rate": 0.0,
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_transcript_parser.py -v -k compute_usage`
Expected: FAIL — `AttributeError: module 'transcript_parser' has no attribute 'compute_usage_totals'`.

- [ ] **Step 3: Implement compute_usage_totals**

Append to `scripts/transcript_parser.py`:

```python
def compute_usage_totals(transcript):
    """Sum token usage across all assistant messages.

    Returns dict with keys: input, output, cache_read, cache_creation, total, cache_hit_rate.
    cache_hit_rate is cache_read / (cache_read + input), expressed as a percentage.
    Empty transcript → all zeros.
    """
    totals = {"input": 0, "output": 0, "cache_read": 0, "cache_creation": 0}
    for entry in transcript.get("usage_per_message", []):
        u = entry.get("usage", {})
        totals["input"] += int(u.get("input_tokens", 0) or 0)
        totals["output"] += int(u.get("output_tokens", 0) or 0)
        totals["cache_read"] += int(u.get("cache_read_input_tokens", 0) or 0)
        totals["cache_creation"] += int(u.get("cache_creation_input_tokens", 0) or 0)
    totals["total"] = sum(totals.values())
    denom = totals["cache_read"] + totals["input"]
    totals["cache_hit_rate"] = round(totals["cache_read"] / denom * 100, 2) if denom > 0 else 0.0
    return totals
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_transcript_parser.py -v -k compute_usage`
Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/transcript_parser.py tests/test_transcript_parser.py
git commit -m "feat(analytics): compute_usage_totals with cache hit rate"
```

### Task 10: `transcript_parser.py` — `estimate_cost` and `PRICING_TABLE_V1`

**Files:**
- Modify: `scripts/transcript_parser.py`
- Modify: `tests/test_transcript_parser.py`

- [ ] **Step 1: Add failing tests**

Append to `tests/test_transcript_parser.py`:

```python
def test_estimate_cost_known_model():
    usage = {"input": 1_000_000, "output": 1_000_000, "cache_read": 0, "cache_creation": 0}
    result = tp.estimate_cost(usage, model="claude-opus-4-7")
    assert result["cost_usd"] is not None
    assert result["cost_usd"] > 0
    assert result["model"] == "claude-opus-4-7"
    assert result["pricing_version"] == "v1"
    assert "rates as of" in result["disclaimer"]


def test_estimate_cost_unknown_model():
    usage = {"input": 1000, "output": 500, "cache_read": 0, "cache_creation": 0}
    result = tp.estimate_cost(usage, model="claude-future-x-0")
    assert result["cost_usd"] is None
    assert "unknown model" in result["disclaimer"].lower()


def test_estimate_cost_none_model():
    usage = {"input": 1000, "output": 500, "cache_read": 0, "cache_creation": 0}
    result = tp.estimate_cost(usage, model=None)
    assert result["cost_usd"] is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_transcript_parser.py -v -k estimate_cost`
Expected: FAIL — no `estimate_cost` attribute.

- [ ] **Step 3: Implement estimate_cost and PRICING_TABLE_V1**

Append to `scripts/transcript_parser.py`:

```python
# Public pricing as of 2026-01 (USD per million tokens). Update when rates change.
PRICING_TABLE_V1 = {
    "claude-opus-4-7":    {"input": 15.00, "output": 75.00, "cache_read": 1.50,  "cache_creation": 18.75},
    "claude-opus-4-6":    {"input": 15.00, "output": 75.00, "cache_read": 1.50,  "cache_creation": 18.75},
    "claude-sonnet-4-6":  {"input":  3.00, "output": 15.00, "cache_read": 0.30,  "cache_creation":  3.75},
    "claude-sonnet-4-5":  {"input":  3.00, "output": 15.00, "cache_read": 0.30,  "cache_creation":  3.75},
    "claude-haiku-4-5":   {"input":  0.80, "output":  4.00, "cache_read": 0.08,  "cache_creation":  1.00},
}
_PRICING_AS_OF = "2026-01"


def _normalize_model(model):
    """Strip suffixes like '[1m]' and version-date suffixes; lowercase."""
    if not model:
        return None
    m = model.lower().strip()
    # Strip bracketed suffix: 'claude-opus-4-7[1m]' -> 'claude-opus-4-7'
    if "[" in m:
        m = m.split("[", 1)[0]
    # Strip date suffix: 'claude-haiku-4-5-20251001' -> 'claude-haiku-4-5'
    parts = m.rsplit("-", 1)
    if len(parts) == 2 and parts[1].isdigit() and len(parts[1]) == 8:
        m = parts[0]
    return m


def estimate_cost(usage, model=None):
    """Compute estimated cost in USD from a usage dict and model identifier.

    Returns {
        "cost_usd": float | None,
        "disclaimer": str,
        "model": str | None,
        "pricing_version": "v1",
    }
    Unknown model → cost_usd=None with explanation.
    """
    model_norm = _normalize_model(model)
    pricing = PRICING_TABLE_V1.get(model_norm)
    if not pricing:
        return {
            "cost_usd": None,
            "disclaimer": f"Unknown model '{model}'. Cost cannot be estimated.",
            "model": model,
            "pricing_version": "v1",
        }
    cost = (
        usage.get("input", 0)          * pricing["input"]         +
        usage.get("output", 0)         * pricing["output"]        +
        usage.get("cache_read", 0)     * pricing["cache_read"]    +
        usage.get("cache_creation", 0) * pricing["cache_creation"]
    ) / 1_000_000.0
    return {
        "cost_usd": round(cost, 4),
        "disclaimer": f"Estimate based on public rates as of {_PRICING_AS_OF}; may drift.",
        "model": model,
        "pricing_version": "v1",
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_transcript_parser.py -v -k estimate_cost`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/transcript_parser.py tests/test_transcript_parser.py
git commit -m "feat(analytics): estimate_cost with versioned PRICING_TABLE_V1"
```

### Task 11: `transcript_parser.py` — `compute_pacing`

**Files:**
- Modify: `scripts/transcript_parser.py`
- Modify: `tests/test_transcript_parser.py`

- [ ] **Step 1: Add failing test**

Append to `tests/test_transcript_parser.py`:

```python
def test_compute_pacing_basic(tmp_path):
    path = str(tmp_path / "t.jsonl")
    make_synthetic_transcript(path, session_id="s", num_turns=4)
    # Synthetic turns are 30s apart; assistant replies 5s after each prompt.
    t = tp.parse_transcript(path)
    pacing = tp.compute_pacing(t)
    assert pacing["inter_turn_median_ms"] > 0
    assert pacing["inter_turn_p95_ms"] >= pacing["inter_turn_median_ms"]
    assert isinstance(pacing["idle_gaps_sec"], list)


def test_compute_pacing_empty():
    pacing = tp.compute_pacing({})
    assert pacing["inter_turn_median_ms"] == 0
    assert pacing["inter_turn_p95_ms"] == 0
    assert pacing["idle_gaps_sec"] == []
    assert pacing["prompt_to_first_tool_ms"] == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_transcript_parser.py -v -k compute_pacing`
Expected: FAIL — attribute missing.

- [ ] **Step 3: Implement compute_pacing**

Append to `scripts/transcript_parser.py`:

```python
from datetime import datetime as _dt


def _parse_ts(s):
    if not s:
        return None
    try:
        # Accept both Z and +00:00 suffixes
        return _dt.fromisoformat(s.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def _percentile(values, p):
    """Nearest-rank percentile. values must be sorted."""
    if not values:
        return 0.0
    idx = min(len(values) - 1, int(round((p / 100.0) * (len(values) - 1))))
    return values[idx]


def compute_pacing(transcript):
    """Compute inter-turn latencies and idle gaps.

    Returns {
        "inter_turn_median_ms": float,
        "inter_turn_p95_ms": float,
        "idle_gaps_sec": [float],    # gaps > 60s between consecutive messages
        "prompt_to_first_tool_ms": [float],  # user prompt -> first tool_use after it
    }
    """
    messages = transcript.get("messages", [])
    deltas_ms = []
    idle_gaps = []
    prev_ts = None
    for m in messages:
        ts = _parse_ts(m.get("timestamp"))
        if ts is None:
            continue
        if prev_ts is not None:
            delta = (ts - prev_ts).total_seconds()
            deltas_ms.append(delta * 1000.0)
            if delta > 60:
                idle_gaps.append(round(delta, 1))
        prev_ts = ts

    prompt_to_tool = []
    tool_uses = transcript.get("tool_uses", [])
    user_ts_list = [_parse_ts(m.get("timestamp")) for m in messages if m.get("type") == "user"]
    user_ts_list = [t for t in user_ts_list if t is not None]
    for u_ts in user_ts_list:
        following_tools = [
            _parse_ts(t.get("timestamp")) for t in tool_uses
            if _parse_ts(t.get("timestamp")) and _parse_ts(t.get("timestamp")) > u_ts
        ]
        if following_tools:
            delta_s = (min(following_tools) - u_ts).total_seconds()
            prompt_to_tool.append(round(delta_s * 1000.0, 1))

    deltas_sorted = sorted(deltas_ms)
    return {
        "inter_turn_median_ms": round(_percentile(deltas_sorted, 50), 1),
        "inter_turn_p95_ms": round(_percentile(deltas_sorted, 95), 1),
        "idle_gaps_sec": idle_gaps,
        "prompt_to_first_tool_ms": prompt_to_tool,
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_transcript_parser.py -v -k compute_pacing`
Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/transcript_parser.py tests/test_transcript_parser.py
git commit -m "feat(analytics): compute_pacing with inter-turn latencies and idle gaps"
```

### Task 12: `transcript_parser.py` — `compute_context_pressure` and `MODEL_WINDOWS`

**Files:**
- Modify: `scripts/transcript_parser.py`
- Modify: `tests/test_transcript_parser.py`

- [ ] **Step 1: Add failing test**

Append to `tests/test_transcript_parser.py`:

```python
def test_compute_context_pressure_known_model(tmp_path):
    path = str(tmp_path / "t.jsonl")
    make_synthetic_transcript(path, session_id="s", num_turns=5, compaction_at=2)
    t = tp.parse_transcript(path)
    pressure = tp.compute_context_pressure(t, model="claude-opus-4-7")
    assert pressure["window_tokens"] == 200_000
    assert pressure["compaction_count"] == 1
    assert pressure["max_utilization_pct"] is not None
    assert 0 <= pressure["max_utilization_pct"] <= 100


def test_compute_context_pressure_unknown_model(tmp_path):
    path = str(tmp_path / "t.jsonl")
    make_synthetic_transcript(path, session_id="s", num_turns=2)
    t = tp.parse_transcript(path)
    pressure = tp.compute_context_pressure(t, model="claude-future-x-0")
    assert pressure["window_tokens"] is None
    assert pressure["max_utilization_pct"] is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_transcript_parser.py -v -k compute_context_pressure`
Expected: FAIL — attribute missing.

- [ ] **Step 3: Implement compute_context_pressure and MODEL_WINDOWS**

Append to `scripts/transcript_parser.py`:

```python
# Context window sizes in tokens. Missing model → window_tokens=None, utilization=None.
MODEL_WINDOWS = {
    "claude-opus-4-7":    200_000,
    "claude-opus-4-6":    200_000,
    "claude-sonnet-4-6":  200_000,
    "claude-sonnet-4-5":  200_000,
    "claude-haiku-4-5":   200_000,
}


def compute_context_pressure(transcript, model=None):
    """Estimate context window utilization over the session.

    Reconstructs cumulative input token load between compactions. Utilization is
    the peak cumulative load divided by the model's window size.

    Returns {
        "window_tokens": int | None,
        "max_utilization_pct": float | None,
        "compaction_count": int,
        "utilization_trend": [(timestamp, pct), ...],
    }
    Unknown model → window_tokens and max_utilization_pct are None; trend is empty.
    """
    model_norm = _normalize_model(model)
    window = MODEL_WINDOWS.get(model_norm)
    compactions = transcript.get("compactions", [])
    compaction_count = len(compactions)

    if window is None:
        return {
            "window_tokens": None,
            "max_utilization_pct": None,
            "compaction_count": compaction_count,
            "utilization_trend": [],
        }

    compact_ts = sorted(c.get("timestamp") for c in compactions if c.get("timestamp"))
    running = 0
    max_load = 0
    trend = []
    next_compact_idx = 0
    for entry in transcript.get("usage_per_message", []):
        ts = entry.get("timestamp")
        if next_compact_idx < len(compact_ts) and ts and ts >= compact_ts[next_compact_idx]:
            running = 0  # post-compaction: context has been summarized
            next_compact_idx += 1
        u = entry.get("usage", {})
        running += int(u.get("input_tokens", 0) or 0) + int(u.get("cache_read_input_tokens", 0) or 0)
        max_load = max(max_load, running)
        pct = round(running / window * 100, 2)
        trend.append((ts, pct))

    return {
        "window_tokens": window,
        "max_utilization_pct": round(max_load / window * 100, 2),
        "compaction_count": compaction_count,
        "utilization_trend": trend,
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_transcript_parser.py -v -k compute_context_pressure`
Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/transcript_parser.py tests/test_transcript_parser.py
git commit -m "feat(analytics): compute_context_pressure with MODEL_WINDOWS lookup"
```

### Task 13: Add `generate_synthetic_transcript` to `scripts/generate_test_data.py`

**Files:**
- Modify: `scripts/generate_test_data.py`

- [ ] **Step 1: Read the existing generate_test_data.py to find insertion point**

Run: `head -40 scripts/generate_test_data.py`
Expected: shows the existing module header and first functions. Identify a good place to append (end of file is fine).

- [ ] **Step 2: Append generate_synthetic_transcript**

Append to `scripts/generate_test_data.py`:

```python
# ── Synthetic transcripts (added in v1.1.0) ────────────────────────────

def generate_synthetic_transcript(path, session_id, num_turns=10,
                                   input_tokens_per_turn=1500,
                                   output_tokens_per_turn=600,
                                   cache_read_tokens=300,
                                   cache_creation_tokens=150,
                                   model="claude-opus-4-7",
                                   compaction_at=None):
    """Write a Claude Code-compatible transcript JSONL to `path`.

    Mirrors tests/helpers.make_synthetic_transcript but lives in the user-facing
    test data generator so anyone can produce sample transcripts for
    exercising analytics without running the full test suite.
    """
    import json as _json
    import os as _os
    from datetime import datetime as _dt, timedelta as _td, timezone as _tz
    _os.makedirs(_os.path.dirname(path) or ".", exist_ok=True)
    t0 = _dt(2026, 4, 17, 10, 0, 0, tzinfo=_tz.utc)
    with open(path, "w", encoding="utf-8") as f:
        for i in range(num_turns):
            ts = (t0 + _td(seconds=i * 30)).isoformat()
            user_line = {
                "type": "user", "timestamp": ts, "sessionId": session_id,
                "message": {"role": "user", "content": f"prompt {i}"},
            }
            f.write(_json.dumps(user_line) + "\n")
            assistant_ts = (t0 + _td(seconds=i * 30 + 5)).isoformat()
            assistant_line = {
                "type": "assistant", "timestamp": assistant_ts, "sessionId": session_id,
                "message": {
                    "role": "assistant", "model": model,
                    "content": [{"type": "text", "text": f"reply {i}"}],
                    "usage": {
                        "input_tokens": input_tokens_per_turn,
                        "output_tokens": output_tokens_per_turn,
                        "cache_read_input_tokens": cache_read_tokens,
                        "cache_creation_input_tokens": cache_creation_tokens,
                    },
                },
            }
            f.write(_json.dumps(assistant_line) + "\n")
            if compaction_at is not None and i == compaction_at:
                comp_line = {
                    "type": "system", "timestamp": assistant_ts,
                    "sessionId": session_id, "subtype": "compact_boundary",
                }
                f.write(_json.dumps(comp_line) + "\n")
```

- [ ] **Step 3: Verify the function is importable and runs**

Run:
```bash
python -c "
from scripts.generate_test_data import generate_synthetic_transcript
import tempfile, os
with tempfile.TemporaryDirectory() as d:
    p = os.path.join(d, 't.jsonl')
    generate_synthetic_transcript(p, 'test', num_turns=2)
    with open(p) as f:
        lines = f.readlines()
    assert len(lines) == 4
    print('ok')
"
```
Expected: prints `ok`.

- [ ] **Step 4: Commit**

```bash
git add scripts/generate_test_data.py
git commit -m "test: add generate_synthetic_transcript to generate_test_data"
```

### Task 14: `analytics.py` — add transcript pass to `compute_metrics`

**Files:**
- Modify: `scripts/analytics.py`
- Create: `tests/test_analytics_integration.py`

- [ ] **Step 1: Write the failing integration test**

Write `tests/test_analytics_integration.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_analytics_integration.py -v`
Expected: `test_analytics_handles_no_transcripts` may pass (no new fields required); `test_analytics_merges_transcript_data_when_present` FAILS because `tokens` bucket doesn't exist yet.

- [ ] **Step 3: Modify analytics.py to import transcript_parser and merge metrics**

Edit `scripts/analytics.py`. At the top of the file (after the existing imports), add:

```python
# v1.1.0: transcript-derived metrics
try:
    import transcript_parser
except ImportError:
    # allow module to load even if parser is missing; analytics will skip transcript data
    transcript_parser = None
```

At the end of `compute_metrics(sessions_dir)`, immediately before the final `return metrics`, insert:

```python
    # ── v1.1.0: transcript-derived metrics (tokens/cost/pacing/pressure) ──
    tokens_by_sid = {}
    cost_by_sid = {}
    pacing_by_sid = {}
    pressure_by_sid = {}
    cwd = os.path.dirname(os.path.abspath(sessions_dir))  # project root
    if transcript_parser is not None:
        for s in sessions:
            sid = s.get("session_id") or ""
            if not sid:
                continue
            tpath = transcript_parser.find_transcript_path(sid, cwd=cwd)
            if not tpath:
                continue
            t = transcript_parser.parse_transcript(tpath)
            if not t:
                continue
            tokens_by_sid[sid] = transcript_parser.compute_usage_totals(t)
            cost_by_sid[sid] = transcript_parser.estimate_cost(
                tokens_by_sid[sid], model=t.get("model"))
            pacing_by_sid[sid] = transcript_parser.compute_pacing(t)
            pressure_by_sid[sid] = transcript_parser.compute_context_pressure(
                t, model=t.get("model"))
    metrics["tokens"] = tokens_by_sid
    metrics["cost"] = cost_by_sid
    metrics["pacing"] = pacing_by_sid
    metrics["pressure"] = pressure_by_sid
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_analytics_integration.py -v`
Expected: both tests PASS.

- [ ] **Step 5: Verify unit tests still pass**

Run: `python -m pytest tests/ -v`
Expected: all tests pass (gate tests, transcript_parser tests, analytics integration tests).

- [ ] **Step 6: Commit**

```bash
git add scripts/analytics.py tests/test_analytics_integration.py
git commit -m "feat(analytics): merge transcript-derived token/cost/pacing/pressure metrics"
```

### Task 15: `analytics.py` — add new markdown sections

**Files:**
- Modify: `scripts/analytics.py`

- [ ] **Step 1: Manually verify current markdown output (baseline)**

Run: `python scripts/analytics.py --project-dir . --format markdown 2>&1 | head -40` (or use a test fixture project)
Expected: see the existing sections (Overview, Planning Quality, etc.). Note absence of Token/Cost/Pacing/Pressure sections.

- [ ] **Step 2: Modify format_markdown to add the four new sections**

In `scripts/analytics.py`, inside `format_markdown(metrics)`, immediately before the final `# ── Insights ──` block, insert:

```python
    # ── Token Spend (v1.1.0) ──
    tokens = metrics.get("tokens", {})
    if tokens:
        lines.append("### Token Spend")
        lines.append("")
        total_input = sum(v.get("input", 0) for v in tokens.values())
        total_output = sum(v.get("output", 0) for v in tokens.values())
        total_cache_read = sum(v.get("cache_read", 0) for v in tokens.values())
        total_cache_creation = sum(v.get("cache_creation", 0) for v in tokens.values())
        overall_total = total_input + total_output + total_cache_read + total_cache_creation
        avg_hit_rate = (
            sum(v.get("cache_hit_rate", 0.0) for v in tokens.values()) / len(tokens)
            if tokens else 0.0
        )
        lines.append("| Metric | Value |")
        lines.append("|--------|-------|")
        lines.append(f"| Total input tokens | {total_input:,} |")
        lines.append(f"| Total output tokens | {total_output:,} |")
        lines.append(f"| Total cache_read tokens | {total_cache_read:,} |")
        lines.append(f"| Total cache_creation tokens | {total_cache_creation:,} |")
        lines.append(f"| Overall total | {overall_total:,} |")
        lines.append(f"| Avg cache hit rate | {round(avg_hit_rate, 1)}% {bar(avg_hit_rate, 100)} |")
        lines.append("")

    # ── Estimated Cost (v1.1.0) ──
    cost = metrics.get("cost", {})
    known_costs = [v for v in cost.values() if v.get("cost_usd") is not None]
    if known_costs:
        lines.append("### Estimated Cost")
        lines.append("")
        total_cost = sum(v.get("cost_usd", 0.0) for v in known_costs)
        lines.append(f"| Metric | Value |")
        lines.append(f"|--------|-------|")
        lines.append(f"| Sessions with known pricing | {len(known_costs)} / {len(cost)} |")
        lines.append(f"| Total estimated spend | ${total_cost:.2f} |")
        if len(known_costs) > 0:
            per_sess = total_cost / len(known_costs)
            lines.append(f"| Avg cost per session | ${per_sess:.2f} |")
        disclaimer = known_costs[0].get("disclaimer", "")
        lines.append("")
        lines.append(f"_{disclaimer}_")
        unknown_count = len(cost) - len(known_costs)
        if unknown_count > 0:
            lines.append(f"_{unknown_count} session(s) had unknown models; not priced._")
        lines.append("")

    # ── Context Pressure (v1.1.0) ──
    pressure = metrics.get("pressure", {})
    if pressure:
        known_pressure = [v for v in pressure.values() if v.get("max_utilization_pct") is not None]
        lines.append("### Context Pressure")
        lines.append("")
        total_compactions = sum(v.get("compaction_count", 0) for v in pressure.values())
        lines.append(f"| Metric | Value |")
        lines.append(f"|--------|-------|")
        lines.append(f"| Total compactions across sessions | {total_compactions} |")
        if known_pressure:
            max_seen = max(v.get("max_utilization_pct", 0.0) for v in known_pressure)
            avg_seen = sum(v.get("max_utilization_pct", 0.0) for v in known_pressure) / len(known_pressure)
            lines.append(f"| Peak utilization seen | {max_seen:.1f}% {bar(max_seen, 100)} |")
            lines.append(f"| Avg peak utilization | {avg_seen:.1f}% {bar(avg_seen, 100)} |")
        lines.append("")

    # ── Pacing (v1.1.0) ──
    pacing = metrics.get("pacing", {})
    if pacing:
        lines.append("### Pacing")
        lines.append("")
        medians = [v.get("inter_turn_median_ms", 0.0) for v in pacing.values() if v.get("inter_turn_median_ms", 0.0) > 0]
        total_idle = sum(len(v.get("idle_gaps_sec", [])) for v in pacing.values())
        lines.append(f"| Metric | Value |")
        lines.append(f"|--------|-------|")
        if medians:
            avg_median = sum(medians) / len(medians)
            lines.append(f"| Avg median inter-turn latency | {avg_median/1000:.1f}s |")
        lines.append(f"| Total idle gaps (>60s) | {total_idle} |")
        lines.append("")
```

- [ ] **Step 3: Run analytics against a synthetic project with transcripts**

Run (using a tmp directory to avoid polluting the repo):

```bash
python -c "
import os, tempfile, subprocess, sys, json
from tests.helpers import make_session_file, make_synthetic_transcript
with tempfile.TemporaryDirectory() as d:
    sd = os.path.join(d, '.claude-sessions')
    os.makedirs(os.path.join(sd, 'sessions'))
    from datetime import datetime
    today = datetime.now().strftime('%Y-%m-%d')
    make_session_file(sd, today, 'demo', session_id='s1')
    fh = os.path.join(d, 'fake_home')
    pd = os.path.join(fh, '.claude', 'projects', '-demo')
    os.makedirs(pd)
    make_synthetic_transcript(os.path.join(pd, 's1.jsonl'), 's1', num_turns=4)
    env = {**os.environ, 'HOME': fh}
    r = subprocess.run([sys.executable, 'scripts/analytics.py', '--project-dir', d, '--format', 'markdown'],
                       env=env, capture_output=True, text=True)
    print(r.stdout)
"
```
Expected: output includes `### Token Spend`, `### Estimated Cost`, `### Context Pressure`, `### Pacing` sections.

- [ ] **Step 4: Commit**

```bash
git add scripts/analytics.py
git commit -m "feat(analytics): add Token/Cost/Pressure/Pacing sections to markdown output"
```

### Task 16: `dashboard.py` — add new Chart.js charts

**Files:**
- Modify: `scripts/dashboard.py`

- [ ] **Step 1: Read the current dashboard.py to find the chart-rendering section**

Run: `grep -n "Chart" scripts/dashboard.py | head -20`
Expected: shows lines where existing charts are defined. Identify where new charts should be appended (typically right before the final HTML close or in the chart-definition block).

- [ ] **Step 2: Modify dashboard.py to compute the same metrics analytics.py computes**

In `scripts/dashboard.py`, ensure the metrics source includes tokens/cost/pressure/pacing. If dashboard.py already calls `compute_metrics()`, the new buckets are present automatically. If dashboard.py computes independently, add:

```python
# v1.1.0: import the same metrics pass used by analytics.py
from analytics import compute_metrics as _compute_metrics_full
metrics = _compute_metrics_full(sessions_dir)  # replaces any duplicated local compute
```

Then, add the following HTML/JS snippet inside the chart-rendering block (between existing charts and the closing `</body>`):

```html
<section>
  <h2>Token Spend (v1.1.0)</h2>
  <canvas id="chartTokensByType"></canvas>
  <canvas id="chartCacheHitRate"></canvas>
</section>
<section>
  <h2>Estimated Cost</h2>
  <canvas id="chartCostPerSession"></canvas>
  <p class="disclaimer">Estimates use public per-model rates as of 2026-01. Unknown models are omitted.</p>
</section>
<section>
  <h2>Context Pressure</h2>
  <canvas id="chartContextUtilization"></canvas>
</section>
<section>
  <h2>Pacing</h2>
  <canvas id="chartPromptToFirstTool"></canvas>
</section>
<script>
(function() {
  const tokens = METRICS.tokens || {};
  const cost = METRICS.cost || {};
  const pressure = METRICS.pressure || {};
  const pacing = METRICS.pacing || {};
  const sids = Object.keys(tokens);

  if (sids.length > 0) {
    new Chart(document.getElementById('chartTokensByType'), {
      type: 'bar',
      data: {
        labels: sids,
        datasets: [
          {label: 'input',          data: sids.map(s => tokens[s].input          || 0), stack: 't'},
          {label: 'output',         data: sids.map(s => tokens[s].output         || 0), stack: 't'},
          {label: 'cache_read',     data: sids.map(s => tokens[s].cache_read     || 0), stack: 't'},
          {label: 'cache_creation', data: sids.map(s => tokens[s].cache_creation || 0), stack: 't'},
        ],
      },
      options: {scales: {x: {stacked: true}, y: {stacked: true}}},
    });

    new Chart(document.getElementById('chartCacheHitRate'), {
      type: 'line',
      data: {
        labels: sids,
        datasets: [{
          label: 'Cache hit rate %',
          data: sids.map(s => tokens[s].cache_hit_rate || 0),
          tension: 0.2,
        }],
      },
    });
  }

  const knownCost = sids.filter(s => cost[s] && cost[s].cost_usd != null);
  if (knownCost.length > 0) {
    new Chart(document.getElementById('chartCostPerSession'), {
      type: 'bar',
      data: {
        labels: knownCost,
        datasets: [{label: 'Cost USD', data: knownCost.map(s => cost[s].cost_usd)}],
      },
    });
  }

  const knownPressure = sids.filter(s => pressure[s] && pressure[s].max_utilization_pct != null);
  if (knownPressure.length > 0) {
    new Chart(document.getElementById('chartContextUtilization'), {
      type: 'line',
      data: {
        labels: knownPressure,
        datasets: [{
          label: 'Max utilization %',
          data: knownPressure.map(s => pressure[s].max_utilization_pct),
          tension: 0.2,
        }],
      },
      options: {scales: {y: {min: 0, max: 100}}},
    });
  }

  const pacingSids = Object.keys(pacing);
  if (pacingSids.length > 0) {
    const flat = [];
    pacingSids.forEach(s => (pacing[s].prompt_to_first_tool_ms || []).forEach(v => flat.push(v)));
    if (flat.length > 0) {
      const buckets = [0, 500, 1000, 2500, 5000, 10000, 30000];
      const counts = new Array(buckets.length).fill(0);
      flat.forEach(v => {
        for (let i = buckets.length - 1; i >= 0; i--) {
          if (v >= buckets[i]) { counts[i]++; break; }
        }
      });
      new Chart(document.getElementById('chartPromptToFirstTool'), {
        type: 'bar',
        data: {
          labels: buckets.map(b => b < 1000 ? `${b}ms` : `${b/1000}s`),
          datasets: [{label: 'Prompt → first tool (count)', data: counts}],
        },
      });
    }
  }
})();
</script>
```

Note: `METRICS` is the JS variable dashboard.py serializes metrics into (verify the existing variable name in dashboard.py and align).

- [ ] **Step 3: Generate a dashboard with synthetic data and open it**

Run:
```bash
python -c "
import os, tempfile, subprocess, sys
from tests.helpers import make_session_file, make_synthetic_transcript
from datetime import datetime
d = tempfile.mkdtemp()
sd = os.path.join(d, '.claude-sessions')
os.makedirs(os.path.join(sd, 'sessions'))
today = datetime.now().strftime('%Y-%m-%d')
make_session_file(sd, today, 'demo', session_id='s1')
fh = os.path.join(d, 'fake_home')
pd = os.path.join(fh, '.claude', 'projects', '-demo')
os.makedirs(pd)
make_synthetic_transcript(os.path.join(pd, 's1.jsonl'), 's1', num_turns=4)
env = {**os.environ, 'HOME': fh}
subprocess.run([sys.executable, 'scripts/dashboard.py', '--project-dir', d], env=env, check=True)
print('Dashboard path:', os.path.join(sd, 'dashboard.html'))
"
```
Expected: dashboard.html generated; open in browser and visually confirm new charts render.

- [ ] **Step 4: Commit**

```bash
git add scripts/dashboard.py
git commit -m "feat(dashboard): add tokens/cost/pressure/pacing charts"
```

---

## Phase 3: Skills rewrite + docs + ship

### Task 17: Rewrite `skills/elephants-never-forget/SKILL.md` via `superpowers:writing-skills`

**Files:**
- Modify: `skills/elephants-never-forget/SKILL.md`

- [ ] **Step 1: Invoke the writing-skills skill**

In the execution session, invoke: `Skill: superpowers:writing-skills` with the target file `skills/elephants-never-forget/SKILL.md`. Follow the skill's guidance for auditing.

- [ ] **Step 2: Audit the current SKILL.md against writing-skills patterns**

Specifically check:
- Is the `description` field <200 chars and specific enough for auto-invocation? Does it explicitly name the session-start trigger?
- Is there a numbered checklist for session start?
- Is there a "red flags" table (thoughts → reality) matching the writing-skills pattern?
- Are common mistakes listed in a table?
- Is the Quick Reference row count reasonable (not duplicating other sections)?

- [ ] **Step 3: Rewrite the file with these required elements**

Rewrite `skills/elephants-never-forget/SKILL.md` to contain:

1. Frontmatter with a tightened `description` that mentions: (a) session-start trigger, (b) the hard gate, (c) decision tracking.

2. A new section `## Session Start Protocol` that is a numbered checklist:

    1. Read the injected context at the top of the conversation.
    2. If `.claude-sessions/sessions/YYYY-MM-DD-<slug>.md` doesn't exist for today, create it with the required frontmatter + `## Intent` section.
    3. (Optional) Create `.claude-sessions/.active/<session-id-prefix>` marker.
    4. Resume work.

3. A new section `## The Gate` explaining:
    - What the gate does: denies non-creation tool calls until today's session file exists.
    - How to satisfy it: create the session file.
    - How to opt out: `Write .claude-sessions/.opt-out/<session-id-prefix>` (empty file).
    - What a denial looks like: shows the exact JSON shape `{"decision": "deny", "reason": "..."}`.

4. A red-flags table:

    | Thought | Reality |
    |---------|---------|
    | "I'll just read the file first, then create the session log" | Gate will deny the Read. Create the session file first. |
    | "This is a quick task; skip logging" | Quick tasks still benefit from the record. Make the file; keep it short. |
    | "The SessionStart hook already captured things" | Hooks capture events. The skill captures *meaning* (intent, decisions). |
    | "I'll batch updates at the end" | PreCompact can fire sooner than expected. Update at natural breakpoints. |

5. Retain all existing sections that describe file formats, confidence levels, decisions.md, topics.md, progressive summarization, long sessions, session resume, common mistakes. Streamline the Quick Reference to drop rows that duplicate Session Start Protocol.

6. Ensure the final file is self-contained: a reader with no prior context can perform the protocol from the file alone.

- [ ] **Step 4: Self-review against writing-skills checklist**

Verify:
- No TBDs, TODOs, placeholders.
- Description field ≤200 chars.
- Session Start Protocol is numbered and actionable.
- Red flags table present.
- Quick Reference doesn't duplicate other sections.

- [ ] **Step 5: Commit**

```bash
git add skills/elephants-never-forget/SKILL.md
git commit -m "skills(ene): rewrite via writing-skills — add Session Start Protocol, Gate, red flags"
```

### Task 18: Rewrite `skills/session-analytics/SKILL.md` via `superpowers:writing-skills`

**Files:**
- Modify: `skills/session-analytics/SKILL.md`

- [ ] **Step 1: Invoke writing-skills**

In the execution session, invoke `Skill: superpowers:writing-skills` with `skills/session-analytics/SKILL.md`.

- [ ] **Step 2: Rewrite with these required elements**

Rewrite `skills/session-analytics/SKILL.md` to contain:

1. Frontmatter with tightened `description` that explicitly names the metric axes it surfaces (decision quality, friction, token spend, cost, cache efficiency, context pressure, pacing).

2. Retain the two output modes (inline markdown, full HTML dashboard).

3. Expand the interpretation table with new rows for v1.1.0 metrics:

    | Metric | Good | Needs attention | How to improve |
    |--------|------|-----------------|----------------|
    | Cache hit rate | >60% | <30% | Long stable contexts improve cache reuse; avoid churning the early turns. |
    | Cost per session | project-dependent | unexpected spikes | Check context utilization; consider Haiku for cheaper work. |
    | Peak context utilization | <70% | >90% | Sessions running near the window compact often and lose detail. Break up the work. |
    | Idle gaps count | few | many | Long gaps suggest interrupted flow; consider shorter sessions. |

4. Constructive framing: every new metric row should end with "here's what you can try" style guidance.

5. Keep the "When to offer analytics" section; add a trigger for "user asks about cost or efficiency."

- [ ] **Step 3: Self-review**

Verify no placeholders; description field is specific.

- [ ] **Step 4: Commit**

```bash
git add skills/session-analytics/SKILL.md
git commit -m "skills(analytics): rewrite via writing-skills — add token/cost/pressure/pacing guidance"
```

### Task 19: Update `README.md` — add "The Gate" section and refresh metrics list

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read current README**

Run: `cat README.md | head -60`
Expected: see the existing sections (What it does, Why, Install, File Structure, How it works, Analytics Dashboard, Requirements).

- [ ] **Step 2: Add a "The Gate" subsection under "How it works"**

Insert after the existing Hooks table and Skill description:

```markdown
### The Gate (v1.1.0)

Two hooks — `UserPromptSubmit` and `PreToolUse` — enforce session-file creation:

- On each prompt, if today's session file is missing, a `<system-reminder>` block is injected telling Claude to create it first.
- On each tool call, if neither a session file for today nor an opt-out marker exists, Claude's tool calls are denied *unless* the tool is a `Write` into `.claude-sessions/sessions/` or `.claude-sessions/.opt-out/` (the creation path).
- **Opt-out:** create an empty marker at `.claude-sessions/.opt-out/<session-id>` and the gate will be silent for that session.
- **Fail-open:** any filesystem or parsing error in the gate defaults to *allow*. The gate can never brick a session.
- **Hot-path cost:** ~1ms per invocation once today's session file exists (single filesystem glob).
```

- [ ] **Step 3: Refresh the metrics list under "Analytics Dashboard"**

Replace the "Metrics tracked" table with:

```markdown
### Metrics tracked

| Category | What it measures |
|----------|-----------------|
| **Planning** | Decision reversal rate, stability (>7 days), confidence distribution |
| **Clarity** | Friction events, redirects per session, prompt frequency |
| **Efficiency** | Completion rate, open items backlog, session focus |
| **Tokens** *(v1.1.0)* | Input/output/cache token totals, cache hit rate |
| **Cost** *(v1.1.0)* | Estimated USD per session (from current Opus/Sonnet/Haiku rates) |
| **Context pressure** *(v1.1.0)* | Peak utilization %, compaction count per session |
| **Pacing** *(v1.1.0)* | Inter-turn latency, idle gaps, prompt→first-tool latency |
| **Patterns** | Topic distribution, recurring errors, active days, tool usage |
| **Insights** | Actionable recommendations |
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document The Gate and refresh analytics metrics for v1.1.0"
```

### Task 20: Bump version to 1.1.0

**Files:**
- Modify: `.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`

- [ ] **Step 1: Read both files**

Run: `cat .claude-plugin/plugin.json .claude-plugin/marketplace.json`
Expected: current version shown as 1.0.0 in both.

- [ ] **Step 2: Update version in plugin.json**

In `.claude-plugin/plugin.json`, change:
```json
"version": "1.0.0",
```
to:
```json
"version": "1.1.0",
```

- [ ] **Step 3: Update version in marketplace.json**

In `.claude-plugin/marketplace.json`, change the plugin entry's version from `"1.0.0"` to `"1.1.0"`.

- [ ] **Step 4: Verify JSON validity**

Run:
```bash
python -c "import json; json.load(open('.claude-plugin/plugin.json')); json.load(open('.claude-plugin/marketplace.json')); print('ok')"
```
Expected: prints `ok`.

- [ ] **Step 5: Commit**

```bash
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore: bump version to 1.1.0"
```

### Task 21: Final verification against acceptance criteria

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `python -m pytest tests/ -v`
Expected: ALL tests pass.

- [ ] **Step 2: Verify acceptance criterion 1 — session file creation**

Run the Phase 1 smoke test from Task 7 again against a scratch project. Confirm:
- First `UserPromptSubmit` without a session file → reminder.
- First `PreToolUse` (non-Write-to-sessions) without a session file → deny.
- After session file exists → both silent.

- [ ] **Step 3: Verify acceptance criterion 2 — opt-out**

Run:
```bash
mkdir -p /tmp/ene-optout/.claude-sessions/.opt-out
touch /tmp/ene-optout/.claude-sessions/.opt-out/s1
CLAUDE_PROJECT_DIR=/tmp/ene-optout echo '{"hook_event_name":"PreToolUse","session_id":"s1","tool_name":"Read","tool_input":{"file_path":"/tmp/foo"}}' | python scripts/gate.py
```
Expected: no stdout (silent allow).

- [ ] **Step 4: Verify acceptance criteria 3 & 4 — analytics with and without transcripts**

Both covered by `tests/test_analytics_integration.py`. Confirm both integration tests pass.

- [ ] **Step 5: Verify acceptance criterion 5 — gate failure modes**

Run:
```bash
# Simulate garbled stdin
echo "not json" | python scripts/gate.py
echo "Exit code: $?"
```
Expected: exit 0, no stdout.

- [ ] **Step 6: Verify acceptance criterion 6 — dashboard renders**

Re-run the dashboard generation from Task 16 step 3. Open the resulting `dashboard.html` in a browser and confirm:
- Existing charts still render.
- New charts (Token Spend, Cache Hit Rate, Cost per Session, Context Utilization, Prompt→First Tool) render without console errors.

- [ ] **Step 7: Verify acceptance criterion 7 — skill self-review**

Re-read both SKILL.md files. Confirm:
- No TBDs/placeholders.
- Description <200 chars.
- Red flags tables present (main skill only).
- Interpretation guidance updated (analytics skill).

- [ ] **Step 8: Verify acceptance criterion 8 — version**

Run: `grep version .claude-plugin/plugin.json`
Expected: `"version": "1.1.0"`.

- [ ] **Step 9: Verify acceptance criterion 9 — README updated**

Run: `grep -c "The Gate" README.md && grep -c "v1.1.0" README.md`
Expected: both > 0.

- [ ] **Step 10: Verify acceptance criterion 10 — hot-path timing**

Run, with a session file already created:

```bash
mkdir -p /tmp/ene-hot/.claude-sessions/sessions
TODAY=$(date +%Y-%m-%d)
echo "---" > /tmp/ene-hot/.claude-sessions/sessions/$TODAY-a.md
for i in 1 2 3 4 5; do
  CLAUDE_PROJECT_DIR=/tmp/ene-hot /usr/bin/time -f "%e" python scripts/gate.py <<< '{"hook_event_name":"PreToolUse","session_id":"s","tool_name":"Read","tool_input":{"file_path":"/tmp/foo"}}' 2>&1 | tail -1
done
```
Expected: Python startup dominates (~50-100ms); gate logic itself well under 5ms. If total invocation is significantly over 100ms, profile and optimize.

- [ ] **Step 11: Commit final state (no changes expected, but run to be safe)**

Run: `git status`
Expected: clean working tree.

### Task 22: Tag the release

**Files:** none (git tag only)

- [ ] **Step 1: Tag v1.1.0**

Run: `git tag -a v1.1.0 -m "v1.1.0: hard gate, transcript analytics, skill audit"`

- [ ] **Step 2: Confirm tag**

Run: `git tag -l "v1.1.0"`
Expected: prints `v1.1.0`.

- [ ] **Step 3: (Optional) push tag if user has requested it**

```bash
# Only if explicitly requested by the user:
# git push origin main
# git push origin v1.1.0
```
Do NOT push without explicit user confirmation.

---

## Plan Self-Review

**Spec coverage check:**
- Goal: near-100% session file creation → Tasks 3–7 (gate + hooks).
- Goal: transcript analytics → Tasks 8–12, 14, 15 (parser + analytics + dashboard).
- Goal: tighter skills → Tasks 17–18.
- Goal: preserve opt-out → Gate handler tests specifically cover this (Task 5).
- Goal: backward compat → `test_analytics_handles_no_transcripts` in Task 14 guards this.
- Non-goals all respected: no daemons, stdlib only, no schema change to existing JSONL.

**Placeholder scan:** No "TBD/TODO/implement later". Each step has actual content (test code, implementation code, commands). Skill rewrite tasks (17, 18) require the *contents* of the target sections, which are specified item-by-item in the step.

**Type / signature consistency:**
- `session_file_exists_today(sessions_dir)` — consistent across Tasks 3–5.
- `compute_usage_totals(transcript) -> dict` — used with `metrics["tokens"][sid]` feeding into `estimate_cost(usage, model)` (Tasks 9–10).
- `estimate_cost(usage, model=None)` — `usage` shape matches what `compute_usage_totals` returns.
- `compute_context_pressure(transcript, model=None)` — `model` kwarg, not `model_window`, matches spec (Section 6).
- `PRICING_TABLE_V1` and `MODEL_WINDOWS` — both module constants in `transcript_parser.py`, defined in Tasks 10 and 12.
- Hooks output shape — `{"decision": "deny", "reason": "..."}` in Task 5 matches the spec (Section 9).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-17-enf-v1-1-hard-gate-and-analytics.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. Uses `superpowers:subagent-driven-development`.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach?
