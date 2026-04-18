---
name: session-analytics
description: Use when the user asks for stats, a dashboard, decision quality, friction, token spend, cost, cache efficiency, context pressure, pacing, or "how am I doing".
---

# Session Analytics

Show analytics from the Elephants Never Forget session tracking system. Surfaces decision quality, friction, token spend, cost, cache efficiency, context pressure, and pacing — with constructive guidance on each.

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
- When the user asks about **cost, efficiency, or token spend**
- At the end of milestone-like sessions

## Interpreting Results for the User

When showing analytics, add context — raw numbers alone aren't useful. Frame every suggestion as "here's what you can try," never "you're doing this wrong."

### Decision quality & friction

| Metric | Good | Needs attention | How to improve |
|--------|------|-----------------|----------------|
| Reversal rate | <10% | >25% | Spend more time on requirements before starting. |
| Decision stability | >70% | <40% | Research alternatives more thoroughly upfront. |
| Avg redirects/session | <0.5 | >2 | Write a brief goal before each session. |
| Completion rate | >80% | <60% | Set smaller, more focused session goals. |
| Session focus | >70% single-topic | <40% | Resist scope creep; finish one thing first. |

### Token spend, cost & cache (v1.1.0, requires transcript)

| Metric | Good | Needs attention | How to improve |
|--------|------|-----------------|----------------|
| Cache hit rate | >60% | <30% | Long stable contexts improve cache reuse; avoid churning the early turns. |
| Cost per session | project-dependent | unexpected spikes | Check context utilization; consider Haiku for cheaper work. |
| Peak context utilization | <70% | >90% | Sessions running near the window compact often and lose detail. Break up the work. |
| Idle gaps count | few | many | Long gaps suggest interrupted flow; consider shorter sessions. |

### Notes on cost estimation

- Costs use **public rates as of 2026-01** — real invoices may differ.
- Unknown models (not in the pricing table) are omitted from cost totals with a disclaimer.
- Cost is a **derived signal** from the transcript; if `~/.claude/projects/` isn't accessible, cost figures will be empty.

### Notes on context pressure

- Utilization resets to zero after each compaction boundary. A session with many compactions may show low peak utilization but high total spend.
- "Peak utilization" = peak cumulative input+cache_read tokens between compactions, divided by the model's window.
