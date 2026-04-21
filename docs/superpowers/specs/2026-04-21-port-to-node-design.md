# Port ENE plugin runtime from Python to Node.js (v2.0.0)

**Status:** Approved for implementation
**Date:** 2026-04-21
**Previous spec:** `2026-04-17-improve-enf-plugin-design.md` (v1.1.0 — enforcement + analytics)

## 1. Context

The v1.1.0 plugin runtime is seven Python scripts invoked from `hooks/hooks.json`. Python is not bundled with Claude Code's native installer, so users who installed via the native path and don't otherwise have Python ≥ 3.8 get a silently-broken plugin. Node is also not bundled with the native installer, but Node is (a) far more widely installed on developer machines, (b) always present when Claude Code itself was installed via `npm install -g @anthropic-ai/claude-code`, and (c) the ecosystem Claude Code itself uses, making it a more natural dependency.

This spec covers a behavior-preserving 1:1 port to Node.js, delivered as **v2.0.0** (clean break; no Python fallback).

### Why now
Node 20 reaches EOL on **2026-04-30**, so any Node floor we ship must be **Node 22 LTS** (supported until 2027-04-30). `node:test` stabilized in Node 20, so the runner is fully available.

## 2. Non-goals

- No changes to `.claude-sessions/` data formats, filenames, or layout
- No changes to skill markdown content (`skills/**/*.md`)
- No new features, new metrics, or new hook events
- No Python fallback, migration layer, or polyglot "try both" logic
- No new runtime dependencies (stdlib only, no `node_modules/`)
- No adoption of newly-available hook events (`SubagentStart`, `PostCompact`, `PermissionDenied`, etc.) — out of scope; future work

## 3. Architecture

Straight 1:1 port. Same file topology. Every Python script becomes a Node ESM module with the same name, same CLI, same stdin/stdout contract, same side effects on disk.

### 3.1 File topology (after port)

```
.claude-plugin/
  plugin.json              # version: 2.0.0
  marketplace.json         # version: 2.0.0
hooks/
  hooks.json               # python → node; async flag removed
scripts/
  analytics.js
  dashboard.js
  gate.js
  generate_test_data.js
  inject_context.js
  pre_compact_warn.js
  session_logger.js
  transcript_parser.js
tests/
  analytics_integration.test.js
  gate.test.js
  transcript_parser.test.js
  helpers.js               # no .test.js suffix — library, not a test
package.json               # new; minimal
skills/                    # UNCHANGED — language-agnostic markdown
docs/                      # UNCHANGED
README.md                  # update Requirements + install guidance
```

No `tests/conftest.py` equivalent (Node has no pytest-style fixture injection). No `tests/__init__.py` equivalent (not needed in ESM).

### 3.2 Runtime requirement

- **Node.js ≥ 22 LTS**
- Stdlib only: `node:fs`, `node:path`, `node:process`, `node:child_process`, `node:url`, `node:os`, `node:crypto`, `node:test`, `node:assert`
- No transitive deps, no lockfile, no build step

### 3.3 package.json

Minimal. Lives at repo root.

```json
{
  "name": "elephants-never-forget",
  "type": "module",
  "private": true,
  "engines": { "node": ">=22" }
}
```

No `dependencies`, no `devDependencies`, no `scripts`. Tests run via `node --test tests/`.

### 3.4 Module conventions

- ESM `import` / `export` throughout
- CLI scripts detect direct invocation via the idiom:
  ```js
  import { fileURLToPath } from 'node:url';
  import { realpathSync } from 'node:fs';

  const isMain = () => {
    try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
    catch { return false; }
  };

  if (isMain()) main();
  ```
  `realpathSync` on argv[1] handles relative paths and symlinks, avoiding false negatives when the hook invokes an absolute path. This lets the same file be imported as a library (dashboard.js importing analytics.js) or executed as a CLI.
- JSON: `JSON.parse(fs.readFileSync(p, 'utf8'))` and `JSON.stringify(x, null, 2)`
- Paths: always `path.join()`, never string concat
- Timestamps in JSONL: `new Date().toISOString()` (UTC, matches Python `datetime.now(timezone.utc).isoformat()`)
- Dates for filenames/gate checks: local-time YYYY-MM-DD via manual `getFullYear() / getMonth()+1 / getDate()` with zero-padding (matches Python `datetime.now().strftime("%Y-%m-%d")` — local time)

## 4. Per-script behavior spec

Each section specifies the externally-observable contract. Internal details (variable names, helper function layout) are implementation choices.

### 4.1 scripts/session_logger.js

**Invoked on:** SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd

**Input:** hook JSON on stdin with `hook_event_name`, `session_id`, plus event-specific fields (`prompt`, `tool_name`, `tool_input`, `tool_response`, `cwd`, `session_start_source`).

**Behavior:**
- Sanitize session_id: strip all chars not `[a-zA-Z0-9-]`; empty → `"unknown"`
- Ensure `.claude-sessions/raw/` and `.claude-sessions/sessions/` exist (mkdir recursive)
- Append one JSON line to `.claude-sessions/raw/<sid>.jsonl`
- For SessionStart / UserPromptSubmit / SessionEnd: append a human-readable line to `.claude-sessions/log.md`
- Swallow all errors; always exit 0

**JSONL entry shapes** (must match v1.1.0 byte-for-byte modulo whitespace):

| Event | JSON fields |
|---|---|
| SessionStart | `timestamp`, `event: "session_start"`, `session_id`, `source`, `cwd` |
| UserPromptSubmit | `timestamp`, `event: "user_prompt"`, `session_id`, `prompt` (capped at 2000 chars) |
| PostToolUse | `timestamp`, `event: "tool_use"`, `session_id`, `tool_name`, `summary`, `input_preview` (≤500), `response_preview` (≤500) |
| Stop | `timestamp`, `event: "stop"`, `session_id` |
| SessionEnd | `timestamp`, `event: "session_end"`, `session_id` |

**Tool summary logic** (PostToolUse):
- `Edit` / `Write` / `MultiEdit` → `"Modified <basename(file_path)>"`
- `Read` → `"Read <basename(file_path)>"`
- `Bash` → `"Ran: <command truncated to 200>"`
- `Grep` / `Glob` → `"Searched: <pattern>"`
- Otherwise → `"Used <tool_name>"`

**log.md line formats** (exact):
- Session start: `- [YYYY-MM-DD HH:MM] SESSION <first-8-of-sid> started (<source>)\n`
- User prompt: `- [HH:MM] PROMPT: <first 120 chars, newlines→spaces>\n`
- Session end: `- [HH:MM] SESSION <first-8-of-sid> ended\n`

### 4.2 scripts/inject_context.js

**Invoked on:** SessionStart

**Input:** hook JSON on stdin with `session_id`. `CLAUDE_PROJECT_DIR` env var for project root.

**Output:** Plain text to stdout (becomes additional context for Claude). Silent exit 0 when no data exists.

**Behavior:**
- Read `.claude-sessions/index.md` (up to 4000 chars, truncate at last newline)
- Read `.claude-sessions/decisions.md` (up to 4000 chars, truncate at last newline)
- Glob `.claude-sessions/sessions/*.md`, sort descending by filename, take first 3, read each up to 2700 chars
- If all three sources empty, exit 0 silently (no output)
- Otherwise print a structured block beginning with `=== ELEPHANTS NEVER FORGET: Cross-Session Context ===` followed by the current session id prefix, the index, decisions, and recent sessions, terminated by a `---` separator and a one-line instruction about using the skill
- Swallow all errors; always exit 0

**Exact output format** — preserve the Python structure verbatim (header, `## Session Index`, `## Standing Decisions`, `## Recent Sessions (Hot Tier — last 3)` with `### <filename>` subheaders, trailing `---` and instruction line).

### 4.3 scripts/gate.js

**Invoked on:** UserPromptSubmit, PreToolUse

**Input:** hook JSON on stdin.

**Behavior — UserPromptSubmit:**
- If a session file `sessions/YYYY-MM-DD-*.md` exists for today → silent exit 0 (allow)
- If `.opt-out/<sanitized-sid>` exists → silent exit 0 (allow)
- Otherwise print the `<system-reminder>` reminder template to stdout (exact text preserved from v1.1.0), then log a `gate_decision` entry to raw JSONL, exit 0

**Behavior — PreToolUse:**
- If session file for today exists → allow (silent, exit 0)
- If `.opt-out/<sid>` exists → allow
- If tool is `Write` with `file_path` under `.claude-sessions/sessions/` or `.claude-sessions/.opt-out/` → allow
- Otherwise print `{"decision": "deny", "reason": "<DENY_REASON>"}` JSON to stdout, log `gate_decision` with `decision:"deny"`, exit 0

**Fail-open:** malformed stdin, missing dirs, permission errors → silent exit 0 (never block).

**Exact template text** (preserve from v1.1.0 `REMINDER_TEMPLATE` and `DENY_REASON_TEMPLATE`) — placeholders `{today}` and `{session_id_prefix}` interpolate local-date and first 8 sanitized chars respectively.

**Hot path target:** <10ms when today's session file exists (single glob + no-op return).

### 4.4 scripts/pre_compact_warn.js

**Invoked on:** PreCompact

**Behavior:**
- Log a `pre_compact` entry to raw JSONL
- Append a line to log.md: `- [HH:MM] COMPACT: Context compaction triggered for <sid-prefix>\n`
- Print 4 lines to stdout warning Claude that compaction is imminent (exact text from v1.1.0)
- Swallow errors; always exit 0

### 4.5 scripts/transcript_parser.js

**Nature:** Pure library. No CLI entrypoint. Imported by `analytics.js`.

**Exports:**
- `parseTranscript(path) → object` — reads Claude Code transcript JSONL, returns `{ messages, usage_per_message, tool_uses, compactions, model }`. Missing file → `{}`. Malformed lines skipped silently.
- `findTranscriptPath(sessionId, cwd?) → string | null` — resolves `~/.claude/projects/<encoded-cwd>/<sid>.jsonl`, falls back to glob `*/<sid>.jsonl` under `~/.claude/projects/`
- `computeUsageTotals(transcript) → { input, output, cache_read, cache_creation, total, cache_hit_rate }`
- `estimateCost(usage, model) → { cost_usd, disclaimer, model, pricing_version }`
- `computePacing(transcript) → { inter_turn_median_ms, inter_turn_p95_ms, idle_gaps_sec, prompt_to_first_tool_ms }`
- `computeContextPressure(transcript, model) → { window_tokens, max_utilization_pct, compaction_count, utilization_trend }`
- `PRICING_TABLE_V1` (exported constant — ported verbatim from Python)
- `MODEL_WINDOWS` (exported constant — ported verbatim)
- `PRICING_AS_OF = "2026-01"` (exported string; referenced by analytics disclaimer)

**Model normalization:** lowercase, strip `[...]` suffix, strip 8-digit trailing date segment. Matches Python `_normalize_model`.

**Percentile:** nearest-rank, same formula as Python `_percentile`.

**Timestamp parsing:** accept both `Z` and `+00:00` suffixes — `new Date(str.replace('Z', '+00:00'))` with explicit NaN check; invalid → null.

**Defensive:** every function returns `{}`, `null`, or zero-valued struct on any error. Never throws.

### 4.6 scripts/analytics.js

**CLI:**
```
node scripts/analytics.js [--project-dir PATH] [--format json|markdown]
```

**Default:** `--project-dir` from `CLAUDE_PROJECT_DIR` env, else cwd; `--format` = `markdown`.

**Behavior:** Identical to v1.1.0 `analytics.py`. Parses session markdown frontmatter + body, parses `decisions.md`, parses `raw/*.jsonl`, merges transcript-derived metrics via `transcript_parser.js`, produces the same metrics dict, formats as markdown or JSON.

**Unicode chart helpers** (`sparkline`, `bar`, `pct`) — port verbatim, including the `SPARK_CHARS = "▁▂▃▄▅▆▇█"` string.

**Frontmatter parser** — inline YAML-lite: `key: value` pairs, list values as `[a, b, c]`. Port exact logic from Python `parse_frontmatter`.

**Insight generation** (`generateInsights`) — port the same threshold-based rules (reversal rate > 25, friction > 2/session, completion < 70%, etc.) verbatim.

**Output parity:** markdown output must be byte-identical to Python output for the same input (modulo generation timestamp if included). JSON output same structure, same keys.

### 4.7 scripts/dashboard.js

**CLI:**
```
node scripts/dashboard.js [--project-dir PATH] [--output PATH] [--no-open]
```

**Behavior:**
- Import `computeMetrics`, `generateInsights`, `pct` from `analytics.js`
- Generate HTML using template literals (preserve the Python HTML_TEMPLATE verbatim, converting Python `{}`-format placeholders to JS `${...}`)
- Write HTML to `--output` (default: `<sessions_dir>/dashboard.html`)
- Unless `--no-open`, launch browser:
  - macOS: `spawn('open', [fileUrl], { detached: true })`
  - Linux: `spawn('xdg-open', [fileUrl], { detached: true })`
  - Windows: `spawn('cmd', ['/c', 'start', '""', fileUrl], { detached: true })`
  - `fileUrl = pathToFileURL(resolvedOutputPath).href` via `node:url`
  - Detect platform via `process.platform`

**Chart.js still via CDN** (no vendoring).

### 4.8 scripts/generate_test_data.js

**CLI:** `node scripts/generate_test_data.js` — writes to `/tmp/enf-analytics-test/.claude-sessions/`

**Behavior:** Writes the 8 canned sessions, decisions.md, index.md, topics.md, per-session raw JSONL, and log.md exactly as v1.1.0 produces. Also exports `generateSyntheticTranscript(path, options)` for use by tests or users.

**Determinism:** the hash-based tool-name picker uses `crypto.createHash('md5').update(...).digest().readUInt32LE(0)` to reproduce Python's `hash(str) % 5` behavior deterministically across platforms. Exact tool-name values don't matter for tests — they just need to vary.

## 5. hooks/hooks.json changes

Replace every `"command": "python \"${CLAUDE_PLUGIN_ROOT}/scripts/<name>.py\""` with `"command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/<name>.js\""`.

Remove every `"async": true` field (undocumented in current Claude Code hooks reference; rely on sync execution — hot paths are already <10ms).

Preserve all other fields: `matcher`, `timeout`, event structure, hook ordering within each event.

## 6. Testing strategy

### 6.1 Test runner
`node --test tests/*.test.js` — Node's built-in runner. No dependencies.

### 6.2 Test topology

| Node test file | Ports from | Scope |
|---|---|---|
| `tests/helpers.js` | `tests/helpers.py` | Builders: `makeSessionFile`, `makeOptOutMarker`, `makeActiveMarker`, `makeSyntheticTranscript`. Plus a `makeSessionsDir(tmp)` factory that replaces the pytest `sessions_dir` fixture. |
| `tests/gate.test.js` | `tests/test_gate.py` | 10 tests: helper importability, silent-when-session-exists, silent-when-opt-out, reminder-when-no-file, pretool allow/deny cases, pretool allows write to sessions dir, pretool allows write to opt-out dir, deny Read, deny Bash, malformed-stdin fails open. |
| `tests/transcript_parser.test.js` | `tests/test_transcript_parser.py` | 13 tests: parse missing file, parse well-formed, skip malformed lines, find_path returns null, usage totals basic, usage totals empty, estimate_cost known model, estimate_cost unknown model, estimate_cost null model, compute_pacing basic, compute_pacing empty, compute_context_pressure known model, compute_context_pressure unknown model. |
| `tests/analytics_integration.test.js` | `tests/test_analytics_integration.py` | 2 tests: no transcripts present, transcript merge when present. |

### 6.3 Fixture replacement

pytest's `tmp_path`, `project_dir`, and `sessions_dir` fixtures become helper functions called at the start of each test:

```js
import { before, after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function setupProjectDir() {
  const root = mkdtempSync(join(tmpdir(), 'enf-test-'));
  const sd = join(root, '.claude-sessions');
  for (const sub of ['sessions', 'raw', '.opt-out', '.active']) {
    mkdirSync(join(sd, sub), { recursive: true });
  }
  return { projectDir: root, sessionsDir: sd };
}

function cleanup(root) { rmSync(root, { recursive: true, force: true }); }
```

Each test function:
```js
test('...', () => {
  const { projectDir, sessionsDir } = setupProjectDir();
  try {
    // ... assertions ...
  } finally {
    cleanup(projectDir);
  }
});
```

### 6.4 Subprocess tests

`gate.test.js` and `analytics_integration.test.js` currently invoke the Python script as a subprocess. Node equivalent:

```js
import { spawnSync } from 'node:child_process';
const result = spawnSync('node', [scriptPath], {
  input: JSON.stringify(stdinPayload),
  env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  timeout: 5000,
  encoding: 'utf8',
});
// assert result.status === 0, inspect result.stdout / result.stderr
```

### 6.5 `HOME` override for transcript discovery

`analytics_integration.test.js` uses `monkeypatch` to set fake `HOME`. Node equivalent: pass `HOME` in the `env` dict of `spawnSync`. `transcript_parser.js` must read home via `os.homedir()` (which respects `HOME` on Unix) so the override takes effect.

## 7. Pricing and window constants

Port verbatim into `transcript_parser.js`:

```js
export const PRICING_TABLE_V1 = Object.freeze({
  'claude-opus-4-7':    { input: 15.00, output: 75.00, cache_read: 1.50,  cache_creation: 18.75 },
  'claude-opus-4-6':    { input: 15.00, output: 75.00, cache_read: 1.50,  cache_creation: 18.75 },
  'claude-sonnet-4-6':  { input:  3.00, output: 15.00, cache_read: 0.30,  cache_creation:  3.75 },
  'claude-sonnet-4-5':  { input:  3.00, output: 15.00, cache_read: 0.30,  cache_creation:  3.75 },
  'claude-haiku-4-5':   { input:  0.80, output:  4.00, cache_read: 0.08,  cache_creation:  1.00 },
});
export const PRICING_AS_OF = '2026-01';

export const MODEL_WINDOWS = Object.freeze({
  'claude-opus-4-7':    200000,
  'claude-opus-4-6':    200000,
  'claude-sonnet-4-6':  200000,
  'claude-sonnet-4-5':  200000,
  'claude-haiku-4-5':   200000,
});
```

## 8. README changes

- **Requirements section:** `Python 3.8+` → `Node.js 22+`
- **Dashboard command:** `python scripts/dashboard.py ...` → `node scripts/dashboard.js ...`
- **Add install note:** "If you installed Claude Code via the native installer (not npm), you may need to install Node.js separately. Node 22+ is required. If you installed via `npm install -g @anthropic-ai/claude-code`, Node is already present."

No other README sections change. Feature list, metric definitions, decision format, compression tiers — all unaffected.

## 9. Version and marketplace metadata

- `.claude-plugin/plugin.json`: `"version": "1.1.0"` → `"version": "2.0.0"`
- `.claude-plugin/marketplace.json`: bump matching entry to `"2.0.0"`
- No changes to `name`, `description`, `author`, other metadata

## 10. Error handling policy (cross-cutting)

| Scenario | Behavior |
|---|---|
| Malformed stdin JSON | `catch` → exit 0 silently (fail-open) |
| Missing `.claude-sessions/` dir | `mkdir { recursive: true }` — never error on ENOENT |
| Permission denied on read | Return empty/zero struct; continue |
| Permission denied on write | Swallow; continue |
| Unknown model in pricing/pressure | Return `{ cost_usd: null, ... }` / `{ window_tokens: null, ... }` with disclaimer string |
| Unknown hook event name | Ignore (no handler matches) |
| Script crashes mid-run | Top-level try/catch → exit 0; stderr write for diagnostics is optional |

**The Gate is the only hook that may produce a non-empty stdout with intent to block.** All other hooks are advisory/logging only.

## 11. Performance targets

| Script | Target | Notes |
|---|---|---|
| `gate.js` hot path (today's session file exists) | < 10ms | One glob + early return |
| `gate.js` cold path (no file, reminder injection) | < 30ms | Glob + 1-2 writes |
| `session_logger.js` | < 15ms | Append one JSONL line + optional log.md line |
| `pre_compact_warn.js` | < 15ms | 1 JSONL + 1 log line + 4 stdout lines |
| `inject_context.js` | < 100ms | 2 file reads + glob + 3 file reads |

Python baseline for `gate.py` is ~8ms cold on macOS; Node cold-start is comparable (≈15-25ms for `node` interpreter startup alone, but ESM modules with stdlib-only imports stay under 50ms total). **This port accepts a slight cold-start regression on gate/session_logger in exchange for the portability win** — still well under the user-perceivable threshold.

## 12. Acceptance criteria

1. `node --test tests/` passes all ported tests (26 tests total: 13 transcript_parser + 11 gate + 2 analytics_integration)
2. No `.py` files remain in `scripts/` or `tests/` (docs may reference Python historically)
3. `hooks/hooks.json` uses `node` in every `command`; no `"async"` field present
4. `.claude-plugin/plugin.json` and `marketplace.json` both at version `2.0.0`
5. `package.json` exists at repo root with `"type": "module"` and `"engines.node": ">=22"`, no `dependencies`
6. `README.md` requirements section lists Node 22+ and includes the native-installer caveat
7. Running `node scripts/generate_test_data.js` then `node scripts/analytics.js --project-dir /tmp/enf-analytics-test --format markdown` produces markdown output with the same section headers, metric names, and insight rules as the Python version (exact byte-equality not required — whitespace and number formatting may differ)
8. Running `node scripts/dashboard.js --project-dir /tmp/enf-analytics-test --no-open` produces an HTML file that renders correctly (manual check: KPI cards, 4 charts, insights, v1.1.0 sections all present)
9. Fresh install scenario: on a machine with Node 22+ and no Python, all hook events fire without error; `.claude-sessions/raw/<sid>.jsonl` accumulates entries matching the v1.1.0 schema
10. Gate fail-open verified: inject malformed stdin → script exits 0 with empty stdout
11. Gate PreToolUse deny produces valid JSON parseable as `{"decision":"deny","reason":"..."}` on stdout

## 13. Rollout plan

Single branch, one commit per logical unit for reviewability:

1. `package.json` + stub `scripts/transcript_parser.js` with just the constants and exports
2. Port `scripts/transcript_parser.js` fully + write `tests/transcript_parser.test.js`; run tests
3. Port `scripts/session_logger.js` + `scripts/gate.js` + `scripts/inject_context.js` + `scripts/pre_compact_warn.js`; write `tests/helpers.js` + `tests/gate.test.js`; run tests
4. Port `scripts/analytics.js` + `tests/analytics_integration.test.js`; run tests
5. Port `scripts/dashboard.js`; manual HTML verification
6. Port `scripts/generate_test_data.js`; manual output verification
7. Delete all `.py` files from `scripts/` and `tests/` (including `conftest.py`, `__init__.py`)
8. Update `hooks/hooks.json` (`python` → `node`, drop `async`)
9. Update `README.md` requirements + dashboard command
10. Bump `.claude-plugin/plugin.json` and `marketplace.json` to `2.0.0`
11. Final commit: verify full test suite, push

## 14. Out of scope (deferred)

- Adopting new hook events (`SubagentStart`, `PostCompact`, `PermissionDenied`, `Notification`, etc.)
- Bundling Node into the plugin (not possible; Claude Code plugins ship source only)
- A polyfill or migration layer for users who stay on v1.1.0
- Any changes to skill markdown under `skills/`
- Internationalization of the dashboard

## 15. References

- v1.1.0 spec: `docs/superpowers/specs/2026-04-17-improve-enf-plugin-design.md`
- Node.js LTS schedule: https://nodejs.org/en/about/previous-releases
- Node EOL tracker: https://endoflife.date/nodejs
- Claude Code hooks reference: https://code.claude.com/docs/en/hooks.md
- Claude Code hooks guide: https://code.claude.com/docs/en/hooks-guide.md
- Claude Code setup (install methods): https://code.claude.com/docs/en/setup.md
