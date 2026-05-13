# Heartbeat Reminder — Design Spec

**Date**: 2026-05-09
**Author**: brainstorming session 5f38b710
**Status**: approved by user, ready for implementation plan
**Related**: per-session gate fix (sibling change in `2026-05-07-per-session-gate-fix.md` session log)

## Problem

The Elephants Never Forget skill instructs the model to update its session file
"every 5–10 interactions at natural breakpoints" — but there is no forcing
function. Once the gate is satisfied (the session file exists), nothing nudges
the model to keep updating it. In practice the file is created at session start,
then often never touched again for the rest of the session.

The user observed this directly: "as my session progresses simultaneously the
files do not keep getting updated."

## Goal

Add a soft, per-prompt heartbeat reminder that fires when the model has gone too
long without updating its session file. The reminder must:

- Be **lightweight**: stay within the existing <5ms hot-path budget; reuse
  already-running plumbing rather than spawning new processes.
- Be **soft**: emit a `<system-reminder>` for the model to see; never deny tool
  calls, never block work.
- Be **fail-open**: any error in the heartbeat path (filesystem, JSON parse,
  etc.) results in silent skip, never a crash, never a stuck session.
- Be **actionable**: the reminder names the session file path and what
  sections to update.

Out of scope (deferred):
- Auto-populating mechanical sections (Files Touched, Errors & Fixes) from
  PostToolUse events. Considered as a future option but rejected for this round
  to avoid blurring the hook/skill boundary and risking corruption of
  model-authored sections.

## Decisions Locked During Brainstorming

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | What counts as "stale"? | **Interaction-based** (count user prompts since mtime) | Reflects actual session activity; idle conversations don't trigger false-positives |
| 2 | Threshold N | **5 prompts** | Matches skill's lower bound of "every 5–10 interactions"; aggressive enough to actually catch the "I forgot to update" case |
| 3 | Where does it live? | **Fold into `scripts/gate.js`** | Reuses existing plumbing on UserPromptSubmit; no extra `node` process spawn (~30ms cold-start avoided) |
| 4 | Scope | **Reminder only**, no auto-population | Keeps mechanical-vs-intelligent layer split clean; auto-population deferred |

## Architecture

The heartbeat is a soft enforcement layer added to the **`UserPromptSubmit`
handler in `scripts/gate.js`**, downstream of the existing per-session gate
check (which the prior change in this session implemented).

Sequence on every UserPromptSubmit:

```
session_logger.js     # already runs first per hooks.json
  └─ appends {event: 'user_prompt', timestamp, ...} to raw/<sid>.jsonl
gate.js
  ├─ no session file for this session → emit gate-deny reminder; return
  ├─ opt-out marker present → return silent
  └─ session file found at <path>
     ├─ stat <path> → mtimeMs
     ├─ count user_prompt events in raw/<sid>.jsonl with timestamp > mtimeMs
     └─ if count ≥ 5 → emit heartbeat reminder; return
```

The current prompt's `user_prompt` event is appended to `raw/<sid>.jsonl` by
`session_logger.js` *before* `gate.js` runs (per `hooks/hooks.json` ordering),
so it is included in the count. A freshly-created session file (mtime ≈ now)
yields count = 1 → no reminder. After five prompts without an update,
count = 5 → reminder fires.

## Components

All additions live in `scripts/gate.js`. No new files.

### 1. `findSessionFileForSession(sessionsDir, sessionId)` *(refactor)*

The existing `sessionFileExistsForSession` returns `boolean`. Refactor to
expose the matching file's path so the heartbeat can stat it without
re-scanning. Implementation: extract a private `findSessionFileForSession`
that returns `{path, fname} | null`; have `sessionFileExistsForSession`
become `return findSessionFileForSession(...) != null` for back-compat with
the existing tests.

### 2. `getSessionFileMtimeMs(filepath)` *(new)*

```js
function getSessionFileMtimeMs(filepath) {
  try { return statSync(filepath).mtimeMs; }
  catch { return null; }
}
```

### 3. `countUserPromptsSince(jsonlPath, sinceMs, cap)` *(new)*

Reads `raw/<sid>.jsonl`, parses each line as JSON, counts entries where
`event === 'user_prompt'` and `Date.parse(timestamp) > sinceMs`. Early-outs
when `count >= cap` to bound work. Returns `0` on file-not-found / read error.
Malformed lines are silently skipped (do not crash).

```js
function countUserPromptsSince(jsonlPath, sinceMs, cap) {
  let count = 0;
  let content;
  try { content = readFileSync(jsonlPath, 'utf8'); } catch { return 0; }
  const lines = content.split('\n');
  for (const line of lines) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.event !== 'user_prompt') continue;
    const ts = Date.parse(entry.timestamp);
    if (Number.isNaN(ts)) continue;
    if (ts > sinceMs) {
      count++;
      if (count >= cap) return count;
    }
  }
  return count;
}
```

### 4. `heartbeatTemplate(filename, count)` *(new)*

Returns a `<system-reminder>` string. Names the file path, the count, and
explicitly lists which sections of the session file to update.

```
<system-reminder>
ELEPHANTS NEVER FORGET — HEARTBEAT

Your session file (.claude-sessions/sessions/<filename>) has not been updated
in <count> user prompts. Per the elephants-never-forget skill, you should
update the session log every 5–10 interactions at natural breakpoints.

Take a moment now to:
- Append recent significant interactions to the Interactions section (not every
  tool call — only ones a future session would care about)
- Capture decisions made (Y-statements; also append to decisions.md if standing)
- Add to Files Touched, Errors & Fixes, Friction Events as applicable

This is advisory, not a deny. Continue with the user's request after updating.
</system-reminder>
```

### 5. Heartbeat constants

```js
const HEARTBEAT_THRESHOLD = 5;          // user prompts since mtime
const HEARTBEAT_COUNT_CAP = HEARTBEAT_THRESHOLD + 1;
```

### 6. Wiring in `handleUserPromptSubmit`

After the existing gate-pass / opt-out checks, add:

```js
try {
  const match = findSessionFileForSession(sessionsDir, sessionId);
  if (!match) return;  // already returned above; defensive
  const mtimeMs = getSessionFileMtimeMs(match.path);
  if (mtimeMs == null) return;
  const sid = sanitizeSessionId(sessionId);
  const jsonlPath = join(sessionsDir, 'raw', `${sid}.jsonl`);
  const count = countUserPromptsSince(jsonlPath, mtimeMs, HEARTBEAT_COUNT_CAP);
  if (count >= HEARTBEAT_THRESHOLD) {
    process.stdout.write(heartbeatTemplate(match.fname, count) + '\n');
    logGateDecision(sessionId, 'UserPromptSubmit', 'heartbeat', `stale:${count}`, sessionsDir);
  }
} catch {
  // fail-open
}
```

## Data Flow Summary

| Hook event | What happens |
|------------|--------------|
| `UserPromptSubmit` | session_logger appends `user_prompt` to jsonl; gate runs; if session file fresh, silent; if stale, heartbeat reminder injected into model context for the next turn |
| `PreToolUse` | gate runs (no heartbeat — heartbeat is only on prompts) |
| `PostToolUse` | session_logger appends `tool_use` (no heartbeat) |
| `Stop` / `SessionEnd` | session_logger appends event (no heartbeat) |

The heartbeat does **not** run on PreToolUse. The reminder is meant to be seen
once per turn, not before every tool call. Adding it to PreToolUse would spam
the model's context.

## Error Handling

The heartbeat path is wrapped in `try { ... } catch {}`. Specific failure
modes:

| Failure | Behavior |
|---------|----------|
| `statSync` on session file fails | Skip heartbeat (silent) |
| `readFileSync` on jsonl fails / file missing | `countUserPromptsSince` returns 0 → no reminder |
| Malformed JSON line in jsonl | Skip that line; continue counting |
| Malformed timestamp in line | Skip that entry; continue |
| `findSessionFileForSession` returns null after gate already passed | Defensive — return silent |

The fail-open guarantee from the existing gate is preserved: a heartbeat bug
must never block a user.

## Testing

Add to `tests/gate.test.js`. New helpers as needed in `tests/helpers.js` (e.g.,
`makeRawJsonl(sessionsDir, sid, events)`). Tests:

1. **No reminder when fresh** — create session file with `mtime = now`, append
   1 user_prompt event with `timestamp = now + 1ms`. Expect silent stdout.
2. **Reminder fires at threshold** — session file with `mtime = now - 1h`,
   5 user_prompt events with timestamps in the last hour. Expect stdout to
   contain `<system-reminder>`, `HEARTBEAT`, and the filename.
3. **No reminder just below threshold** — same setup but only 4 events. Expect
   silent stdout.
4. **Reminder includes correct count** — 7 events. Expect "in 6 user prompts"
   in the reminder text (cap at threshold+1=6).
5. **Fail-open: jsonl missing** — session file exists, no jsonl. Expect silent
   stdout (no crash).
6. **Fail-open: jsonl has malformed lines** — session file exists, jsonl with
   2 valid user_prompt events + 1 garbage line + 3 valid events. Expect
   reminder fires (count = 5, garbage line skipped).
7. **No heartbeat when gate denies** — no session file at all. Expect the
   gate-deny reminder, NOT the heartbeat reminder, in stdout.
8. **Heartbeat respects opt-out** — opt-out marker present. Expect silent
   stdout (gate's opt-out branch returns before heartbeat logic).

Existing tests must still pass unchanged (heartbeat is purely additive).

## Skill Doc Update

In `skills/elephants-never-forget/SKILL.md`, add a paragraph to the
"When to Update Session Files" section noting the heartbeat:

> A `<system-reminder>` will be injected into your context when 5+ user prompts
> have been submitted since the session file was last touched. This is a soft
> reminder, not a deny — but treat it as a strong signal to update the session
> file before responding.

## Version Bump

Update `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` from
`2.0.1` → `2.1.0`. (`package.json` does not carry a version field — version
lives in the plugin manifests.) Both files must be kept in sync.

Combined release notes:
- (BUG-FIX-AS-FEATURE) Gate now matches per-session via frontmatter
  `session_id`, fixing a per-day enforcement gap.
- (ADD) Heartbeat reminder fires when the session file goes stale (5+ prompts
  without update).

Reasoning for **minor** (not major):
- The gate change tightens enforcement to match what the skill always
  documented in spirit ("session file" was always implicitly per-session). This
  is a bug fix, not a contract break.
- The heartbeat is purely additive (no existing behavior changes; reminder
  doesn't deny).
- No public API removed or renamed (`sessionFileExistsToday` was removed but
  is internal — the only export consumed by tests is updated to
  `sessionFileExistsForSession`).

## Acceptance Criteria

A. `tests/gate.test.js` passes all existing tests plus the 8 new heartbeat
   tests listed above.
B. `node --test tests/*.test.js` reports 0 failures.
C. Manual smoke: a real session that creates its session file and then runs
   5+ user prompts without touching the file sees the heartbeat reminder by
   the 5th prompt.
D. The hot-path measured cost of `gate.js` on UserPromptSubmit stays under
   5ms in the warm-cache case (single jsonl read, single stat, simple
   counting). Cold-cache may be slightly higher; not a target.
E. `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` both at version `2.1.0`.
F. `skills/elephants-never-forget/SKILL.md` has the heartbeat paragraph in
   the "When to Update Session Files" section.

## Open Questions

None. All design questions resolved during brainstorming (Q1–Q4).
