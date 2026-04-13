---
name: session-analytics
description: Use when the user asks to see stats, analytics, a dashboard, project progress, session patterns, decision quality, or wants to review their collaboration habits. Also use when the user asks "how am I doing" or wants to improve their workflow.
---

# Session Analytics

Show analytics from the Elephants Never Forget session tracking system.

## Two Output Modes

### Quick Stats (inline markdown)
Run and show the output directly in conversation:

```bash
python "${CLAUDE_PLUGIN_ROOT}/scripts/analytics.py" --project-dir "${CLAUDE_PROJECT_DIR}"
```

Use this when the user asks for a quick overview or specific metrics.

### Full Dashboard (opens in browser)
For deep analysis with interactive charts:

```bash
python "${CLAUDE_PLUGIN_ROOT}/scripts/dashboard.py" --project-dir "${CLAUDE_PROJECT_DIR}"
```

This generates `.claude-sessions/dashboard.html` and opens it in the browser.

## When to Offer Analytics

- After 5+ sessions, proactively mention "You can run `/session-analytics` to see your patterns"
- When the user asks about past decisions or progress
- When the user seems frustrated with reversals or rework
- At the end of milestone-like sessions

## Interpreting Results for the User

When showing analytics, add context — raw numbers alone aren't useful:

| Metric | Good | Needs Attention | How to Improve |
|--------|------|-----------------|----------------|
| Reversal rate | <10% | >25% | Spend more time on requirements before starting |
| Decision stability | >70% | <40% | Research alternatives more thoroughly upfront |
| Avg redirects/session | <0.5 | >2 | Write a brief goal before each session |
| Completion rate | >80% | <60% | Set smaller, more focused session goals |
| Session focus | >70% single-topic | <40% | Resist scope creep; finish one thing first |

Always frame feedback constructively — "here's what you can try" not "you're doing this wrong."
