# Port ENE Plugin Runtime to Node.js Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port all 8 Python scripts and 4 test files to Node.js (ESM, stdlib only), preserving v1.1.0 behavior exactly, then update config/docs/version and remove Python.

**Architecture:** Straight 1:1 port. Every `.py` becomes a `.js` with the same name, same CLI, same stdin/stdout contract. ESM via `package.json` `"type": "module"`. No new deps, no build step. Hooks switched from `python` → `node`; undocumented `"async": true` flag dropped.

**Tech Stack:** Node.js 22+ (LTS), `node:fs`, `node:path`, `node:process`, `node:child_process`, `node:url`, `node:os`, `node:crypto`, `node:test`, `node:assert`.

**Source of truth for behavior:** `docs/superpowers/specs/2026-04-21-port-to-node-design.md` — every task below references the relevant section.

**Source of truth for port parity:** existing `scripts/*.py` and `tests/test_*.py` — the Node version must produce the same outputs for the same inputs.

---

## File Structure

**Created files (14):**
- `package.json` — ESM declaration + engines field
- `scripts/transcript_parser.js` — pure library (parse + usage/cost/pacing/pressure)
- `scripts/session_logger.js` — hook script for all logging events
- `scripts/gate.js` — hook script for UserPromptSubmit + PreToolUse
- `scripts/inject_context.js` — SessionStart context injector
- `scripts/pre_compact_warn.js` — PreCompact warning
- `scripts/analytics.js` — CLI metrics engine (imports transcript_parser)
- `scripts/dashboard.js` — HTML dashboard (imports analytics)
- `scripts/generate_test_data.js` — test fixture generator
- `tests/helpers.js` — test builders (session file, opt-out, transcript)
- `tests/transcript_parser.test.js` — 12 unit tests
- `tests/gate.test.js` — 10 subprocess tests
- `tests/analytics_integration.test.js` — 2 subprocess integration tests

**Deleted files:**
- `scripts/*.py` (all 8)
- `tests/*.py` (conftest.py, helpers.py, __init__.py, test_gate.py, test_transcript_parser.py, test_analytics_integration.py)

**Modified files:**
- `hooks/hooks.json` — `python` → `node`, drop `async`
- `README.md` — Requirements: Python 3.8+ → Node.js 22+; dashboard command; native-installer note
- `.claude-plugin/plugin.json` — version 1.1.0 → 2.0.0
- `.claude-plugin/marketplace.json` — version 1.1.0 → 2.0.0

---

## Task 0: Bootstrap — package.json

**Files:**
- Create: `package.json`

- [ ] **Step 0.1: Write `package.json`**

```json
{
  "name": "elephants-never-forget",
  "type": "module",
  "private": true,
  "engines": { "node": ">=22" }
}
```

- [ ] **Step 0.2: Verify Node version available**

Run: `node --version`
Expected: `v22.x.x` or newer. If not, STOP — the plan requires Node 22 LTS.

- [ ] **Step 0.3: Verify node:test works**

Run: `node -e 'import("node:test").then(t => console.log("ok:", typeof t.test))'`
Expected: `ok: function`

- [ ] **Step 0.4: Commit**

```bash
git add package.json
git commit -m "feat: add package.json for Node.js port (v2.0.0 setup)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 1: Port `transcript_parser.js` + tests (TDD)

Pure library. No hook invocation. Safest to port first because everything else depends on it.

**Spec references:** §4.5, §7, §10

**Files:**
- Create: `tests/helpers.js` (partial — just `makeSyntheticTranscript` for now)
- Create: `tests/transcript_parser.test.js`
- Create: `scripts/transcript_parser.js`

- [ ] **Step 1.1: Write `tests/helpers.js` with `makeSyntheticTranscript`**

Port from `tests/helpers.py:43-90`. Full code:

```js
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function makeSyntheticTranscript(path, {
  sessionId,
  numTurns = 5,
  inputTokensPerTurn = 1000,
  outputTokensPerTurn = 500,
  cacheReadTokens = 200,
  cacheCreationTokens = 100,
  model = 'claude-opus-4-7',
  compactionAt = null,
} = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const t0 = new Date(Date.UTC(2026, 3, 17, 10, 0, 0));  // month is 0-indexed (3 = April)
  const lines = [];
  for (let i = 0; i < numTurns; i++) {
    const ts = new Date(t0.getTime() + i * 30_000).toISOString();
    lines.push(JSON.stringify({
      type: 'user', timestamp: ts, sessionId,
      message: { role: 'user', content: `prompt ${i}` },
    }));
    const assistantTs = new Date(t0.getTime() + i * 30_000 + 5_000).toISOString();
    lines.push(JSON.stringify({
      type: 'assistant', timestamp: assistantTs, sessionId,
      message: {
        role: 'assistant', model,
        content: [{ type: 'text', text: `reply ${i}` }],
        usage: {
          input_tokens: inputTokensPerTurn,
          output_tokens: outputTokensPerTurn,
          cache_read_input_tokens: cacheReadTokens,
          cache_creation_input_tokens: cacheCreationTokens,
        },
      },
    }));
    if (compactionAt !== null && i === compactionAt) {
      lines.push(JSON.stringify({
        type: 'system', timestamp: assistantTs, sessionId, subtype: 'compact_boundary',
      }));
    }
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
}
```

- [ ] **Step 1.2: Write `tests/transcript_parser.test.js` (all 12 tests)**

Port from `tests/test_transcript_parser.py`. Full code:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import * as tp from '../scripts/transcript_parser.js';
import { makeSyntheticTranscript } from './helpers.js';

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'enf-tp-'));
  return { dir: d, cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

test('parse_transcript missing file returns empty', () => {
  assert.deepEqual(tp.parseTranscript('/no/such/path.jsonl'), {});
});

test('parse_transcript well formed', () => {
  const { dir, cleanup } = tmp();
  try {
    const path = join(dir, 't.jsonl');
    makeSyntheticTranscript(path, { sessionId: 'sid', numTurns: 3 });
    const r = tp.parseTranscript(path);
    assert.notDeepEqual(r, {});
    assert.equal(r.messages.length, 6);
    assert.equal(r.usage_per_message.length, 3);
    assert.equal(r.model, 'claude-opus-4-7');
  } finally { cleanup(); }
});

test('parse_transcript skips malformed lines', () => {
  const { dir, cleanup } = tmp();
  try {
    const path = join(dir, 't.jsonl');
    writeFileSync(path,
      '{"type": "user", "sessionId": "s", "message": {}}\n' +
      'not-json\n' +
      '{"type": "assistant", "sessionId": "s", "message": {"usage": {"input_tokens": 100, "output_tokens": 50}}}\n'
    );
    const r = tp.parseTranscript(path);
    assert.equal(r.messages.length, 2);
    assert.equal(r.usage_per_message.length, 1);
  } finally { cleanup(); }
});

test('find_transcript_path returns null for unknown', () => {
  const { dir, cleanup } = tmp();
  try {
    assert.equal(tp.findTranscriptPath('nonexistent-session', dir), null);
  } finally { cleanup(); }
});

test('compute_usage_totals basic', () => {
  const { dir, cleanup } = tmp();
  try {
    const path = join(dir, 't.jsonl');
    makeSyntheticTranscript(path, {
      sessionId: 's', numTurns: 3,
      inputTokensPerTurn: 1000, outputTokensPerTurn: 500,
      cacheReadTokens: 200, cacheCreationTokens: 100,
    });
    const t = tp.parseTranscript(path);
    const totals = tp.computeUsageTotals(t);
    assert.equal(totals.input, 3000);
    assert.equal(totals.output, 1500);
    assert.equal(totals.cache_read, 600);
    assert.equal(totals.cache_creation, 300);
    assert.equal(totals.total, 3000 + 1500 + 600 + 300);
    assert.ok(totals.cache_hit_rate > 10 && totals.cache_hit_rate < 20);
  } finally { cleanup(); }
});

test('compute_usage_totals empty', () => {
  assert.deepEqual(tp.computeUsageTotals({}), {
    input: 0, output: 0, cache_read: 0, cache_creation: 0,
    total: 0, cache_hit_rate: 0.0,
  });
});

test('estimate_cost known model', () => {
  const r = tp.estimateCost(
    { input: 1_000_000, output: 1_000_000, cache_read: 0, cache_creation: 0 },
    'claude-opus-4-7'
  );
  assert.ok(r.cost_usd !== null && r.cost_usd > 0);
  assert.equal(r.model, 'claude-opus-4-7');
  assert.equal(r.pricing_version, 'v1');
  assert.ok(r.disclaimer.includes('rates as of'));
});

test('estimate_cost unknown model', () => {
  const r = tp.estimateCost(
    { input: 1000, output: 500, cache_read: 0, cache_creation: 0 },
    'claude-future-x-0'
  );
  assert.equal(r.cost_usd, null);
  assert.ok(r.disclaimer.toLowerCase().includes('unknown model'));
});

test('estimate_cost null model', () => {
  const r = tp.estimateCost({ input: 1000, output: 500, cache_read: 0, cache_creation: 0 }, null);
  assert.equal(r.cost_usd, null);
});

test('compute_pacing basic', () => {
  const { dir, cleanup } = tmp();
  try {
    const path = join(dir, 't.jsonl');
    makeSyntheticTranscript(path, { sessionId: 's', numTurns: 4 });
    const t = tp.parseTranscript(path);
    const p = tp.computePacing(t);
    assert.ok(p.inter_turn_median_ms > 0);
    assert.ok(p.inter_turn_p95_ms >= p.inter_turn_median_ms);
    assert.ok(Array.isArray(p.idle_gaps_sec));
  } finally { cleanup(); }
});

test('compute_pacing empty', () => {
  const p = tp.computePacing({});
  assert.equal(p.inter_turn_median_ms, 0);
  assert.equal(p.inter_turn_p95_ms, 0);
  assert.deepEqual(p.idle_gaps_sec, []);
  assert.deepEqual(p.prompt_to_first_tool_ms, []);
});

test('compute_context_pressure known model', () => {
  const { dir, cleanup } = tmp();
  try {
    const path = join(dir, 't.jsonl');
    makeSyntheticTranscript(path, { sessionId: 's', numTurns: 5, compactionAt: 2 });
    const t = tp.parseTranscript(path);
    const pr = tp.computeContextPressure(t, 'claude-opus-4-7');
    assert.equal(pr.window_tokens, 200_000);
    assert.equal(pr.compaction_count, 1);
    assert.ok(pr.max_utilization_pct !== null);
    assert.ok(pr.max_utilization_pct >= 0 && pr.max_utilization_pct <= 100);
  } finally { cleanup(); }
});

test('compute_context_pressure unknown model', () => {
  const { dir, cleanup } = tmp();
  try {
    const path = join(dir, 't.jsonl');
    makeSyntheticTranscript(path, { sessionId: 's', numTurns: 2 });
    const t = tp.parseTranscript(path);
    const pr = tp.computeContextPressure(t, 'claude-future-x-0');
    assert.equal(pr.window_tokens, null);
    assert.equal(pr.max_utilization_pct, null);
  } finally { cleanup(); }
});
```

- [ ] **Step 1.3: Run tests — verify they fail (script doesn't exist yet)**

Run: `node --test tests/transcript_parser.test.js`
Expected: all tests FAIL with `ERR_MODULE_NOT_FOUND` or similar — `scripts/transcript_parser.js` doesn't exist.

- [ ] **Step 1.4: Implement `scripts/transcript_parser.js`**

Port from `scripts/transcript_parser.py` per spec §4.5 and §7. The file must export (ESM named exports):
- `parseTranscript(path)` — ports `parse_transcript`; returns `{}` on missing/error; reads JSONL line-by-line, skips bad lines
- `findTranscriptPath(sessionId, cwd)` — ports `find_transcript_path`; uses `os.homedir()`; tries encoded-cwd path first (`cwd.replaceAll(sep, '-')`, prepend `-` if not present), then glob via `fs.readdirSync` fallback
- `computeUsageTotals(transcript)` — ports `compute_usage_totals`; returns 6-key dict
- `estimateCost(usage, model)` — ports `estimate_cost`; returns 4-key dict
- `computePacing(transcript)` — ports `compute_pacing`; returns 4-key dict. Use `compact_boundary` subtype matching.
- `computeContextPressure(transcript, model)` — ports `compute_context_pressure`
- `PRICING_TABLE_V1` — frozen object, exact values from spec §7
- `MODEL_WINDOWS` — frozen object, exact values from spec §7
- `PRICING_AS_OF` — string `"2026-01"`

**Model normalization** (`_normalize_model` in Python): lowercase, strip `[...]` suffix, strip trailing 8-digit date segment. Write as a non-exported helper.

**Percentile** (`_percentile` in Python): nearest-rank on sorted array. `idx = Math.min(len-1, Math.round((p/100) * (len-1)))`.

**Timestamp parsing**: accept both `Z` and `+00:00`. Use `new Date(str)` — JS's Date parses both natively. Validate via `Number.isNaN(d.getTime())`.

**Glob fallback for `findTranscriptPath`**: instead of a glob lib, read directory entries manually:
```js
import { readdirSync, existsSync, statSync } from 'node:fs';
// readdirSync(projectsRoot) → iterate → check if entry/sid.jsonl exists
```

**Defensive**: wrap top-level logic in try/catch; return empty struct on any error.

- [ ] **Step 1.5: Run tests — verify they pass**

Run: `node --test tests/transcript_parser.test.js`
Expected: `# pass 13`, `# fail 0`

- [ ] **Step 1.6: Commit**

```bash
git add scripts/transcript_parser.js tests/transcript_parser.test.js tests/helpers.js
git commit -m "feat(port): transcript_parser.js with full test suite

Pure library: parse/usage/cost/pacing/pressure. Stdlib only. Ports
scripts/transcript_parser.py behavior-for-behavior. 12/12 tests pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Port `gate.js` + tests (TDD)

**Spec references:** §4.3, §6.2, §6.4

**Files:**
- Modify: `tests/helpers.js` (append `makeSessionFile`, `makeOptOutMarker`, `makeActiveMarker`, `setupProjectDir`)
- Create: `tests/gate.test.js`
- Create: `scripts/gate.js`

- [ ] **Step 2.1: Extend `tests/helpers.js` with fixture factories**

Append to `tests/helpers.js`:

```js
import { mkdirSync, writeFileSync, closeSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

export function setupProjectDir() {
  const projectDir = mkdtempSync(join(tmpdir(), 'enf-test-'));
  const sessionsDir = join(projectDir, '.claude-sessions');
  for (const sub of ['sessions', 'raw', '.opt-out', '.active']) {
    mkdirSync(join(sessionsDir, sub), { recursive: true });
  }
  return {
    projectDir, sessionsDir,
    cleanup: () => rmSync(projectDir, { recursive: true, force: true }),
  };
}

export function makeSessionFile(sessionsDir, dateStr, slug, {
  sessionId = 'a1b2c3d4', tags = ['test'], status = 'completed',
} = {}) {
  const content =
    `---\n` +
    `session_id: ${sessionId}\n` +
    `date: ${dateStr}\n` +
    `start_time: "10:00"\n` +
    `tags: [${tags.join(', ')}]\n` +
    `status: ${status}\n` +
    `summary: "Test session"\n` +
    `---\n\n## Intent\nTest intent.\n`;
  const path = join(sessionsDir, 'sessions', `${dateStr}-${slug}.md`);
  writeFileSync(path, content, 'utf8');
  return path;
}

export function makeOptOutMarker(sessionsDir, sessionId) {
  const path = join(sessionsDir, '.opt-out', sessionId);
  mkdirSync(dirname(path), { recursive: true });
  closeSync(openSync(path, 'w'));
  return path;
}

export function makeActiveMarker(sessionsDir, sessionId) {
  const path = join(sessionsDir, '.active', sessionId);
  mkdirSync(dirname(path), { recursive: true });
  closeSync(openSync(path, 'w'));
  return path;
}
```

(Add the necessary imports at the top of the file if not already present.)

- [ ] **Step 2.2: Write `tests/gate.test.js` (all 10 tests)**

Full code:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { setupProjectDir, makeSessionFile, makeOptOutMarker } from './helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, '..', 'scripts', 'gate.js');

function runGate(stdinPayload, projectDir, envExtra = {}) {
  return spawnSync('node', [SCRIPT], {
    input: JSON.stringify(stdinPayload),
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, ...envExtra },
    timeout: 5000, encoding: 'utf8',
  });
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

test('helpers importable', async () => {
  const mod = await import('../scripts/gate.js');
  assert.equal(typeof mod.sessionFileExistsToday, 'function');
  assert.equal(typeof mod.optOutMarkerExists, 'function');
  assert.equal(typeof mod.sanitizeSessionId, 'function');
});

test('UserPromptSubmit silent when session file exists', () => {
  const { projectDir, sessionsDir, cleanup } = setupProjectDir();
  try {
    makeSessionFile(sessionsDir, today(), 'foo', { sessionId: 's1' });
    const r = runGate({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'hi' }, projectDir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally { cleanup(); }
});

test('UserPromptSubmit silent when opt-out', () => {
  const { projectDir, sessionsDir, cleanup } = setupProjectDir();
  try {
    makeOptOutMarker(sessionsDir, 's1');
    const r = runGate({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'hi' }, projectDir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally { cleanup(); }
});

test('UserPromptSubmit injects reminder when no session file', () => {
  const { projectDir, cleanup } = setupProjectDir();
  try {
    const r = runGate({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'hi' }, projectDir);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('<system-reminder>'));
    assert.ok(r.stdout.includes('.claude-sessions/sessions/'));
    assert.ok(r.stdout.includes('</system-reminder>'));
  } finally { cleanup(); }
});

test('PreToolUse allows when session file exists', () => {
  const { projectDir, sessionsDir, cleanup } = setupProjectDir();
  try {
    makeSessionFile(sessionsDir, today(), 'foo', { sessionId: 's1' });
    const r = runGate({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Read', tool_input: { file_path: '/tmp/foo.txt' } }, projectDir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally { cleanup(); }
});

test('PreToolUse allows opt-out', () => {
  const { projectDir, sessionsDir, cleanup } = setupProjectDir();
  try {
    makeOptOutMarker(sessionsDir, 's1');
    const r = runGate({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Read', tool_input: { file_path: '/tmp/foo.txt' } }, projectDir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally { cleanup(); }
});

test('PreToolUse allows write to sessions dir', () => {
  const { projectDir, sessionsDir, cleanup } = setupProjectDir();
  try {
    const target = join(sessionsDir, 'sessions', `${today()}-foo.md`);
    const r = runGate({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Write', tool_input: { file_path: target } }, projectDir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally { cleanup(); }
});

test('PreToolUse allows write to opt-out dir', () => {
  const { projectDir, sessionsDir, cleanup } = setupProjectDir();
  try {
    const target = join(sessionsDir, '.opt-out', 's1');
    const r = runGate({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Write', tool_input: { file_path: target } }, projectDir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally { cleanup(); }
});

test('PreToolUse denies Read when no session file', () => {
  const { projectDir, cleanup } = setupProjectDir();
  try {
    const r = runGate({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Read', tool_input: { file_path: '/tmp/foo.txt' } }, projectDir);
    assert.equal(r.status, 0);
    const payload = JSON.parse(r.stdout.trim());
    assert.equal(payload.decision, 'deny');
    assert.ok(payload.reason.toLowerCase().includes('session'));
  } finally { cleanup(); }
});

test('PreToolUse denies Bash when no session file', () => {
  const { projectDir, cleanup } = setupProjectDir();
  try {
    const r = runGate({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'echo hi' } }, projectDir);
    assert.equal(r.status, 0);
    const payload = JSON.parse(r.stdout.trim());
    assert.equal(payload.decision, 'deny');
  } finally { cleanup(); }
});

test('malformed stdin fails open', () => {
  const { projectDir, cleanup } = setupProjectDir();
  try {
    const r = spawnSync('node', [SCRIPT], {
      input: 'not json at all',
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      timeout: 5000, encoding: 'utf8',
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally { cleanup(); }
});
```

- [ ] **Step 2.3: Run tests — verify they fail**

Run: `node --test tests/gate.test.js`
Expected: all 11 tests FAIL — `scripts/gate.js` doesn't exist yet.

- [ ] **Step 2.4: Implement `scripts/gate.js`**

Port from `scripts/gate.py` per spec §4.3. Export (ESM) the three helpers referenced by the "helpers importable" test: `sessionFileExistsToday(sessionsDir)`, `optOutMarkerExists(sessionId, sessionsDir)`, `sanitizeSessionId(sid)`.

**Exact reminder template text and deny reason template text** must be ported from `scripts/gate.py:61-81` and `scripts/gate.py:96-101` verbatim (convert Python `.format()` to JS template literals).

**Hot path structure:**
```js
async function main() {
  const raw = await readStdin();  // collect chunks from process.stdin
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }
  const event = input.hook_event_name || '';
  const sessionsDir = getSessionsDir();  // same as session_logger
  try {
    if (event === 'UserPromptSubmit') handleUserPromptSubmit(input, sessionsDir);
    else if (event === 'PreToolUse') handlePreToolUse(input, sessionsDir);
  } catch { /* swallow */ }
  process.exit(0);
}
```

**`readStdin`** helper (reusable across hook scripts):
```js
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}
```

**`sessionFileExistsToday`**: glob replacement via `readdirSync(sessionsSub).some(f => f.startsWith(\`${today}-\`) && f.endsWith('.md'))`; catch ENOENT → return false.

**`_isWriteUnder`**: compute `path.resolve(fp)` and `path.resolve(prefix)`, check `abs === prefixAbs || abs.startsWith(prefixAbs + path.sep)`.

Use the isMain idiom from spec §3.4 to call `main()` only when run directly.

- [ ] **Step 2.5: Run tests — verify they pass**

Run: `node --test tests/gate.test.js`
Expected: `# pass 11`, `# fail 0`

- [ ] **Step 2.6: Commit**

```bash
git add scripts/gate.js tests/gate.test.js tests/helpers.js
git commit -m "feat(port): gate.js with full test suite

Hard-gate for UserPromptSubmit + PreToolUse. Ports scripts/gate.py.
11/11 subprocess tests pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Port `session_logger.js`

**Spec references:** §4.1

**Files:**
- Create: `scripts/session_logger.js`

No dedicated test file — verified by observing JSONL output during manual runs.

- [ ] **Step 3.1: Implement `scripts/session_logger.js`**

Port from `scripts/session_logger.py` per spec §4.1. Duplicate the `readStdin` helper (about 10 lines) from gate.js rather than extracting to a shared module — each hook script stays self-contained per the lightweight-plugin principle.

**Event handler table** (map hook event names to handler functions). Include the exact JSONL entry shapes from spec §4.1 table and the exact `log.md` line formats.

**Tool summary logic** exactly as in spec §4.1:
- Edit/Write/MultiEdit → `Modified <basename(file_path)>`
- Read → `Read <basename(file_path)>`
- Bash → `Ran: <command>` (command cap 200)
- Grep/Glob → `Searched: <pattern>`
- else → `Used <tool_name>`

**Caps:** prompt → 2000 chars before logging; input_preview → 500 chars; response_preview → 500 chars. Python uses `json.dumps` for input_preview then slices — match by `JSON.stringify(toolInput).slice(0, 500)`.

**Timestamps**: `new Date().toISOString()` for JSONL; for log.md use local-time zero-padded `YYYY-MM-DD HH:MM` (SessionStart) or just `HH:MM` (UserPromptSubmit, SessionEnd).

Top-level try/catch → `process.exit(0)` on any error.

- [ ] **Step 3.2: Manual verification — SessionStart event**

Run:
```bash
mkdir -p /tmp/enf-sl-test
echo '{"hook_event_name":"SessionStart","session_id":"test12345","session_start_source":"startup","cwd":"/tmp"}' | CLAUDE_PROJECT_DIR=/tmp/enf-sl-test node scripts/session_logger.js
cat /tmp/enf-sl-test/.claude-sessions/raw/test12345.jsonl
cat /tmp/enf-sl-test/.claude-sessions/log.md
```
Expected: one JSONL line with `event: "session_start"`, and one markdown line `- [YYYY-MM-DD HH:MM] SESSION test1234 started (startup)`.

- [ ] **Step 3.3: Manual verification — PostToolUse event**

Run:
```bash
echo '{"hook_event_name":"PostToolUse","session_id":"test12345","tool_name":"Edit","tool_input":{"file_path":"/tmp/foo.ts"},"tool_response":""}' | CLAUDE_PROJECT_DIR=/tmp/enf-sl-test node scripts/session_logger.js
tail -1 /tmp/enf-sl-test/.claude-sessions/raw/test12345.jsonl
```
Expected: JSONL line with `event: "tool_use"`, `summary: "Modified foo.ts"`.

- [ ] **Step 3.4: Clean up test dir and commit**

```bash
rm -rf /tmp/enf-sl-test
git add scripts/session_logger.js
git commit -m "feat(port): session_logger.js

Mechanical JSONL + log.md logger for 5 hook events. Ports
scripts/session_logger.py. Manual verification confirms JSONL schema
and log.md formatting match v1.1.0.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Port `inject_context.js`

**Spec references:** §4.2

**Files:**
- Create: `scripts/inject_context.js`

- [ ] **Step 4.1: Implement `scripts/inject_context.js`**

Port from `scripts/inject_context.py` per spec §4.2.

Key details:
- `readFileSafe(path, maxChars)`: read synchronously, truncate at last `\n` before maxChars, append `\n... (truncated — read full file for more)` if truncated. On ENOENT/EACCES return empty string.
- `getRecentSessions(sessionsDir, maxFiles=3, maxCharsEach=2700)`: `readdirSync(join(sessionsDir, 'sessions'))`, filter `.md`, sort descending, take first N, return array of `\`### ${filename}\n${content}\``.
- If `index` + `decisions` + `recent` all empty → exit 0 with no output.
- Otherwise print the exact block structure from the Python version (header line, `## Session Index`, etc.) to stdout, followed by `---` and the instruction line.

- [ ] **Step 4.2: Manual verification**

Run:
```bash
mkdir -p /tmp/enf-ic-test/.claude-sessions/sessions
echo "# Session Index" > /tmp/enf-ic-test/.claude-sessions/index.md
echo "# Standing Decisions" > /tmp/enf-ic-test/.claude-sessions/decisions.md
echo '{"session_id":"abcd1234"}' | CLAUDE_PROJECT_DIR=/tmp/enf-ic-test node scripts/inject_context.js
```
Expected: stdout contains `=== ELEPHANTS NEVER FORGET` and the index/decisions contents.

- [ ] **Step 4.3: Clean up and commit**

```bash
rm -rf /tmp/enf-ic-test
git add scripts/inject_context.js
git commit -m "feat(port): inject_context.js

SessionStart context injector. Ports scripts/inject_context.py.
Reads index/decisions/recent sessions, emits to stdout.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Port `pre_compact_warn.js`

**Spec references:** §4.4

**Files:**
- Create: `scripts/pre_compact_warn.js`

- [ ] **Step 5.1: Implement `scripts/pre_compact_warn.js`**

Port from `scripts/pre_compact_warn.py` per spec §4.4. Sequence:
1. Read stdin JSON, sanitize sessionId
2. Append `pre_compact` entry to `raw/<sid>.jsonl`
3. Append `- [HH:MM] COMPACT: Context compaction triggered for <sid-prefix>\n` to `log.md`
4. Print 4 lines to stdout:
   ```
   ELEPHANTS NEVER FORGET: Context compaction is about to occur.
   Session: <sid-prefix>
   ACTION REQUIRED: Update your session file NOW before context is lost.
   File: .claude-sessions/sessions/ (find today's session file)
   ```
5. try/catch → exit 0

- [ ] **Step 5.2: Manual verification**

```bash
mkdir -p /tmp/enf-pc-test
echo '{"session_id":"test12345"}' | CLAUDE_PROJECT_DIR=/tmp/enf-pc-test node scripts/pre_compact_warn.js
cat /tmp/enf-pc-test/.claude-sessions/raw/test12345.jsonl
cat /tmp/enf-pc-test/.claude-sessions/log.md
```
Expected: JSONL entry with `event: "pre_compact"`, log.md `COMPACT:` line, stdout shows the 4 warning lines.

- [ ] **Step 5.3: Clean up and commit**

```bash
rm -rf /tmp/enf-pc-test
git add scripts/pre_compact_warn.js
git commit -m "feat(port): pre_compact_warn.js

PreCompact warning script. Ports scripts/pre_compact_warn.py.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Port `analytics.js` + integration tests (TDD)

**Spec references:** §4.6

**Files:**
- Create: `tests/analytics_integration.test.js`
- Create: `scripts/analytics.js`

- [ ] **Step 6.1: Write `tests/analytics_integration.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { setupProjectDir, makeSessionFile, makeSyntheticTranscript } from './helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, '..', 'scripts', 'analytics.js');

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function runAnalytics(projectDir, fmt = 'json', envExtra = {}) {
  return spawnSync('node', [SCRIPT, '--project-dir', projectDir, '--format', fmt], {
    env: { ...process.env, ...envExtra },
    timeout: 20_000, encoding: 'utf8',
  });
}

test('analytics handles no transcripts', () => {
  const { projectDir, sessionsDir, cleanup } = setupProjectDir();
  try {
    makeSessionFile(sessionsDir, today(), 'foo', { sessionId: 's1' });
    const r = runAnalytics(projectDir, 'json');
    assert.equal(r.status, 0);
    const data = JSON.parse(r.stdout);
    assert.equal(data.summary.total_sessions, 1);
    assert.ok(!('tokens' in data) || Object.keys(data.tokens).length === 0);
  } finally { cleanup(); }
});

test('analytics merges transcript data when present', () => {
  const { projectDir, sessionsDir, cleanup } = setupProjectDir();
  const { projectDir: fakeHome, cleanup: cleanupHome } = setupProjectDir();
  try {
    const projectsDir = join(fakeHome, '.claude', 'projects', '-fake-cwd');
    mkdirSync(projectsDir, { recursive: true });
    const transcriptPath = join(projectsDir, 's1.jsonl');
    makeSyntheticTranscript(transcriptPath, { sessionId: 's1', numTurns: 3, model: 'claude-opus-4-7' });
    makeSessionFile(sessionsDir, today(), 'foo', { sessionId: 's1' });
    const r = runAnalytics(projectDir, 'json', { HOME: fakeHome });
    assert.equal(r.status, 0);
    const data = JSON.parse(r.stdout);
    assert.ok('tokens' in data);
    assert.ok(data.tokens.s1 && data.tokens.s1.total > 0);
  } finally {
    cleanup();
    cleanupHome();
  }
});
```

- [ ] **Step 6.2: Run tests — verify they fail**

Run: `node --test tests/analytics_integration.test.js`
Expected: both tests FAIL — `scripts/analytics.js` doesn't exist.

- [ ] **Step 6.3: Implement `scripts/analytics.js` — chart helpers + pct**

Create `scripts/analytics.js` starting with the small utilities (port from analytics.py:31-59):

```js
const SPARK_CHARS = '▁▂▃▄▅▆▇█';
const BLOCK_FULL = '█';
const BLOCK_EMPTY = '░';

export function sparkline(values) {
  if (!values || !values.length) return '';
  const mn = Math.min(...values), mx = Math.max(...values);
  const rng = (mx - mn) || 1;
  return values.map(v => SPARK_CHARS[Math.min(7, Math.floor((v - mn) / rng * 7))]).join('');
}

export function bar(value, maxValue, width = 16) {
  if (maxValue === 0) return BLOCK_EMPTY.repeat(width);
  const filled = Math.floor(value / maxValue * width);
  return BLOCK_FULL.repeat(filled) + BLOCK_EMPTY.repeat(width - filled);
}

export function pct(n, d) {
  if (d === 0) return 0.0;
  return Math.round(n / d * 100 * 10) / 10;  // 1 decimal
}
```

- [ ] **Step 6.4: Implement frontmatter + file parsers**

Port from analytics.py:64-190. Add to the same file:
- `parseFrontmatter(content) → [fm, body]` — simple YAML-lite parser: split on first `---\n`, then `---`; each line with `:` becomes key/value; values matching `[a, b, c]` become array (split on `,`, trim quotes)
- `parseSessionFile(filepath)` — reads file, calls parseFrontmatter, walks body collecting decisions, reversals, errors, friction events, files touched, open items
- `parseDecisionsFile(filepath)` — parses Y-statements with topic sections, tracks superseded (`~~...~~ SUPERSEDED`), confidence level
- `parseRawJsonl(filepath)` — line-by-line JSON, skip malformed

- [ ] **Step 6.5: Implement `computeMetrics`**

Port from analytics.py:195-412. Long function. Key structure:
1. Glob + parse session files
2. Parse decisions.md
3. Parse all raw JSONL files
4. Compute basic counts (sessions, decisions, reversals, errors, friction, files)
5. Compute tag counter
6. Compute open items completion
7. Compute confidence distribution
8. Compute decision stability (>7 days old)
9. Compute sessions_by_date, sessions_by_day_of_week
10. Compute tool_counts, prompt_counts_per_session
11. Compute session_durations
12. Compute error recurrence (regex extract backtick-quoted from error strings)
13. Compute friction_types
14. Compute reversal rate per topic
15. Assemble metrics dict with sections: summary, planning, clarity, efficiency, patterns, trends
16. v1.1.0: iterate sessions, call `transcript_parser.findTranscriptPath`, `parseTranscript`, fill tokens/cost/pacing/pressure buckets

Use `import { findTranscriptPath, parseTranscript, computeUsageTotals, estimateCost, computePacing, computeContextPressure } from './transcript_parser.js'`.

Counter replacements: use plain `Map` or object, with manual `.sort((a,b) => b[1]-a[1])` for `.most_common()`.

- [ ] **Step 6.6: Implement `formatMarkdown` + `generateInsights`**

Port from analytics.py:417-704. Match exact section headers, table formats, and bar/sparkline placements. Insight thresholds must match Python exactly (reversal rate > 25, friction > 2/session, completion < 70%, open > 10, focus < 50%).

- [ ] **Step 6.7: Implement CLI `main`**

Port from analytics.py:714-735. Argument parsing (manual — don't add a lib): iterate `process.argv.slice(2)`, handle `--project-dir` and `--format` (values default to `CLAUDE_PROJECT_DIR`/`cwd()` and `markdown`). If `sessionsDir` doesn't exist, `console.error('No .claude-sessions/ ...')` and `process.exit(1)`. Otherwise print `formatMarkdown(metrics)` or `JSON.stringify(metrics, null, 2)`.

Use isMain idiom from spec §3.4.

- [ ] **Step 6.8: Run integration tests — verify they pass**

Run: `node --test tests/analytics_integration.test.js`
Expected: `# pass 2`, `# fail 0`

- [ ] **Step 6.9: Run full test suite — verify nothing regressed**

Run: `node --test tests/*.test.js`
Expected: `# pass 26`, `# fail 0` (11 gate + 13 transcript_parser + 2 analytics_integration)

- [ ] **Step 6.10: Commit**

```bash
git add scripts/analytics.js tests/analytics_integration.test.js
git commit -m "feat(port): analytics.js with integration tests

Metrics engine. Ports scripts/analytics.py behavior-for-behavior:
parsing, counters, insights, markdown + JSON formatting, v1.1.0
transcript-derived token/cost/pacing/pressure metrics. 2/2 integration
tests pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Port `dashboard.js`

**Spec references:** §4.7

**Files:**
- Create: `scripts/dashboard.js`

- [ ] **Step 7.1: Implement `scripts/dashboard.js`**

Port from `scripts/dashboard.py` per spec §4.7.

- Import `computeMetrics`, `generateInsights`, `pct` from `./analytics.js`
- Convert Python HTML_TEMPLATE (dashboard.py:26-325) to a JS template literal. Python `{{` / `}}` escapes become `{` / `}`; Python `{var}` placeholders become `${var}`. The inline JS inside the HTML (Chart.js setup) already uses `{}` — those stay as literal `{}` in the output template.
- Helper functions `colorForValue` and `inverseColor` — port verbatim
- `generateHtml(metrics)` — port verbatim. All the JSON.stringify-ed data goes into the template.
- `main()` — CLI with `--project-dir`, `--output`, `--no-open`. Write file. Unless `--no-open`:
  - Determine platform via `process.platform`: `'darwin'` → `open`, `'linux'` → `xdg-open`, `'win32'` → use `cmd /c start "" <url>`
  - Compute `const fileUrl = pathToFileURL(resolve(outputPath)).href`
  - `spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()` so the browser launch doesn't block node exit

- [ ] **Step 7.2: Manual verification**

Run:
```bash
node scripts/generate_test_data.js 2>/dev/null || true  # may not be ported yet; that's OK, use existing .claude-sessions/
node scripts/dashboard.js --project-dir . --output /tmp/enf-dashboard-test.html --no-open
ls -la /tmp/enf-dashboard-test.html
grep -c "chart.js" /tmp/enf-dashboard-test.html
grep -c "chartTokensByType" /tmp/enf-dashboard-test.html
```
Expected: file exists, contains Chart.js CDN link, contains v1.1.0 chart ids. Open in browser manually to verify rendering.

- [ ] **Step 7.3: Commit**

```bash
git add scripts/dashboard.js
git commit -m "feat(port): dashboard.js

HTML dashboard generator with Chart.js via CDN. Ports
scripts/dashboard.py. Platform-appropriate browser open
(open/xdg-open/start).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Port `generate_test_data.js`

**Spec references:** §4.8

**Files:**
- Create: `scripts/generate_test_data.js`

- [ ] **Step 8.1: Implement `scripts/generate_test_data.js`**

Port from `scripts/generate_test_data.py`. Produces the 8 canned sessions at `/tmp/enf-analytics-test/.claude-sessions/` with matching `decisions.md`, `index.md`, `topics.md`, per-session raw JSONL, and `log.md`.

**Deterministic randomness for tool-name selection** (replaces Python's `hash()`): use MD5 over the seed string, take first 4 bytes as uint32, mod 5. This is deterministic and cross-platform.

```js
import { createHash } from 'node:crypto';
function deterministicIndex(seed, mod) {
  const h = createHash('md5').update(seed).digest();
  return h.readUInt32LE(0) % mod;
}
```

Also export `generateSyntheticTranscript(path, options)` — can simply re-export `makeSyntheticTranscript` from `tests/helpers.js` OR implement inline (spec §4.8 suggests inline to keep `scripts/` and `tests/` decoupled; duplicate the ~30 lines).

- [ ] **Step 8.2: Manual verification**

```bash
rm -rf /tmp/enf-analytics-test
node scripts/generate_test_data.js
ls /tmp/enf-analytics-test/.claude-sessions/
ls /tmp/enf-analytics-test/.claude-sessions/sessions/
wc -l /tmp/enf-analytics-test/.claude-sessions/raw/*.jsonl
```
Expected: 8 session markdown files, 8 raw JSONL files, decisions.md + index.md + topics.md + log.md at top level.

- [ ] **Step 8.3: End-to-end verification — run analytics on generated data**

```bash
node scripts/analytics.js --project-dir /tmp/enf-analytics-test --format markdown | head -40
```
Expected: markdown output with `## Session Analytics Dashboard`, `### Overview`, `Sessions | 8 (...)`, reversal rate and friction stats.

- [ ] **Step 8.4: Commit**

```bash
git add scripts/generate_test_data.js
git commit -m "feat(port): generate_test_data.js

Canned test fixture generator. Ports scripts/generate_test_data.py
including generate_synthetic_transcript helper. Deterministic MD5-based
randomness replaces Python hash().

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Switch hooks to Node + drop async flag

**Spec references:** §5

**Files:**
- Modify: `hooks/hooks.json`

- [ ] **Step 9.1: Rewrite `hooks/hooks.json`**

Read current file, then write:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/session_logger.js\"", "timeout": 10 },
          { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/inject_context.js\"", "timeout": 10 }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/session_logger.js\"", "timeout": 10 },
          { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/gate.js\"", "timeout": 5 }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/gate.js\"", "timeout": 5 }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/session_logger.js\"", "timeout": 10 }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/session_logger.js\"", "timeout": 10 }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/pre_compact_warn.js\"", "timeout": 10 }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/session_logger.js\"", "timeout": 10 }
        ]
      }
    ]
  }
}
```

Changes from v1.1.0: every `python` → `node`; every `.py` → `.js`; `"async": true` fields removed entirely.

- [ ] **Step 9.2: Validate JSON**

Run: `node -e 'JSON.parse(require("fs").readFileSync("hooks/hooks.json", "utf8")); console.log("ok")'`
Expected: `ok`

- [ ] **Step 9.3: Commit**

```bash
git add hooks/hooks.json
git commit -m "feat(port): switch hooks to node; drop undocumented async flag

python → node in every command. .py → .js. Removed \"async\": true
fields (undocumented in current Claude Code hooks reference; sync
execution is already well within timeout budget).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Delete Python files

**Spec references:** §3.1

- [ ] **Step 10.1: Delete all Python sources and tests**

```bash
git rm scripts/analytics.py
git rm scripts/dashboard.py
git rm scripts/gate.py
git rm scripts/generate_test_data.py
git rm scripts/inject_context.py
git rm scripts/pre_compact_warn.py
git rm scripts/session_logger.py
git rm scripts/transcript_parser.py
git rm tests/conftest.py
git rm tests/helpers.py
git rm tests/__init__.py
git rm tests/test_gate.py
git rm tests/test_transcript_parser.py
git rm tests/test_analytics_integration.py
```

- [ ] **Step 10.2: Verify no stragglers**

Run: `find scripts tests -name "*.py" -o -name "__pycache__" -o -name ".pytest_cache"`
Expected: empty output.

- [ ] **Step 10.3: Run full test suite — still passes**

Run: `node --test tests/*.test.js`
Expected: `# pass 26`, `# fail 0`

- [ ] **Step 10.4: Commit**

```bash
git commit -m "chore(port): delete Python sources and tests (v2.0.0 cutover)

All Python scripts replaced by Node.js equivalents in preceding
commits. pytest test suite replaced by node:test suite (26 tests).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Update README

**Spec references:** §8

**Files:**
- Modify: `README.md` — Requirements section + dashboard command

- [ ] **Step 11.1: Find current Requirements section**

Run: `grep -n "Python 3.8" README.md` and note the line numbers of the `Python 3.8+` line and any nearby context.

- [ ] **Step 11.2: Replace Requirements**

Old:
```
- Python 3.8+
- Claude Code CLI
```

New:
```
- Node.js 22+ (LTS)
- Claude Code CLI

> **Note:** If you installed Claude Code via the native installer (macOS installer or `curl`), you may need to install Node.js separately. If you installed via `npm install -g @anthropic-ai/claude-code`, Node is already present. Node 22 is the current Active LTS.
```

- [ ] **Step 11.3: Replace dashboard command example**

Old (find via `grep -n "python scripts/dashboard" README.md`):
```
python scripts/dashboard.py --project-dir .
```

New:
```
node scripts/dashboard.js --project-dir .
```

- [ ] **Step 11.4: Commit**

```bash
git add README.md
git commit -m "docs: README requirements and commands for v2.0.0

Python 3.8+ → Node.js 22+. Add note about Claude Code native installer
not bundling Node. Update dashboard command example.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Version bump + final verification

**Spec references:** §9, §12

**Files:**
- Modify: `.claude-plugin/plugin.json` — version 1.1.0 → 2.0.0
- Modify: `.claude-plugin/marketplace.json` — version 1.1.0 → 2.0.0

- [ ] **Step 12.1: Bump `.claude-plugin/plugin.json` version**

Find the `"version": "1.1.0"` line and change to `"version": "2.0.0"`.

- [ ] **Step 12.2: Bump `.claude-plugin/marketplace.json` version**

Find the matching `elephants-never-forget` entry and change `"version": "1.1.0"` to `"version": "2.0.0"`.

- [ ] **Step 12.3: Run full acceptance test sequence**

Run each in order; expect each to succeed:
```bash
# AC1: node test suite
node --test tests/*.test.js
# AC5: package.json check
node -e 'const p=JSON.parse(require("fs").readFileSync("package.json","utf8")); if(p.type!=="module"||!p.engines?.node?.includes("22")){process.exit(1)}; console.log("ok")'
# AC2: no Python
test -z "$(find scripts tests -name '*.py' 2>/dev/null)" && echo "ok (no python)" || (echo "FAIL: .py found" && exit 1)
# AC3: hooks.json
! grep -q 'python' hooks/hooks.json && echo "ok (no python in hooks)" || (echo "FAIL: python still in hooks" && exit 1)
! grep -q 'async' hooks/hooks.json && echo "ok (no async in hooks)" || (echo "FAIL: async still in hooks" && exit 1)
[ "$(grep -c '"command": "node' hooks/hooks.json)" = "9" ] && echo "ok (9 node commands)" || echo "note: node command count differs from 9 expected; inspect manually"
# AC4: version
grep -q '"2.0.0"' .claude-plugin/plugin.json && echo "ok (plugin.json at 2.0.0)" || exit 1
grep -q '"2.0.0"' .claude-plugin/marketplace.json && echo "ok (marketplace.json at 2.0.0)" || exit 1
```

- [ ] **Step 12.4: Run dashboard end-to-end smoke test**

```bash
rm -rf /tmp/enf-analytics-test
node scripts/generate_test_data.js
node scripts/dashboard.js --project-dir /tmp/enf-analytics-test --output /tmp/enf-dashboard.html --no-open
test -s /tmp/enf-dashboard.html && echo "ok (dashboard generated)"
grep -q "chartTokensByType" /tmp/enf-dashboard.html && echo "ok (v1.1.0 charts present)"
rm -rf /tmp/enf-analytics-test /tmp/enf-dashboard.html
```

- [ ] **Step 12.5: Gate fail-open smoke test**

```bash
echo 'not json' | CLAUDE_PROJECT_DIR=/tmp node scripts/gate.js
echo "exit=$?"
```
Expected: `exit=0`, no stdout.

- [ ] **Step 12.6: Commit version bump**

```bash
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore: bump version to 2.0.0 (Node.js port)

Runtime ported from Python to Node.js. Requires Node 22+. Same
feature set, same .claude-sessions/ schema. See
docs/superpowers/specs/2026-04-21-port-to-node-design.md for design
rationale.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 12.7: View final git log**

Run: `git log --oneline -15`
Expected: see the commits from Tasks 0–12 in order above `092aeb0` (the spec commit).

---

## Out of Scope for this Plan

- Pushing to origin/main (user's call, not an implementation step)
- Adopting new hook events (SubagentStart, PostCompact, etc.)
- Any skill markdown edits (already done in v1.1.0)
- Analytics metric additions or dashboard redesign
