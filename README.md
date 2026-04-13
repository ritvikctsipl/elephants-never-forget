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

Copy or symlink this directory into your Claude Code plugins path, or install via:

```bash
# From the Claude Code CLI
/install-plugin /path/to/elephants_never_forget
```

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

## Requirements

- Python 3.8+
- Claude Code CLI

## Inspired by

- [Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
- [Architectural Decision Records (ADRs)](https://adr.github.io/madr/)
- [Y-Statement decision format](https://medium.com/olzzio/y-statements-10eb07b5a177)
- [Tiago Forte's Progressive Summarization](https://fortelabs.com/blog/progressive-summarization-a-practical-technique-for-designing-discoverable-notes/)

## License

MIT
