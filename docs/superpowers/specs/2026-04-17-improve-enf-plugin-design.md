# Design: Elephants Never Forget — Hard Gate, Transcript Analytics, Skill Audit

**Version:** 1.0
**Date:** 2026-04-17
**Target plugin version:** 1.1.0
**Status:** Proposed

## Background

During the 2026-04-17 review of the `elephants-never-forget` plugin, three gaps were identified:

1. **Session-file creation is unreliable.** Two prior sessions logged in `.claude-sessions/log.md` produced zero files under `.claude-sessions/sessions/`. The hooks captured prompts mechanically, but Claude did not invoke the skill to create session files. Auto-invocation through the `description` field alone is insufficient in practice.

2. **Analytics lacks token/cost/pacing data.** The dashboard tracks decision quality, friction, and counts — but not token spend, cache hit rate, or inter-turn latency. The user initially suggested using `/context` and `/usage`; those are TUI commands and cannot be called from hooks. However, every hook invocation receives a `transcript_path` pointing to a JSONL file with per-message token usage — strictly richer than what `/context` or `/usage` would produce.

3. **SKILL.md files need a writing-skills pass.** The `description` fields (load-bearing for auto-invocation) and the common-mistakes sections can be tightened. A full audit with `superpowers:writing-skills` guidance is preferred over surgical edits.

## Goals

- Near-100% reliability: new sessions create a session file before the first non-creation tool call.
- Automatic capture of token/cost/pacing metrics from transcripts, with zero new runtime dependencies and zero hot-path cost.
- Tighter, more discoverable skills with clearer auto-invocation triggers.
- Preserve the opt-out path (`"don't track this session"`).
- Preserve backward compatibility with existing `.claude-sessions/` data.

## Non-goals

- Alternative logging backends (SQLite, remote DBs).
- Features requiring daemons, cron, or background workers.
- Porting to non-stdlib runtime dependencies.
- Changes to the JSONL event schema written by `session_logger.py`.
- Replacing Claude's built-in memory system.

## Design principle: lightweight by construction

The plugin complements workflows; it is not the center of gravity.

- Hot path (every prompt, every tool call): <5ms per hook invocation. Once today's session file exists, gate hooks are a single `glob.glob` + return.
- Cold path (transcript parsing, analytics, dashboard): runs only when the user explicitly invokes `session-analytics` or the dashboard script.
- No daemons, cron, or background processes.
- Stdlib only. `pytest` permitted as a dev-only dependency for tests.

## Architecture

Three orthogonal subsystems, cleanly bounded:

```
┌─ Enforcement (hot path) ─────────────────────────────────────┐
│   scripts/gate.py  ← UserPromptSubmit, PreToolUse           │
│   fails open on error; <5ms typical                          │
└──────────────────────────────────────────────────────────────┘

┌─ Analytics (cold path, user-invoked) ────────────────────────┐
│   scripts/transcript_parser.py  (pure, stateless, new)       │
│       ↓ imported by                                           │
│   scripts/analytics.py, scripts/dashboard.py (existing)      │
└──────────────────────────────────────────────────────────────┘

┌─ Skills (content) ───────────────────────────────────────────┐
│   skills/elephants-never-forget/SKILL.md  (rewritten)        │
│   skills/session-analytics/SKILL.md       (rewritten)        │
│   — via superpowers:writing-skills guidance                  │
└──────────────────────────────────────────────────────────────┘
```

## Components

### `scripts/gate.py` (new, ~150 LOC)

Dispatches on `hook_event_name`:

**`UserPromptSubmit` handler:**
1. Compute `today = YYYY-MM-DD`.
2. `glob(".claude-sessions/sessions/{today}-*.md")` → if any match: exit 0 silently.
3. `os.path.exists(".claude-sessions/.opt-out/<session-id>")` → if exists: exit 0 silently.
4. Else print a `<system-reminder>` block to stdout with:
   - The exact path to create: `.claude-sessions/sessions/YYYY-MM-DD-<slug>.md`
   - Slug rules: `[a-z0-9-]` only, ≤40 chars, 2–5 words
   - The directive: "Before responding to this prompt, create the session file described above. The plugin's PreToolUse gate will deny other tool calls until it exists."

**`PreToolUse` handler:**
1. Same session-file + opt-out checks as above → if either: exit 0 (allow).
2. If tool is `Write` and `file_path` is under `.claude-sessions/sessions/` or `.claude-sessions/.opt-out/` → exit 0 (allow).
3. Else emit JSON on stdout: `{"decision": "deny", "reason": "<same text as above reminder>"}`. Exit 0.

**Shared helpers:**
- `sanitize_session_id(sid) -> str` — same regex as `session_logger.py`.
- `session_file_exists_today(sessions_dir) -> bool` — single glob call.
- `opt_out_marker_exists(session_id, sessions_dir) -> bool` — single `os.path.exists`.
- `log_gate_decision(session_id, event, decision, reason)` — append to `.claude-sessions/raw/<session-id>.jsonl` with `event: "gate_decision"`.

**Error handling:** all exceptions → log to stderr, default allow. Never propagate as a hook error.

### `scripts/transcript_parser.py` (new, ~200 LOC, pure / stateless)

**Public API:**

```python
def parse_transcript(path: str) -> dict:
    """Read Claude Code transcript JSONL.
    Returns {"messages": [...], "usage_per_message": [...], "tool_uses": [...],
             "compactions": [...], "model": str | None}.
    Per-line parse failures are skipped. Any file I/O failure → {}."""

def find_transcript_path(session_id: str, cwd: str | None = None) -> str | None:
    """Build ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl.
    Fall back to glob search under ~/.claude/projects/ if direct path not found."""

def compute_usage_totals(transcript: dict) -> dict:
    """Returns {"input", "output", "cache_read", "cache_creation", "total",
                "cache_hit_rate"}."""

def estimate_cost(usage: dict, model: str | None = None) -> dict:
    """Returns {"cost_usd": float | None, "disclaimer": str, "model": str,
                "pricing_version": "v1"}.
    Unknown model → cost_usd=None with disclaimer."""

def compute_pacing(transcript: dict) -> dict:
    """Returns {"inter_turn_median_ms", "inter_turn_p95_ms",
                "idle_gaps_sec": [float], "prompt_to_first_tool_ms": [float]}."""

def compute_context_pressure(transcript: dict, model: str | None = None) -> dict:
    """Looks up context window from MODEL_WINDOWS (module constant).
    Unknown model → utilization fields return None.
    Returns {"max_utilization_pct": float | None, "compaction_count": int,
            "utilization_trend": [(timestamp, pct)], "window_tokens": int | None}."""
```

**Pricing table** — module constant `PRICING_TABLE_V1` with entries for Opus/Sonnet/Haiku per-million-token rates for input, output, cache_read, cache_creation. Unknown model → `cost_usd: None`. All cost output carries a `disclaimer: "Estimate based on public rates as of YYYY-MM-DD; may drift"`.

**Model windows** — module constant `MODEL_WINDOWS` mapping known model IDs to context window size in tokens (e.g., Opus 4.7: 200_000 or 1_000_000 for the 1M variant; Sonnet 4.6: 200_000). Unknown model → utilization fields return `None`.

### `scripts/analytics.py` (modified)

`compute_metrics()` gains a post-pass:

```python
for sid in session_ids:
    path = transcript_parser.find_transcript_path(sid)
    if not path:
        continue
    t = transcript_parser.parse_transcript(path)
    if not t:
        continue
    metrics["tokens"][sid]   = transcript_parser.compute_usage_totals(t)
    metrics["cost"][sid]     = transcript_parser.estimate_cost(
                                   metrics["tokens"][sid], model=t.get("model"))
    metrics["pacing"][sid]   = transcript_parser.compute_pacing(t)
    metrics["pressure"][sid] = transcript_parser.compute_context_pressure(
                                   t, model=t.get("model"))
```

`format_markdown()` gains sections (each omitted if underlying data absent):

- **Token spend** — total, by type, cache hit rate with progress bar.
- **Estimated cost** — per session, trend sparkline, disclaimer footer.
- **Context pressure** — max utilization %, compactions per session, trend sparkline.
- **Pacing** — median inter-turn latency, idle gap distribution.

Existing sections unchanged.

### `scripts/dashboard.py` (modified)

New Chart.js charts (existing charts unchanged):

- Cache hit rate over time (line).
- Tokens by type per session (stacked bar).
- Context utilization at compact/end per session (line, 80% threshold marker).
- Estimated cost per session (bar, with total summary).
- Prompt→first-tool latency (histogram).

### `scripts/generate_test_data.py` (modified)

Adds `generate_synthetic_transcript(session_id, num_turns, avg_input_tokens, cache_hit_ratio, model) -> None` that writes JSONL matching Claude Code's transcript schema — used by tests and to exercise analytics locally.

### `hooks/hooks.json` (modified)

```json
{
  "UserPromptSubmit": [
    { "hooks": [
        { "type": "command", "command": "python \"${CLAUDE_PLUGIN_ROOT}/scripts/session_logger.py\"", "timeout": 10, "async": true },
        { "type": "command", "command": "python \"${CLAUDE_PLUGIN_ROOT}/scripts/gate.py\"",           "timeout": 5 }
    ]}
  ],
  "PreToolUse": [
    { "matcher": ".*", "hooks": [
        { "type": "command", "command": "python \"${CLAUDE_PLUGIN_ROOT}/scripts/gate.py\"",           "timeout": 5 }
    ]}
  ]
}
```

Quoting convention matches existing `hooks/hooks.json` (double-escaped `"${CLAUDE_PLUGIN_ROOT}/..."` to handle spaces in the path).

All existing hook entries (`SessionStart`, `PostToolUse`, `Stop`, `PreCompact`, `SessionEnd`) remain unchanged.

### `skills/elephants-never-forget/SKILL.md` (rewritten via superpowers:writing-skills)

Target structure:

- **Frontmatter** — `description` tightened to name the session-start trigger explicitly and reference the gate. Target length ~200 chars, no vague verbs.
- **Overview** — unchanged in intent; shortened.
- **Session Start Protocol** (new section replacing `Session Lifecycle` step 1) — numbered checklist of exactly what must happen in order: (1) read injected context, (2) create or resume session file, (3) create `.claude-sessions/.active/<session-id>` marker (optional but documented), (4) proceed with the user's request.
- **The Gate** (new section) — explain the enforcement mechanism: what triggers a denial, how to satisfy it (create session file), how to opt out (create opt-out marker), what a denial response looks like.
- **Red flags / rationalizations table** — in the writing-skills pattern: thoughts that indicate skipping, and the reality check.
- Retained sections: file formats, confidence levels, standing decisions format, progressive summarization, long sessions, recalling past sessions, session resume, common mistakes.
- Streamlined **Quick Reference** — drop rows that duplicate Session Lifecycle.

### `skills/session-analytics/SKILL.md` (rewritten via superpowers:writing-skills)

- **Frontmatter** — tighter `description` naming the analytics axes it surfaces.
- **Interpretation guide** expanded: how to read token spend, cache hit rate, cost, pacing for the user. Constructive framing ("here's what you can try").
- **New metric thresholds** in the existing table: cache hit rate bands, cost-per-session sanity bands, context utilization thresholds.

### `.claude-sessions/.opt-out/<session-id>` (runtime artifact)

Empty marker file, created by the skill on "don't track this session" request. Persistent. Gate checks existence only.

### `.claude-sessions/.active/<session-id>` (runtime artifact)

Empty marker file, created by the skill alongside the session markdown. Documented convention; not required by the gate (gate uses glob on `sessions/`). Purpose: lets external tooling quickly answer "does session X have a file?" without re-scanning `sessions/`.

## Data flow

### Normal session start (happy path)

```
SessionStart     → session_logger writes events;
                   inject_context loads history + injects create-file directive
First user prompt → UserPromptSubmit:
                      session_logger logs prompt (async)
                      gate.py: glob(sessions/YYYY-MM-DD-*.md) — empty
                              → prints <system-reminder> to stdout
Claude           → Write(".claude-sessions/sessions/2026-04-17-<slug>.md")
                   PreToolUse: gate.py: path under sessions/ → exit 0
Subsequent tools → PreToolUse: gate.py: session file exists → exit 0
```

### Claude tries to skip ahead

```
Claude ignores reminder, calls Read("src/foo.ts")
PreToolUse → gate.py: no session file, not a Write to sessions/ →
             stdout: {"decision": "deny", "reason": "<directive>"}
Claude receives denial → creates session file → retries Read → allow.
```

### Opt-out

```
User: "don't track this session"
Claude → Write(".claude-sessions/.opt-out/<session-id>")
         PreToolUse: path under .opt-out/ → allow
Gate on subsequent calls → sees marker → allow silently
```

### Analytics (cold path, user-invoked)

```
session-analytics skill → python analytics.py
compute_metrics():
    (existing passes unchanged)
    for sid in session_ids:
        path = transcript_parser.find_transcript_path(sid)
        if path: parse → merge tokens / cost / pacing / pressure
format_markdown() → omits new sections if transcript data absent
```

## Error handling

| Failure | Behavior |
|---|---|
| Gate raises any exception | Default allow. Log to stderr. Hook exits 0. |
| Transcript file missing | Parser returns `{}`. Analytics sections omitted. |
| Transcript line malformed | That line skipped. Parser continues. |
| Pricing table lacks model | `cost_usd: None`, disclaimer explains. |
| Path traversal in session_id | Sanitize to `[a-zA-Z0-9\-]` before any filesystem use. |
| Two prompts race before session file exists | Both receive reminder. Harmless. File created once. |
| Cross-midnight: session spans two dates | Gate refires with new date → Claude creates new-day file (or resumes per Session Resume protocol). |
| `.claude-sessions/` doesn't exist (first-ever run) | Glob returns empty → reminder fires → Claude creates directory + files (Write auto-creates parents). |

## Testing strategy

### Unit tests (stdlib `unittest` or `pytest`)

- `tests/test_gate.py` — feed JSON on stdin via subprocess, assert stdout and exit:
  - session file exists → silent allow
  - opt-out marker → silent allow
  - no session file, UserPromptSubmit → reminder printed
  - no session file, PreToolUse with Write to sessions/ → allow
  - no session file, PreToolUse with Read → deny JSON
  - corrupt stdin → exit 0, no crash
  - filesystem permission error → default allow

- `tests/test_transcript_parser.py` — against synthetic transcripts from `generate_test_data`:
  - well-formed transcript → correct totals, cache hit rate
  - malformed line → skipped, parser continues
  - missing usage fields → handled gracefully
  - unknown model → `cost_usd` is `None`, disclaimer present
  - missing file → `{}`

### Integration tests

- `tests/test_analytics_integration.py` — build a synthetic `.claude-sessions/` tree + synthetic transcripts; run `compute_metrics()`; assert new sections present and values correct; re-run without transcripts and assert existing output unchanged.

### Manual smoke tests (documented in README)

- Fresh project + Claude Code → first prompt triggers gate → Claude creates session file → subsequent tools allowed.
- "don't track this session" → opt-out marker created → no denials.
- `python scripts/dashboard.py --project-dir .` → new charts render.

### Test helpers

- `tests/helpers.py` — build synthetic `.claude-sessions/` trees and synthetic transcripts. Exposed so the same helpers exercise `analytics.py` and `dashboard.py`.

## Acceptance criteria

1. New session in a project with ENF installed → Claude reliably creates a session file in `.claude-sessions/sessions/` before the first non-creation tool call.
2. User says "don't track this session" → no session file created, no denials, opt-out marker present.
3. `python scripts/analytics.py` on a project with transcripts → new Tokens / Cost / Context Pressure / Pacing sections appear.
4. Same command on a project without transcripts → existing output unchanged; new sections omitted.
5. Gate failure modes (corrupt filesystem, permission denied) → session proceeds without user-visible impact.
6. `python scripts/dashboard.py` → new Chart.js charts render without errors.
7. Both rewritten `SKILL.md` files pass writing-skills self-review (no placeholders, tight `description`, checklist present, red-flags table present).
8. Plugin version bumped to 1.1.0 in `.claude-plugin/plugin.json`.
9. `README.md` updated with a new "The Gate" section and refreshed analytics metrics list.
10. Hot-path hooks (`gate.py`) measured at <5ms per invocation when today's session file already exists (the steady-state case after the first turn of a session).

## Rollout / migration

- Version bump: 1.0.0 → 1.1.0.
- Existing user data → preserved. New metrics appear automatically once transcripts are readable (next session onward).
- Users who want to disable the gate → comment out the `gate.py` entries in `hooks/hooks.json`.
- No migration scripts needed.

## Appendix: resolved open questions

| Question | Resolution |
|---|---|
| Session-file detection | Glob `sessions/YYYY-MM-DD-*.md` for today. Cheaper than frontmatter parsing. Cross-midnight re-firing is acceptable. |
| Gate failure mode | Fail-open. The logger stays correct even if the gate breaks. |
| Hook deny JSON shape | `{"decision": "deny", "reason": "..."}`. Implementation plan verifies against current Claude Code hook schema. |
| Transcript path | `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. Glob search as fallback. |
| Pricing | Versioned module constant (`PRICING_TABLE_V1`). Unknown model → `None` + disclaimer. |
| `.active/` marker requirement | Documented convention, not required by the gate. Skill creates it as a nicety. |
