# Elephants Never Forget

A Claude Code plugin that maintains cross-session memory through structured session tracking, decision logging, and progressive summarization.

## What it does

- **Hooks** mechanically log every prompt, tool use, and session event to crash-safe JSONL files
- **Skill** teaches Claude to maintain structured session summaries, Y-statement decisions, friction tracking, and reversal detection
- **Context injection** loads previous session history and standing decisions at the start of each new session
- **Progressive summarization** compresses older sessions across three tiers (Hot → Warm → Cold) to keep context bounded

## Why

1. **Cross-session context** — Claude starts every session knowing what you've done before
2. **Decision tracking** — Every significant choice is recorded with rationale, alternatives, and confidence
3. **Reversal detection** — See when and why decisions changed direction
4. **Pattern analysis** — Monitor your own instruction quality, efficiency, and friction over time

## Install

Add this to your `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "elephants-never-forget": {
      "source": {
        "source": "github",
        "repo": "ritvikctsipl/elephants-never-forget"
      }
    }
  },
  "enabledPlugins": {
    "elephants-never-forget@elephants-never-forget": true
  }
}
```

Then restart Claude Code. The plugin auto-installs globally — skills, hooks, and scripts are all handled for you.

## File Structure

The plugin creates a `.claude-sessions/` directory in each project:

```
.claude-sessions/
  index.md              # One-line per session, newest first
  topics.md             # Tag-to-session mapping
  decisions.md          # Standing decisions (Y-statements)
  log.md                # Append-only chronological record (hook-written)
  sessions/
    YYYY-MM-DD-topic.md # Per-session detailed file
  raw/
    <session-id>.jsonl  # Mechanical event log (hook-written)
```

## How it works

### Hooks (mechanical layer — always runs)

| Hook | What it does |
|------|-------------|
| **SessionStart** | Injects previous session context into Claude's context window |
| **UserPromptSubmit** | Logs each prompt with timestamp to JSONL |
| **PostToolUse** | Logs tool name and summary to JSONL |
| **Stop** | Logs when Claude finishes responding |
| **PreCompact** | Warns Claude to save state before context compression |
| **SessionEnd** | Marks session complete in logs |

### Skill (intelligent layer — Claude follows these guidelines)

- Creates structured session files with intent, decisions, errors, friction events
- Writes decisions in **Y-statement format**: "In the context of [X], facing [Y], decided [Z] over [alternatives]..."
- Tracks decision reversals with immutable history (strikethrough old, create new)
- Progressively compresses older sessions:
  - **Hot** (current + last 3): Full detail
  - **Warm** (4-30 days): Anchored summary (intent, changes, decisions, next steps)
  - **Cold** (30+ days): Frontmatter + summary only; decisions preserved in decisions.md

### The Gate (v1.1.0)

Two hooks — `UserPromptSubmit` and `PreToolUse` — enforce session-file creation:

- On each prompt, if today's session file is missing, a `<system-reminder>` block is injected telling Claude to create it first.
- On each tool call, if neither a session file for today nor an opt-out marker exists, Claude's tool calls are denied *unless* the tool is a `Write` into `.claude-sessions/sessions/` or `.claude-sessions/.opt-out/` (the creation path).
- **Opt-out:** create an empty marker at `.claude-sessions/.opt-out/<session-id>` and the gate will be silent for that session.
- **Fail-open:** any filesystem or parsing error in the gate defaults to *allow*. The gate can never brick a session.
- **Hot-path cost:** ~1ms per invocation once today's session file exists (single filesystem glob).

## Analytics Dashboard

The plugin includes an analytics system that helps you understand your collaboration patterns.

### Quick stats (in conversation)
Ask Claude to show your analytics, or use the `session-analytics` skill. You'll get an inline markdown dashboard with Unicode sparklines and progress bars:

```
| Metric              | Value  | Trend        |
|---------------------|--------|--------------|
| Reversal rate       | 7.1%   | ██████████████░░ |
| Decision stability  | 82%    | █████████████░░░ |
| Friction rate       | 0.3/s  | Clear communicator |
```

### Full dashboard (in browser)
For interactive charts, run:
```bash
python scripts/dashboard.py --project-dir .
```
This generates a self-contained HTML dashboard with Chart.js visualizations.

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

## Requirements

- Python 3.8+
- Claude Code CLI

**Important:** Add `.claude-sessions/` to your project's `.gitignore` to avoid committing session data (which may contain prompts and error messages).

## Inspired by

- [Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
- [Architectural Decision Records (ADRs)](https://adr.github.io/madr/)
- [Y-Statement decision format](https://medium.com/olzzio/y-statements-10eb07b5a177)
- [Tiago Forte's Progressive Summarization](https://fortelabs.com/blog/progressive-summarization-a-practical-technique-for-designing-discoverable-notes/)

## License

MIT
