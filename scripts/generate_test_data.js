/**
 * Generate realistic test data for analytics testing.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';

const TEST_DIR = '/tmp/enf-analytics-test';
const SD = join(TEST_DIR, '.claude-sessions');

function setup() {
  mkdirSync(join(SD, 'sessions'), { recursive: true });
  mkdirSync(join(SD, 'raw'), { recursive: true });
}

function write(relPath, content) {
  const full = join(SD, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function writeJsonl(relPath, events) {
  const full = join(SD, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

function pad2(n) { return String(n).padStart(2, '0'); }

function dateOffsetStr(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function deterministicIndex(seed, mod) {
  const h = createHash('md5').update(seed).digest();
  return h.readUInt32LE(0) % mod;
}

function main() {
  setup();

  // ── Session files ──
  const sessions = [
    {
      file: `sessions/${dateOffsetStr(21)}-project-setup.md`,
      content: `---
session_id: aaa11111
date: ${dateOffsetStr(21)}
start_time: "10:00"
tags: [setup, scaffolding]
status: completed
summary: "Initial project scaffolding with Express and React"
---

## Intent
Set up the initial project structure.

## Decisions
- [10:15] Y: In the context of backend framework, facing choice of Express vs Fastify, decided Express over Fastify, to achieve wider ecosystem support, accepting slower performance. Confidence: high
- [10:30] Y: In the context of frontend, facing choice of framework, decided React over Vue, to achieve team familiarity, accepting larger bundle. Confidence: high

## Files Touched
- \`package.json\` — role: created, what: project manifest
- \`src/index.ts\` — role: created, what: entry point

## Open Items
- [x] Initialize git repo
- [x] Set up TypeScript config
`,
    },
    {
      file: `sessions/${dateOffsetStr(18)}-database-layer.md`,
      content: `---
session_id: bbb22222
date: ${dateOffsetStr(18)}
start_time: "14:00"
tags: [database, postgres, orm]
status: completed
summary: "Set up PostgreSQL with Prisma ORM"
---

## Intent
Set up the database layer for the project.

## Decisions
- [14:20] Y: In the context of database, facing choice of DB engine, decided PostgreSQL over MongoDB, to achieve relational integrity, accepting more complex queries. Confidence: high
- [14:45] Y: In the context of ORM, facing choice of query builder, decided Prisma over TypeORM, to achieve type-safe queries, accepting heavier bundle. Confidence: medium

## Friction Events
- [14:30] User redirected approach: was considering MongoDB initially, switched to PostgreSQL after discussing data relationships

## Files Touched
- \`prisma/schema.prisma\` — role: created, what: database schema
- \`src/db/client.ts\` — role: created, what: Prisma client wrapper

## Open Items
- [x] Create initial migration
- [ ] Add seed data
`,
    },
    {
      file: `sessions/${dateOffsetStr(14)}-auth-jwt.md`,
      content: `---
session_id: ccc33333
date: ${dateOffsetStr(14)}
start_time: "09:00"
tags: [auth, jwt, security]
status: completed
summary: "Implemented JWT authentication — later reversed to sessions"
---

## Intent
Add authentication to the API.

## Decisions
- [09:15] Y: In the context of auth mechanism, facing choice of JWT vs sessions, decided JWT over sessions, to achieve stateless auth, accepting token management complexity. Confidence: medium
- [09:30] Y: In the context of JWT signing, facing algorithm choice, decided RS256 over HS256, to achieve asymmetric verification, accepting key management overhead. Confidence: low

## Errors & Fixes
- [09:45] Error: \`jsonwebtoken types not found\`. Fix: Installed @types/jsonwebtoken

## Files Touched
- \`src/middleware/auth.ts\` — role: created, what: JWT verification middleware
- \`src/routes/login.ts\` — role: created, what: login endpoint

## Open Items
- [ ] Add refresh token rotation
`,
    },
    {
      file: `sessions/${dateOffsetStr(12)}-auth-sessions.md`,
      content: `---
session_id: ddd44444
date: ${dateOffsetStr(12)}
start_time: "11:00"
tags: [auth, sessions, redis, cookies]
status: completed
summary: "Reversed JWT to cookie-based sessions with Redis"
---

## Intent
Switch from JWT to cookie-based sessions after realizing JWT complexity was unnecessary for this project.

## Decisions
- [11:15] Y: In the context of auth mechanism, facing JWT complexity concerns, decided cookie sessions over JWT, to achieve simpler server-side management, accepting Redis dependency. Confidence: high
- [11:30] Y: In the context of session store, facing production requirement, decided connect-redis over memorystore, to achieve TTL-based expiration, accepting infra dependency. Confidence: high

## Reversals
- [11:15] REVERSED [JWT decision from session ccc33333]: Changed from JWT to cookie-based sessions because JWT was overengineered for a server-rendered app

## Friction Events
- [11:05] User redirected approach: started session wanting to "fix JWT refresh tokens" then decided to scrap JWT entirely

## Errors & Fixes
- [11:40] Error: \`express-session requires a session store for production\`. Fix: Added connect-redis

## Files Touched
- \`src/middleware/auth.ts\` — role: modified, what: replaced JWT with express-session
- \`src/middleware/session.ts\` — role: created, what: session config with Redis store
- \`package.json\` — role: modified, what: swapped jsonwebtoken for express-session

## Open Items
- [x] Configure Redis for production
- [ ] Add session cookie security settings
`,
    },
    {
      file: `sessions/${dateOffsetStr(8)}-api-endpoints.md`,
      content: `---
session_id: eee55555
date: ${dateOffsetStr(8)}
start_time: "10:00"
tags: [api, rest, crud]
status: completed
summary: "Built CRUD API endpoints for tasks"
---

## Intent
Build the core API endpoints for task management.

## Decisions
- [10:20] Y: In the context of API design, facing REST vs GraphQL, decided REST over GraphQL, to achieve simplicity, accepting potential over-fetching. Confidence: high

## Files Touched
- \`src/routes/tasks.ts\` — role: created, what: CRUD endpoints
- \`src/routes/index.ts\` — role: modified, what: registered task routes

## Open Items
- [x] GET /tasks
- [x] POST /tasks
- [x] PUT /tasks/:id
- [x] DELETE /tasks/:id
`,
    },
    {
      file: `sessions/${dateOffsetStr(5)}-frontend-layout.md`,
      content: `---
session_id: fff66666
date: ${dateOffsetStr(5)}
start_time: "15:00"
tags: [frontend, react, ui, tailwind]
status: completed
summary: "Set up React frontend with Tailwind CSS"
---

## Intent
Build the frontend layout and component structure.

## Decisions
- [15:10] Y: In the context of CSS approach, facing choice of CSS framework, decided Tailwind over styled-components, to achieve utility-first rapid prototyping, accepting HTML verbosity. Confidence: high
- [15:30] Y: In the context of state management, facing choice of state library, decided Zustand over Redux, to achieve simpler API, accepting less ecosystem tooling. Confidence: medium

## Files Touched
- \`src/components/Layout.tsx\` — role: created, what: main layout wrapper
- \`src/components/TaskList.tsx\` — role: created, what: task list component
- \`tailwind.config.ts\` — role: created, what: Tailwind configuration

## Open Items
- [x] Basic layout
- [ ] Mobile responsive design
- [ ] Dark mode toggle
`,
    },
    {
      file: `sessions/${dateOffsetStr(3)}-testing.md`,
      content: `---
session_id: ggg77777
date: ${dateOffsetStr(3)}
start_time: "09:00"
tags: [testing, vitest, api]
status: completed
summary: "Added Vitest tests for API endpoints"
---

## Intent
Add comprehensive tests for the API layer.

## Decisions
- [09:10] Y: In the context of test framework, facing choice of test runner, decided Vitest over Jest, to achieve faster execution and native ESM, accepting newer ecosystem. Confidence: high

## Errors & Fixes
- [09:25] Error: \`Cannot find module prisma/client in test environment\`. Fix: Added test setup file with mock Prisma client
- [09:45] Error: \`Cannot find module prisma/client in test environment\`. Fix: Updated vitest.config.ts with proper module resolution

## Files Touched
- \`vitest.config.ts\` — role: created, what: Vitest configuration
- \`src/__tests__/tasks.test.ts\` — role: created, what: API endpoint tests
- \`src/__tests__/setup.ts\` — role: created, what: test setup and mocks

## Open Items
- [x] Task CRUD tests
- [ ] Auth middleware tests
- [ ] Integration tests with real DB
`,
    },
    {
      file: `sessions/${dateOffsetStr(1)}-deploy-setup.md`,
      content: `---
session_id: hhh88888
date: ${dateOffsetStr(1)}
start_time: "16:00"
tags: [deploy, docker, ci]
status: completed
summary: "Set up Docker and GitHub Actions CI/CD"
---

## Intent
Containerize the app and set up CI/CD pipeline.

## Decisions
- [16:10] Y: In the context of deployment, facing choice of container runtime, decided Docker over Podman, to achieve wider CI support, accepting Docker Desktop license. Confidence: high
- [16:30] Y: In the context of CI platform, facing choice of CI service, decided GitHub Actions over CircleCI, to achieve tight GitHub integration, accepting YAML complexity. Confidence: high

## Friction Events
- [16:45] Abandoned approach: tried multi-stage Docker build with Alpine but hit native dependency issues with Prisma, switched to Debian-based image

## Errors & Fixes
- [16:50] Error: \`prisma generate failed in Docker build\`. Fix: Added prisma generate to Dockerfile build step

## Files Touched
- \`Dockerfile\` — role: created, what: multi-stage build for production
- \`.github/workflows/ci.yml\` — role: created, what: CI pipeline with test + build + deploy
- \`docker-compose.yml\` — role: modified, what: added production profile

## Open Items
- [x] Dockerfile working
- [x] CI pipeline passing
- [ ] Set up staging environment
- [ ] Configure production secrets
`,
    },
  ];

  for (const s of sessions) write(s.file, s.content);

  // decisions.md
  write('decisions.md', `# Standing Decisions

## Backend Framework
- [${dateOffsetStr(21)}] Y: In the context of backend, decided Express over Fastify for ecosystem support. Confidence: high. Session: aaa11111

## Frontend Framework
- [${dateOffsetStr(21)}] Y: In the context of frontend, decided React over Vue for team familiarity. Confidence: high. Session: aaa11111

## Database
- [${dateOffsetStr(18)}] Y: In the context of database, decided PostgreSQL over MongoDB for relational integrity. Confidence: high. Session: bbb22222

## ORM
- [${dateOffsetStr(18)}] Y: In the context of ORM, decided Prisma over TypeORM for type-safe queries. Confidence: medium. Session: bbb22222

## Authentication
- [${dateOffsetStr(12)}] Y: In the context of auth, decided cookie sessions over JWT for simpler management. Confidence: high. Session: ddd44444
  - ~~[${dateOffsetStr(14)}] Previously: JWT with RS256 signing. Confidence: medium. Session: ccc33333~~ SUPERSEDED

## Session Storage
- [${dateOffsetStr(12)}] Y: In the context of session store, decided connect-redis over memorystore. Confidence: high. Session: ddd44444

## API Design
- [${dateOffsetStr(8)}] Y: In the context of API, decided REST over GraphQL for simplicity. Confidence: high. Session: eee55555

## CSS Framework
- [${dateOffsetStr(5)}] Y: In the context of CSS, decided Tailwind over styled-components. Confidence: high. Session: fff66666

## State Management
- [${dateOffsetStr(5)}] Y: In the context of state, decided Zustand over Redux. Confidence: medium. Session: fff66666

## Test Framework
- [${dateOffsetStr(3)}] Y: In the context of testing, decided Vitest over Jest. Confidence: high. Session: ggg77777

## Deployment
- [${dateOffsetStr(1)}] Y: In the context of deployment, decided Docker over Podman. Confidence: high. Session: hhh88888
- [${dateOffsetStr(1)}] Y: In the context of CI, decided GitHub Actions over CircleCI. Confidence: high. Session: hhh88888
`);

  // index.md
  write('index.md', `# Session Index

> Task Manager App — 8 sessions, 12 active decisions

## Recent
- [${dateOffsetStr(1)}-deploy-setup](sessions/${dateOffsetStr(1)}-deploy-setup.md): Docker + GitHub Actions CI/CD. Tags: deploy, docker, ci
- [${dateOffsetStr(3)}-testing](sessions/${dateOffsetStr(3)}-testing.md): Vitest API tests. Tags: testing, vitest, api
- [${dateOffsetStr(5)}-frontend-layout](sessions/${dateOffsetStr(5)}-frontend-layout.md): React + Tailwind layout. Tags: frontend, react, tailwind
- [${dateOffsetStr(8)}-api-endpoints](sessions/${dateOffsetStr(8)}-api-endpoints.md): CRUD API for tasks. Tags: api, rest, crud
- [${dateOffsetStr(12)}-auth-sessions](sessions/${dateOffsetStr(12)}-auth-sessions.md): Reversed JWT to cookie sessions. Tags: auth, sessions, redis
- [${dateOffsetStr(14)}-auth-jwt](sessions/${dateOffsetStr(14)}-auth-jwt.md): JWT auth (later reversed). Tags: auth, jwt, security
- [${dateOffsetStr(18)}-database-layer](sessions/${dateOffsetStr(18)}-database-layer.md): PostgreSQL + Prisma. Tags: database, postgres, orm
- [${dateOffsetStr(21)}-project-setup](sessions/${dateOffsetStr(21)}-project-setup.md): Initial scaffolding. Tags: setup, scaffolding
`);

  // topics.md
  write('topics.md', `## auth
- auth-jwt: JWT auth (reversed)
- auth-sessions: Cookie-based sessions

## database
- database-layer: PostgreSQL + Prisma

## frontend
- frontend-layout: React + Tailwind

## deploy
- deploy-setup: Docker + CI/CD

## testing
- testing: Vitest API tests
`);

  // Raw JSONL files
  const sids = ['aaa11111', 'bbb22222', 'ccc33333', 'ddd44444', 'eee55555', 'fff66666', 'ggg77777', 'hhh88888'];
  const daysAgo = [21, 18, 14, 12, 8, 5, 3, 1];
  const promptsPer = [4, 6, 5, 7, 3, 5, 6, 8];
  const toolNames = ['Edit', 'Read', 'Bash', 'Grep', 'Write'];

  for (let i = 0; i < sids.length; i++) {
    const sid = sids[i];
    const base = new Date(Date.now() - daysAgo[i] * 86_400_000);
    const events = [
      { timestamp: base.toISOString(), event: 'session_start', session_id: sid, source: 'startup' },
    ];
    for (let k = 0; k < promptsPer[i]; k++) {
      events.push({
        timestamp: new Date(base.getTime() + (5 * k + 2) * 60_000).toISOString(),
        event: 'user_prompt',
        session_id: sid,
        prompt: `Prompt ${k + 1} for session ${sid.slice(0, 3)}`,
      });
      for (let t = 0; t < 2; t++) {
        events.push({
          timestamp: new Date(base.getTime() + (5 * k + 3 + t) * 60_000).toISOString(),
          event: 'tool_use',
          session_id: sid,
          tool_name: toolNames[deterministicIndex(`${sid}${k}${t}`, 5)],
          summary: `Tool use ${t + 1}`,
        });
      }
    }
    events.push({
      timestamp: new Date(base.getTime() + 60 * 60_000).toISOString(),
      event: 'session_end',
      session_id: sid,
    });
    writeJsonl(`raw/${sid}.jsonl`, events);
  }

  write('log.md', '# Session Log\n\n- Sessions logged by hooks\n');

  process.stdout.write(`Test data generated at ${TEST_DIR}\n`);
  process.stdout.write(`  8 sessions, 12 decisions, 1 reversal, 4 errors, 3 friction events\n`);
}

export function generateSyntheticTranscript(path, {
  sessionId,
  numTurns = 10,
  inputTokensPerTurn = 1500,
  outputTokensPerTurn = 600,
  cacheReadTokens = 300,
  cacheCreationTokens = 150,
  model = 'claude-opus-4-7',
  compactionAt = null,
} = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const t0 = new Date(Date.UTC(2026, 3, 17, 10, 0, 0));
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

main();
