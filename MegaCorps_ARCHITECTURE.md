# MegaCorps — Architecture Design v0.3

> Current clear-text progress, Paperclip research notes, gap analysis, and next-phase plan are maintained in [MegaCorps_PROGRESS.md](./MegaCorps_PROGRESS.md).

## Architecture Update v0.7 - Task Message Boards and Bounded Kanban Context

Date: 2026-06-05

### Task Message Boards

Every Kanban task now has a dedicated message board backed by `card_comments`.

Schema update:

- `card_comments.agent_id` links an agent-authored message to the agent that wrote it.
- `author_type` can now represent user, agent, or system style messages.
- `action` distinguishes normal comments, `agent_note`, `agent_update`, review notes, and intervention actions.

Behavior:

- Users can post normal task messages.
- Users can post a message as a selected agent for coordination/debugging.
- Agent dispatch completion writes an `agent_update` message.
- Reviewer completion writes `review_note` or `review_rejected`.
- Dispatch/review failures write agent error messages.
- Webhook completions write agent/system board messages.

The Kanban task detail panel now shows a `Task Message Board` with author, action, timestamp, and message body.

### Bounded Kanban Context Injection

Agent invocations now receive a richer platform-side context snapshot while respecting context length limits.

Applies to:

- task dispatch,
- task review,
- direct agent chat.

Injected context:

- company mission/settings,
- compact same-company Kanban board snapshot,
- stage counts,
- focus task details,
- parent/child/dependency relationships,
- focus agent assigned work and review queue,
- latest task message board entries,
- latest task lifecycle logs,
- recent company activity,
- recent heartbeat runs,
- matching knowledge docs.

Context controls:

- `DISPATCH_CONTEXT_CHAR_BUDGET`
- `DISPATCH_CONTEXT_CARD_LIMIT`
- `DISPATCH_CONTEXT_RECORD_LIMIT`
- `DISPATCH_TASK_BODY_CHAR_LIMIT`
- `DISPATCH_KNOWLEDGE_DOC_CHAR_LIMIT`
- `MESSAGE_BOARD_COMMENT_LIMIT`

When the generated context exceeds the configured budget, MegaCorps clips sections and marks the prompt as truncated instead of silently overfilling the model context.

## Architecture Update v0.6 - Direct Chat and Cron Observability

Date: 2026-06-05

### Direct Agent Chat

MegaCorps now has a dedicated `Direct Chat` sidebar page.

User flow:

1. Select a company.
2. Select an agent in that company.
3. Select an existing session or create a new session.
4. Send a direct message to that agent.

Data model:

- `chat_sessions`: company, agent, user, title, status, and adapter `agent_session_id`.
- `chat_messages`: user/agent/system messages, cost, duration, and metadata.

Execution behavior:

- Direct chat uses the same adapter registry as task dispatch.
- Direct chat uses the same runtime preset plus agent override merge logic.
- Each chat session stores its own adapter resume id, so one agent can have multiple independent conversations.
- Chat runs are recorded in `heartbeat_runs` with source `chat`.
- Replies and failures are recorded in `activity_log`.
- Successful replies record cost in `cost_events`.
- Paused/busy/failed agents create visible system messages in the conversation.
- Hermes direct chat uses a chat-specific prompt, not the Kanban task webhook prompt.

### Cron System

The dispatch heartbeat is now exposed as a named cron service: `dispatch-heartbeat`.

Runtime state:

- `DISPATCH_LOOP_ENABLED=false` disables the automatic scheduler.
- `DISPATCH_LOOP_INTERVAL_MS` controls the global scheduler interval.
- Company `dispatchIntervalSeconds` and `autoDispatchEnabled` decide which companies are eligible on each loop tick.

Durable history:

- `cron_runs` records startup, loop, and manual ticks.
- Each run stores status, duration, active company count, scanned cards, dispatched cards, reviewed cards, skipped cards, and errors.

API:

- `GET /api/cron/status`
- `GET /api/cron/runs`
- `POST /api/cron/run`

UI:

- `Logs` shows cron status and recent run history.
- `Logs` includes a manual `Run now` action for operator debugging.

### Production Gap Review

The Phase 1-10 MVP is now usable for controlled local/NAS debugging, but production still needs:

- strong company-scoped authorization on every endpoint,
- RBAC for admin/operator/viewer actions,
- encrypted or externalized adapter secrets,
- async worker/queue for long-running Hermes jobs,
- runtime health checks and offline routing,
- realtime WebSocket/SSE updates for chat, runs, and logs,
- versioned migrations and rollback strategy,
- rate limiting for auth/chat/webhooks/manual cron,
- backup/restore and retention policies,
- browser E2E tests for core logged-in workflows.

## Architecture Update v0.4 - Phase 1-7 Operational MVP

Date: 2026-06-05

### Adapter Configuration

MegaCorps now separates adapter configuration into runtime presets and per-agent overrides.

Configuration order:

1. Environment fallback from `.env` / Docker environment.
2. Shared runtime preset stored in `agent_runtimes.config`.
3. Agent override stored in `agents.adapter_config`.

The effective runtime config is merged in dispatch before the adapter is called. Agent overrides win over runtime presets, and runtime presets win over environment defaults.

UI entry points:

- `Settings -> Agent runtimes`: create/edit/delete runtime presets.
- `Agents -> select agent`: attach a runtime preset and fill adapter override fields.
- `Agents -> Test`: validate the merged runtime/agent config against the selected adapter.

Supported adapter fields:

- `mock`: no endpoint required.
- `hermes`: `portainerUrl`, `portainerUser`, `portainerPass`, `portainerEndpointId`, `hermesContainer`, `publicApiUrl`, `reasoningEffort`, `maxTurns`.
- `hermes-gateway`: `hermesGatewayUrl`, `hermesDashboardToken`, `publicApiUrl`.
- `webhook`: `webhookUrl`.
- `openclaw`: `openclawUrl`.

### Phase 1-7 Functional Baseline

Implemented:

- Authentication, signup/login/logout, cookie session, validation error formatting.
- Kanban task CRUD with UUID, one stage per task, detail drawer, logs, comments, sub-tasks, delete, run, review.
- Agent CRUD, department membership, O-chart reporting line, pause/resume/fire/reset session.
- Runtime registry for mock, Hermes Portainer, Hermes HTTP API, Webhook, and OpenClaw.
- Dispatch heartbeat with global interval and company-specific interval/enable switch.
- Automatic assignment for `backlog` and `todo` tasks, with department/tag/capability scoring.
- Prompt context injection for company mission, project, goal, comments, and matching knowledge docs.
- Task lifecycle logs and API lifecycle logs with sensitive-key redaction.
- Company settings, department setup, budget view, logs view, knowledge view, workspace/project/goal view, dashboard.

Production hardening still needed:

- Atomic execution locks and stale-lock recovery.
- Dedicated async worker/queue for long-running Hermes jobs.
- Runtime health checks, versions, capabilities, and offline routing.
- Immutable event bus separate from task/API logs.
- Strong endpoint-level multi-company isolation.
- Secret encryption or external secret references for adapter credentials.
- Git worktree/branch/commit/merge workflow.
- Work products and attachments.
- Approval queue UI and richer budget policy enforcement.

### Latest Verification

Local verification completed on 2026-06-05:

- `npm run typecheck`
- `npm test`
- `npm run build`
- `docker compose up -d --build`
- Authenticated API smoke for runtime, department, agent, project, goal, knowledge doc, task, comment, manual run, dashboard, and logs.
- Web route smoke for `/dashboard`, `/kanban`, `/agents`, `/budget`, `/logs`, `/knowledge`, `/workspaces`, and `/settings`.

## Architecture Update v0.5 - Phase 8-9 Execution Safety and Governance

Date: 2026-06-05

### Phase 8: Execution Safety

MegaCorps now records every adapter run in `heartbeat_runs` and requires a task-level execution lock before an adapter can run.

Card lock fields:

- `execution_lock_id`
- `execution_locked_by_agent_id`
- `execution_locked_at`
- `execution_lock_expires_at`
- `active_heartbeat_run_id`

Dispatch flow:

1. Load task and assignee.
2. Run dependency and budget preflight checks.
3. Atomically mark the agent busy.
4. Insert a `heartbeat_runs` row.
5. Atomically acquire the task lock.
6. Move the task to `in_progress`.
7. Execute the adapter.
8. Record cost, output, stage, activity, and approval state.
9. Release the lock and close the heartbeat run.

If the adapter returns `success: false`, the task now enters retry/block handling instead of being marked done.
The dispatch loop also recovers expired locks and returns stale `in_progress` work to `todo`.

### Phase 9: Governance and Budget

Governance tables:

- `activity_log`: immutable product-level audit trail.
- `cost_events`: immutable cost records.
- `budget_policies`: company or agent scoped budget rules.
- `approvals`: pending/approved/rejected/cancelled approval records.

Budget behavior:

- Agent monthly budget and budget policies are both enforced.
- Per-task limits are checked after a run records cost.
- Monthly hard stops pause agents and create `budget_override_required` approvals.
- Budget warnings and hard stops are visible in task logs and activity logs.

Approval behavior:

- Tasks with `requiresApproval` or a reviewer move to `in_review`.
- A pending approval record is created.
- Reviewer approval/rejection resolves the approval.
- Board users can approve/reject from the Budget page.

### UI Update

- Added a dedicated `Companies` sidebar page for company registry, company settings, department settings, reporting structure, and lifecycle closure.
- Kanban columns are desktop grid / mobile single-column.
- Task detail panel becomes a full-width mobile sheet.
- Agent creation form uses responsive auto-fit tracks instead of a fixed 8-column grid.
- Org chart nodes collapse to one column on narrow viewports.
- Budget page now includes policy creation, pending approvals, and cost events.
- Logs page now includes activity and heartbeat run streams.

### Hierarchy Closure Update

The O-chart hierarchy is controlled by `agents.boss_id`, not by fixed role names.

- Member identity labels are free text.
- Clicking a member opens its reports-to relation and direct reports.
- Decomposition delegates sub-tasks to direct reports when available.
- Completed subordinate work goes to the reporting manager for review by default.
- This creates the desired loop: top-level member delegates downward, leaf members execute, middle members review/modify, and closure propagates upward through parent cards and approvals.

> AI Agent 團隊編排與管理平台
> 調度層 + 任務板 = MegaCorps Core
> Agent 執行層 = 多種 Agent 後端（Hermes / OpenClaw / ...）
> 最後更新：2026-06-04

---

## 目錄

1. [核心層級架構](#1-核心層級架構)
2. [調用 Hermes Agent 機制](#2-調用-hermes-agent-機制)
3. [Agent Profile 管理](#3-agent-profile-管理)
4. [Kanban Task Board](#4-kanban-task-board)
5. [Agent API Layer（多後端）](#5-agent-api-layer多後端)
6. [Dispatch Engine](#6-dispatch-engine)
7. [共享工作區 (Shared Workspace)](#7-共享工作區-shared-workspace)
8. [Card Comments（Agent 間對話）](#8-card-commentsagent-間對話)
9. [Knowledge Base（公司知識庫）](#9-knowledge-base公司知識庫)
10. [Smart Assignment（智能派工）](#10-smart-assignment智能派工)
11. [Event Bus + Notification](#11-event-bus--notification)
12. [Web UI 設計](#12-web-ui-設計)
13. [User System](#13-user-system)
14. [Database Schema](#14-database-schema)
15. [技術棧](#15-技術棧)
16. [實施路線圖](#16-實施路線圖)

---

## 1. 核心層級架構

```
L1 集團 (Group)
 └─ L2 企業 (Company)          ← Mission / Goal
      └─ L3 部門 (Department)   ← Org Chart + Kanban Board
           └─ L4 員工 (Agent)   ← Profile / Budget / Session Memory
```

- **L1 集團**：最上層，可以有多個集團，完全資料隔離
- **L2 企業**：屬於某集團，有自己的 Mission / Goal / Knowledge Base
- **L3 部門**：屬於某企業，部門內有 Org Chart + 獨立 Kanban Board
- **L4 員工**：Agent 個體，有 Profile / Budget / 多後端支援

---

## 2. 調用 Hermes Agent 機制

> ⚠️ **最核心的橋樑** — MegaCorps 與 Hermes 之間的唯一介面

### 2.1 基本原理

MegaCorps 透過 **Portainer API** 對 `hermes-suite` 容器執行 `hermes chat` 指令，以 **single-query mode (-q)** 讓 Agent 執行一次性任務。

```
MegaCorps ──[Portainer API]──> hermes-suite container
                                 │
                                 ▼
                    hermes chat -q --profile=alice "<task>"
                                 │
                                 ▼
                    Agent 使用 tools/skills 執行任務
                                 │
                                 ▼
                    stdout + exit code ──> MegaCorps parse ──> DB
```

### 2.2 核心 Command

```bash
hermes chat -q \
  --profile=<agent_name> \
  --resume <session_id> \
  --reasoning-effort medium \
  --max-turns 60 \
  "<task_prompt>"
```

| 參數 | 說明 |
|---|---|
| `-q` | Single-query mode：執行完退出 |
| `--profile` | Agent profile（`/opt/data/profiles/<name>/`）|
| `--resume` | Session ID，跨任務續接記憶 |
| `--reasoning-effort` | low / medium / high |
| `--max-turns` | 最大 tool call 次數（防失控 loop）|

### 2.3 Session 管理（Agent 記憶連續性）

Session 不是單次性，而是跨任務延續的：

```
Agent "Alice" Session "abc123"
  ├─ Task 1: 設計 DB schema      (turn 1-15)   ← 記住了
  ├─ Task 2: 寫 API endpoint     (turn 16-30)  ← 還記得 schema
  ├─ Task 3: debug 測試           (turn 31-50)  ← 全部記得
  └─ Session full → 開新 session "abc456"
```

MegaCorps DB 存每個 Agent 的 `current_session_id`，每次 dispatch 自動帶上 `--resume`。

### 2.4 Portainer API 調用（TypeScript）

```typescript
async function portainerExec(
  containerId: string,
  cmd: string[],
  timeoutSec: number = 300
): Promise<ExecResult> {
  const jwt = await getPortainerJWT();
  
  // 1. Create exec
  const execResp = await fetch(`${PORTAINER_URL}/api/endpoints/${ENDPOINT_ID}/docker/containers/${containerId}/exec`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ Cmd: cmd, AttachStdout: true, AttachStderr: true }),
  });
  const { Id: execId } = await execResp.json();
  
  // 2. Start exec (with timeout)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  
  const startResp = await fetch(`${PORTAINER_URL}/api/endpoints/${ENDPOINT_ID}/docker/exec/${execId}/start`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ Detach: false, Tty: false }),
    signal: controller.signal,
  });
  clearTimeout(timer);
  
  const raw = await startResp.text();
  return parseDockerExecOutput(raw);
}
```

---

## 3. Agent Profile 管理

Hermes Profile 結構（每個 Agent 一份）：

```
/opt/data/profiles/<agent_slug>/
├── SOUL.md          ← Agent 性格定義
├── MEMORY.md        ← 長期記憶（Hermes 自動管理）
├── config.yaml      ← Agent 專屬設定（覆蓋全局）
├── skills/          ← Agent 專屬 skills
└── memory/          ← Daily memory（Hermes 自動管理）
```

MegaCorps 可以透過 Portainer exec 管理 Profile：建立、編輯 SOUL.md、同步 skills。

---

## 4. Kanban Task Board

> 對標 Hermes Kanban 簡潔風格，不做 Paperclip 複雜 issue 系統。

### 4.1 一個部門 = 一個 Board

```
┌─────────────────────────────────────────────────────────┐
│  Engineering Department                    Filter ▼     │
│                                                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │ Backlog  │ │   Todo   │ │In Progre.│ │  Done ✓  │  │
│  │          │ │          │ │          │ │          │  │
│  │ ┌──────┐ │ │ ┌──────┐ │ │ ┌──────┐ │ │ ┌──────┐ │  │
│  │ │Card A│ │ │ │Card C│→│ │ │Card D│ │ │ │Card B│ │  │
│  │ │      │ │ │ │👤Bob │ │ │ │👤Alice│ │ │ │  ✓   │ │  │
│  │ └──────┘ │ │ └──────┘ │ │ └──────┘ │ │ └──────┘ │  │
│  │ ┌──────┐ │ │ ┌──────┐ │ │          │ │          │  │
│  │ │Card E│ │ │ │Card F│ │ │          │ │          │  │
│  │ │      │ │ │ │👤Carol│ │ │          │ │          │  │
│  │ └──────┘ │ │ └──────┘ │ │          │ │          │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘  │
│                                                         │
│  Also: In Review │ Blocked                              │
└─────────────────────────────────────────────────────────┘
```

### 4.2 Card 欄位

```typescript
interface KanbanCard {
  id: string;
  title: string;
  body: string;                     // Markdown 任務描述
  column: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'blocked';
  priority: 0 | 1 | 2 | 3;         // 0=normal, 3=urgent
  tags: string[];
  
  // Assignment
  assignee_id: string | null;
  reviewer_id: string | null;
  department_id: string;
  
  // Hierarchy
  parent_card_id: string | null;    // CEO 拆解後的 parent
  child_card_ids: string[];
  dependency_card_ids: string[];    // 必須先完成的 cards
  
  // Cost
  budget_limit_usd: number | null;
  cost_usd: number;
  tokens_used: number;
  
  // Execution
  session_id: string | null;
  retry_count: number;
  max_retries: number;
  timeout_seconds: number;
  
  // Timestamps
  created_by: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}
```

### 4.3 Card 狀態流轉

```
backlog → todo → in_progress → in_review → done
                     ↑              │
                     └── reject ────┘
                     
              retry >= max → blocked（需人工介入）
```

---

## 5. Agent API Layer（多後端）

### 5.1 Adapter Interface

```typescript
interface AgentAdapter {
  type: string;
  testConnection(agent: Agent): Promise<ConnectionTest>;
  execute(agent: Agent, task: TaskContext): Promise<TaskResult>;
  getCapabilities(agent: Agent): Promise<Capability[]>;
}

interface TaskContext {
  card_id: string;
  title: string;
  body: string;
  session_id: string | null;
  workspace_dir: string;
  budget_limit_usd: number | null;
  timeout_seconds: number;
  max_turns: number;
  project_context?: string;
  knowledge_base?: string;         // 自動注入的 KB 內容
  previous_cards_summary?: string;
}

interface TaskResult {
  success: boolean;
  output: string;
  error?: string;
  session_id: string;
  tokens_used: number;
  cost_usd: number;
  duration_seconds: number;
  files_modified?: string[];
}
```

### 5.2 已規劃 Adapters

| Adapter | 調用方式 | 適用場景 |
|---|---|---|
| `hermes` | Portainer API → `hermes chat -q` | 主力 Agent |
| `openclaw` | sessions_spawn / sessions_send | Mea 子任務 |
| `claude_code` | CLI spawn | Coding 任務 |
| `cursor` | CLI spawn | IDE 整合 |
| `webhook` | HTTP POST → 等 callback | 外部服務 |

### 5.3 Adapter Registry

```typescript
const adapters = new Map<string, AgentAdapter>();
adapters.set('hermes', new HermesAdapter());
adapters.set('openclaw', new OpenClawAdapter());
adapters.set('claude_code', new ClaudeCodeAdapter());
adapters.set('webhook', new WebhookAdapter());
```

---

## 6. Dispatch Engine

### 6.1 完整流程

```
Request 進入
  │
  ▼
1. 創建 Card (backlog)
  │
  ▼
2. CEO Decomposition（if 大任務）
   CEO Agent 拆解 → N 張 sub-cards (todo)
  │
  ▼
3. Dispatch Loop（Cron 每 30s）
   掃描 todo cards → 檢查 dependencies/idle/budget
  │
  ▼
4. Smart Assignment（選最合適的 Agent）
  │
  ▼
5. Agent Execution（選對的 Adapter → dispatch）
  │
  ├─ success → in_review (if reviewer) or done
  ├─ fail → retry or blocked
  └─ timeout → retry or blocked
  │
  ▼
6. Review（QA agent 或人類審批）
   pass → done / fail → back to todo
  │
  ▼
7. Cascade（sub-cards 全 done → parent done → 通知）
```

---

## 7. 共享工作區 (Shared Workspace)

### 7.1 設計

每個 **Project** 有一個共享 git repo 作為工作區：

```
/workspaces/<company_slug>/<project_slug>/
├── .git/
├── src/
├── docs/
└── ...
```

### 7.2 分支策略

```
main ← 穩定版
  ├─ agent/alice-ceo/card-123      ← Alice 的工作分支
  ├─ agent/bob-engineer/card-456   ← Bob 的工作分支
  └─ agent/carol-qa/card-789      ← Carol 的 review 分支
```

- Agent 開始工作 → 自動建 branch
- Agent 完成 → 自動 merge request
- Review pass → merge to main
- Review fail → 退回修改

### 7.3 Workspace 注入

Dispatch 時自動：
1. `git checkout -b agent/<slug>/card-<id>` from main
2. 把 branch 路徑傳給 Agent prompt
3. Agent 在 branch 上工作
4. 完成後 commit + push

---

## 8. Card Comments（Agent 間對話）

### 8.1 設計

每張 Card 有一條 comment thread，Agent 可以互相對話：

```typescript
interface CardComment {
  id: string;
  card_id: string;
  author_type: 'agent' | 'user';
  author_id: string;
  body: string;                    // Markdown
  created_at: string;
}
```

### 8.2 用途

- Engineer 問 CEO：「這個需求不清楚」
- QA 對 Engineer 說：「test case 3 failed，修一下」
- 人類（哥哥）留言：「改用 WebSocket 不要 polling」
- Agent 回報進度：「完成 60%，正在寫 test」

### 8.3 觸發機制

當 comment 被加到某 Agent 的 card 上，Dispatch Engine 可以選擇性「喚醒」Agent 回覆：
- Comment 加了 `@alice` → 觸發 Alice session 去讀 comment 並回覆
- 一般 comment → 不觸發，等下次 heartbeat 自然讀取

---

## 9. Knowledge Base（公司知識庫）

### 9.1 設計

每個 Company 有一份 KB（Markdown 文件集合）：

```
/knowledge/<company_slug>/
├── coding-standards.md
├── api-documentation.md
├── architecture-decisions.md
├── onboarding-guide.md
└── ...
```

### 9.2 自動注入

Agent 執行任務時，Dispatch Engine 從 KB 中選取相關文件，注入到 prompt 中：

```
## Company Knowledge (Auto-Injected)
以下是公司的 coding standards，請遵守：
...
```

匹配方式：
- Card tags → KB file tags（例如 tag `api` → 自動注入 `api-documentation.md`）
- 也可以在 Card 上手動指定要注入哪些 KB 文件

### 9.3 Agent 貢獻

Agent 完成任務後，可以建議更新 KB：
- 「我發現 API endpoint naming 沒有統一規範，建議加入 KB」
- MegaCorps 記錄建議 → 人類審批 → 更新 KB

---

## 10. Smart Assignment（智能派工）

### 10.1 當 Card 沒有手動指派 assignee 時

Dispatch Engine 自動選擇最合適的 Agent：

```typescript
function selectBestAgent(card: Card, agents: Agent[]): Agent | null {
  return agents
    .filter(a => a.is_active && !a.is_busy && !a.budget_exceeded)
    .filter(a => matchesCapabilities(card.tags, a.capabilities))
    .sort((a, b) => {
      // 1. Role match (tag "backend" → prefer Engineers)
      const roleA = roleMatchScore(card, a);
      const roleB = roleMatchScore(card, b);
      if (roleA !== roleB) return roleB - roleA;
      
      // 2. Past performance (同類 task 的 success rate)
      const perfA = a.success_rate_for_tags(card.tags);
      const perfB = b.success_rate_for_tags(card.tags);
      if (perfA !== perfB) return perfB - perfA;
      
      // 3. Budget remaining (優先用 budget 充足的)
      return b.budget_remaining - a.budget_remaining;
    })[0] || null;
}
```

---

## 11. Event Bus + Notification

### 11.1 事件類型

| Event | 觸發時機 | 通知對象 |
|---|---|---|
| `card.created` | 新 Card 建立 | Dashboard |
| `card.assigned` | Card 被指派 | Agent |
| `card.started` | Agent 開始執行 | Dashboard |
| `card.completed` | Agent 完成 | Reviewer / Dashboard |
| `card.failed` | 執行失敗 | Board member |
| `card.blocked` | 重試耗盡 | Board member (Signal) |
| `card.review_pass` | Review 通過 | Dashboard |
| `card.review_fail` | Review 退回 | Agent |
| `project.completed` | 所有 Cards 完成 | Board member (Signal) |
| `budget.warning` | 預算到達 80% | Board member |
| `budget.exceeded` | 預算超標 | Board member (Signal) + 暫停 Agent |
| `comment.mention` | @mention 某 Agent | Agent（觸發喚醒）|

### 11.2 通知管道

```typescript
interface NotificationChannel {
  type: 'dashboard' | 'signal' | 'webhook' | 'email';
  target: string;  // Signal: uuid, Webhook: URL, Email: address
}
```

- **Dashboard**: WebSocket 即時推送
- **Signal**: 透過 Mea（sessions_send → message tool）
- **Webhook**: HTTP POST to external URL
- **Email**: 較後期

---

## 12. Web UI 設計

### 12.1 整體 Layout

```
┌──────────────────────────────────────────────────────────────┐
│  TOP BAR                                                      │
│  ┌──────┐  ┌──────────────────────┐  ┌───┐ ┌───┐ ┌────────┐ │
│  │ ≡    │  │ MegaCorps            │  │🌙 │ │🌐 │ │👤 Rick │ │
│  │Toggle│  │ > Auroria Inc > Eng  │  │   │ │i18n│ │▼       │ │
│  └──────┘  └──────────────────────┘  └───┘ └───┘ └────────┘ │
│  Sidebar    Breadcrumb                Dark  Lang   Profile    │
│  Toggle     (Group > Company > Dept)  Mode  Switch Dropdown   │
├──────────┬───────────────────────────────────────────────────┤
│          │                                                    │
│ SIDEBAR  │  MAIN CONTENT AREA                                │
│          │                                                    │
│ ┌──────┐ │  (根據左側選項切換)                                │
│ │🏢    │ │                                                    │
│ │集團  │ │                                                    │
│ │管理  │ │                                                    │
│ ├──────┤ │                                                    │
│ │📊    │ │                                                    │
│ │Dashboard│                                                   │
│ ├──────┤ │                                                    │
│ │📋    │ │                                                    │
│ │Kanban│ │                                                    │
│ ├──────┤ │                                                    │
│ │👥    │ │                                                    │
│ │Org   │ │                                                    │
│ │Chart │ │                                                    │
│ ├──────┤ │                                                    │
│ │💰    │ │                                                    │
│ │Budget│ │                                                    │
│ ├──────┤ │                                                    │
│ │📖    │ │                                                    │
│ │Know- │ │                                                    │
│ │ledge │ │                                                    │
│ ├──────┤ │                                                    │
│ │📁    │ │                                                    │
│ │Work- │ │                                                    │
│ │spaces│ │                                                    │
│ ├──────┤ │                                                    │
│ │📜    │ │                                                    │
│ │Logs  │ │                                                    │
│ ├──────┤ │                                                    │
│ │⚙️    │ │                                                    │
│ │Settings│                                                    │
│ └──────┘ │                                                    │
│          │                                                    │
└──────────┴───────────────────────────────────────────────────┘
```

### 12.2 Top Bar

| 元素 | 位置 | 功能 |
|---|---|---|
| **Sidebar Toggle** | 左上 | 收合/展開 Sidebar（`≡` hamburger icon） |
| **Breadcrumb** | 中左 | 層級導航：Group > Company > Department（可點擊跳轉） |
| **Dark Mode Toggle** | 右側 | 太陽/月亮 icon，切換 Light/Dark（記住偏好到 localStorage + DB） |
| **Language Switch** | 右側 | 下拉選單：繁體中文 / English / 日本語（i18n） |
| **Notification Bell** | 右側 | 鈴鐺 icon + 未讀 badge，點擊展開通知面板 |
| **User Profile** | 最右 | Avatar + 名字，下拉：Profile / Settings / Logout |

### 12.3 Sidebar 內容

| Icon | 項目 | 說明 |
|---|---|---|
| 🏢 | **Group / Company** | 集團/企業切換器（dropdown 或 tree view） |
| 📊 | **Dashboard** | 即時概覽：active tasks、cost、agent status |
| 📋 | **Kanban Board** | 任務看板（drag & drop cards between columns） |
| 👥 | **Org Chart** | 組織架構圖（tree 或 hierarchy view） |
| 💰 | **Budget & Costs** | 預算管理 + 成本報表 |
| 📖 | **Knowledge Base** | 公司知識庫（Markdown 文件管理） |
| 📁 | **Workspaces** | 共享工作區 / Git repo 管理 |
| 📜 | **Activity Log** | 全局事件日誌（時間軸） |
| ⚙️ | **Settings** | 公司設定 / Agent 管理 / API Keys / Notification |

**Sidebar 行為：**
- 預設展開（desktop），收合時只顯示 icon
- Mobile：預設收合，點 hamburger 展開（overlay）
- 收合/展開有滑動動畫（200ms ease-in-out）
- 當前所在頁面的 item 高亮顯示
- Sidebar 底部：版本號 + 「Powered by MegaCorps」

### 12.4 各分頁設計

#### 📊 Dashboard

```
┌─────────────────────────────────────────────────────┐
│ Dashboard                              Last 24h ▼   │
├─────────────────────────────────────────────────────┤
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ │
│  │ Active   │ │ Completed│ │ Failed   │ │ Cost   │ │
│  │ Tasks    │ │ Today    │ │          │ │ Today  │ │
│  │   12     │ │   34     │ │   2      │ │ $4.56  │ │
│  │  ▲ 3     │ │  ▲ 12    │ │  ▼ 1     │ │ ▲ $1.2 │ │
│  └──────────┘ └──────────┘ └──────────┘ └────────┘ │
│                                                      │
│  Agent Status                     Cost Trend (7d)    │
│  ┌─────────────────┐              ┌───────────────┐ │
│  │ 🟢 Alice (CEO)  │              │    ╱──╲       │ │
│  │   idle          │              │ ──╱    ╲──    │ │
│  │ 🔵 Bob (Eng)    │              │          ╲──  │ │
│  │   working       │              │               │ │
│  │ 🟢 Carol (QA)   │              └───────────────┘ │
│  │   idle          │                                 │
│  └─────────────────┘                                 │
│                                                      │
│  Recent Activity (Live)                              │
│  ┌──────────────────────────────────────────────┐   │
│  │ 16:30 ✅ Card "Build API" completed by Bob   │   │
│  │ 16:28 🔄 Card "Write Tests" started by Carol │   │
│  │ 16:25 📋 CEO decomposed "Build App" into 5   │   │
│  │ 16:20 💰 Budget warning: Bob at 82%          │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

**動畫效果：**
- Stat cards: 進場時數字從 0 count up（600ms ease-out）
- Cost trend chart: 線條從左到右繪製（800ms）
- Agent status dots: 狀態變更時 pulse animation
- Activity feed: 新事件從上方 slide in（300ms）
- 整頁：skeleton loading → fade in content（400ms）

#### 📋 Kanban Board

```
┌─────────────────────────────────────────────────────┐
│ Kanban Board                                         │
│ ┌─────────┐  Filter: All ▼  Assignee: All ▼        │
│ │+ New Card│  Tags: [backend] [frontend] [x]         │
│ └─────────┘                                          │
├─────────────────────────────────────────────────────┤
│  拖拽式看板 (Drag & Drop between columns)            │
│                                                      │
│  Cards 支援：                                        │
│  - 拖拽到不同 column（smooth drop animation 200ms）  │
│  - 點擊展開 detail panel（右側 slide-in 300ms）      │
│  - Assignee avatar 顯示在 card 右下角               │
│  - Priority 色帶（urgent=紅, high=橙, normal=無）    │
│  - Sub-task 進度條（3/5 done ████░ 60%）            │
│  - Cost badge（$1.23 spent）                         │
│                                                      │
│  Card Detail Panel (右側滑出):                       │
│  ┌──────────────────────────────────┐               │
│  │ Title: Build REST API            │               │
│  │ Status: In Progress              │               │
│  │ Assignee: 👤 Bob (Engineer)      │               │
│  │ Reviewer: 👤 Carol (QA)          │               │
│  │ Priority: ●● High               │               │
│  │ Budget: $2.00 / $5.00            │               │
│  │ Tags: [backend] [api]            │               │
│  │                                  │               │
│  │ Description (Markdown rendered)  │               │
│  │ ─────────────────────────────── │               │
│  │ Build a REST API for user CRUD   │               │
│  │ endpoints using Express...       │               │
│  │                                  │               │
│  │ Sub-tasks:                       │               │
│  │ ✅ Design schema                 │               │
│  │ 🔄 Write endpoints              │               │
│  │ ⬜ Write tests                   │               │
│  │                                  │               │
│  │ Comments:                        │               │
│  │ ┌────────────────────────────┐  │               │
│  │ │ 👤 Bob: Started working    │  │               │
│  │ │ 👤 Alice: Use PostgreSQL   │  │               │
│  │ │ 💬 Add comment...          │  │               │
│  │ └────────────────────────────┘  │               │
│  │                                  │               │
│  │ Execution Log:                   │               │
│  │ Run 1: ✅ 45s, 1.2k tokens     │               │
│  │ Run 2: ✅ 120s, 3.4k tokens    │               │
│  └──────────────────────────────────┘               │
└─────────────────────────────────────────────────────┘
```

**動畫效果：**
- Drag & Drop: card 跟隨滑鼠 + 目標 column 高亮 + drop 後 settle animation
- Card 展開 detail: 右側 panel slide-in（300ms ease-out）
- 新 card 出現: fade-in + scale from 0.95 to 1.0
- Card 完成 (→ done): 短暫 green flash + confetti particles（subtle）
- Column 計數更新: number morph animation

#### 👥 Org Chart

```
┌─────────────────────────────────────────────────────┐
│ Organization Chart                                   │
│                                                      │
│  View: [Tree] [List] [Grid]     + Add Agent          │
│                                                      │
│              ┌──────────────┐                        │
│              │ 👤 Alice      │                        │
│              │ CEO           │                        │
│              │ 🟢 idle       │                        │
│              │ Budget: $45.2 │                        │
│              └──────┬───────┘                        │
│           ┌─────────┼─────────┐                      │
│           ▼         ▼         ▼                      │
│     ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│     │ 👤 Bob    │ │ 👤 Carol  │ │ 👤 Dave   │          │
│     │ Engineer  │ │ QA Lead  │ │ Designer │          │
│     │ 🔵 busy   │ │ 🟢 idle   │ │ 🟢 idle   │          │
│     └──────────┘ └──────────┘ └──────────┘          │
│                                                      │
│  點擊 Agent → 展開 Agent Detail Panel:              │
│  - Profile info (name, role, title)                  │
│  - Hermes profile path                               │
│  - Budget (used / total)                             │
│  - Session history                                   │
│  - Recent tasks + performance stats                  │
│  - Actions: Edit / Pause / Fire / Reset Session      │
└─────────────────────────────────────────────────────┘
```

**動畫效果：**
- Tree view: 節點展開/收合有 expand/collapse animation（200ms）
- Agent card hover: 輕微 lift + shadow（150ms）
- 狀態變更: dot color transition（300ms）
- 連接線: SVG 繪製動畫（首次載入 500ms）

#### 💰 Budget & Costs

```
┌─────────────────────────────────────────────────────┐
│ Budget & Costs                   Period: June 2026 ▼│
│                                                      │
│  Total Spent: $123.45          Budget: $500.00       │
│  ████████████████░░░░░░░░░░░░░░ 24.7%               │
│                                                      │
│  By Agent:                                           │
│  Alice    ████████░░░░ $45.20 / $100   (45%)        │
│  Bob      ████████████ $62.10 / $80    (78%) ⚠️     │
│  Carol    ███░░░░░░░░░ $12.30 / $100   (12%)        │
│  Dave     ████░░░░░░░░ $3.85 / $50     (8%)         │
│                                                      │
│  Cost by Day (Bar Chart):                            │
│  Mon ████                                            │
│  Tue ██████████                                      │
│  Wed ████████                                        │
│  Thu ██████ (today)                                  │
│                                                      │
│  Recent Cost Events:                                 │
│  16:30 Bob: +$0.45 (Card "Build API" run 3)         │
│  16:28 Alice: +$0.12 (Card "Review spec")           │
└─────────────────────────────────────────────────────┘
```

#### 📖 Knowledge Base

```
┌─────────────────────────────────────────────────────┐
│ Knowledge Base                     + New Document    │
│ ┌──────────────┐  ┌────────────────────────────────┐│
│ │ Files        │  │ coding-standards.md             ││
│ │              │  │ ─────────────────────────────── ││
│ │ 📄 coding-  │  │                                  ││
│ │   standards  │  │ # Coding Standards               ││
│ │ 📄 api-docs │  │                                  ││
│ │ 📄 arch-    │  │ ## Naming Conventions             ││
│ │   decisions │  │ - Use camelCase for variables     ││
│ │ 📄 onboard  │  │ - Use PascalCase for classes      ││
│ │              │  │ ...                               ││
│ │              │  │                                  ││
│ │ Tags:       │  │ [Edit] [Preview] [History]        ││
│ │ [backend]   │  │                                  ││
│ │ [frontend]  │  │ Auto-inject for tags:             ││
│ │ [api]       │  │ [backend] [api]                   ││
│ └──────────────┘  └────────────────────────────────┘│
└─────────────────────────────────────────────────────┘
```

#### 📜 Activity Log

```
┌─────────────────────────────────────────────────────┐
│ Activity Log                    Filter: All ▼        │
│                                                      │
│  Timeline view (infinite scroll):                    │
│                                                      │
│  16:30 ── ✅ Card "Build API" completed              │
│           by Bob (Engineer) · 120s · $0.45           │
│                                                      │
│  16:28 ── 🔄 Card "Write Tests" dispatched           │
│           to Carol (QA) · auto-assigned              │
│                                                      │
│  16:25 ── 📋 CEO decomposed "Build App"              │
│           into 5 sub-tasks                           │
│                                                      │
│  16:20 ── ⚠️ Budget warning                          │
│           Bob at 82% ($62.10 / $80.00)               │
│                                                      │
│  16:15 ── 💬 Comment on Card "Design DB"             │
│           Alice: "Use PostgreSQL, not MySQL"         │
└─────────────────────────────────────────────────────┘
```

**全局動畫效果：**
- Page transition: 淡入淡出（300ms fade）
- Skeleton loading: pulse animation → content fade-in
- 數字變更: count-up / morph transition
- Toast notifications: 右上角 slide-in + auto-dismiss（5s）
- Modal dialogs: backdrop blur + scale-in content（200ms）

### 12.5 i18n（國際化）

```typescript
// 支援語言
const locales = {
  'zh-TW': '繁體中文',
  'en':    'English',
  'ja':    '日本語',
};

// 翻譯 key 格式
{
  "nav.dashboard": "儀表板",
  "nav.kanban": "任務看板",
  "nav.orgChart": "組織架構",
  "nav.budget": "預算管理",
  "card.status.backlog": "待辦",
  "card.status.todo": "排隊中",
  "card.status.in_progress": "進行中",
  "card.status.in_review": "審查中",
  "card.status.done": "完成",
  "card.status.blocked": "卡住",
  // ...
}
```

使用 `next-intl` 或 `react-i18next`。語言偏好存在 User Profile DB + cookie。

### 12.6 Light / Dark Mode

```css
/* CSS Variables 方式 */
:root[data-theme="light"] {
  --bg-primary: #ffffff;
  --bg-secondary: #f8f9fa;
  --text-primary: #1a1a2e;
  --text-secondary: #6c757d;
  --accent: #4361ee;
  --card-bg: #ffffff;
  --card-shadow: 0 2px 8px rgba(0,0,0,0.08);
  --sidebar-bg: #f0f2f5;
  --border: #e2e8f0;
}

:root[data-theme="dark"] {
  --bg-primary: #0f0f23;
  --bg-secondary: #1a1a2e;
  --text-primary: #e2e8f0;
  --text-secondary: #94a3b8;
  --accent: #818cf8;
  --card-bg: #1e1e32;
  --card-shadow: 0 2px 8px rgba(0,0,0,0.3);
  --sidebar-bg: #16162a;
  --border: #2d2d44;
}
```

- Toggle: 太陽/月亮 icon in Top Bar
- Transition: 全局 `transition: background-color 300ms, color 300ms`
- 偏好: 存 localStorage + User Profile DB
- 預設: 跟隨系統 `prefers-color-scheme`

---

## 13. User System

### 13.1 角色

| 角色 | 權限 |
|---|---|
| **Owner** | 最高權限：管理集團、企業、所有設定 |
| **Admin** | 管理企業內所有資源 |
| **Board Member** | 審批、查看 Dashboard、管理 Agent |
| **Viewer** | 只能看 Dashboard 和 Kanban |

### 13.2 Auth Flow

```
┌──────────────────────────────────────┐
│ Login / Sign Up                      │
│                                      │
│  ┌────────────────────────────────┐  │
│  │    MegaCorps                   │  │
│  │                                │  │
│  │    Email:    [             ]   │  │
│  │    Password: [             ]   │  │
│  │                                │  │
│  │    [  Login  ]                 │  │
│  │                                │  │
│  │    ─── or ───                  │  │
│  │                                │  │
│  │    [G] Sign in with Google     │  │
│  │    [🔑] Sign in with Passkey   │  │
│  │                                │  │
│  │    Don't have an account?      │  │
│  │    Sign up                     │  │
│  └────────────────────────────────┘  │
│                                      │
│  Dark mode toggle in corner          │
└──────────────────────────────────────┘
```

**Auth Stack:**
- **NextAuth.js** 或 **Lucia Auth**
- Email + Password（default）
- OAuth: Google（optional）
- Passkey / WebAuthn（optional, 進階）
- JWT session（httpOnly cookie）
- CSRF protection

### 13.3 User DB

```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT,
    avatar_url TEXT,
    role TEXT DEFAULT 'viewer',
    locale TEXT DEFAULT 'zh-TW',
    theme TEXT DEFAULT 'system',     -- 'light' | 'dark' | 'system'
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE user_memberships (
    user_id UUID NOT NULL REFERENCES users(id),
    company_id UUID NOT NULL REFERENCES companies(id),
    role TEXT NOT NULL DEFAULT 'viewer',  -- 'owner' | 'admin' | 'board_member' | 'viewer'
    PRIMARY KEY (user_id, company_id)
);
```

---

## 14. Database Schema（完整）

```sql
-- L1: Groups
CREATE TABLE groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- L2: Companies
CREATE TABLE companies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES groups(id),
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    mission TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(group_id, slug)
);

-- L3: Departments
CREATE TABLE departments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id),
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(company_id, slug)
);

-- L4: Agents
CREATE TABLE agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id),
    department_id UUID REFERENCES departments(id),
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    title TEXT,
    adapter_type TEXT NOT NULL DEFAULT 'hermes',
    adapter_config JSONB DEFAULT '{}',
    hermes_profile TEXT,
    boss_id UUID REFERENCES agents(id),
    budget_per_task NUMERIC(10,4),
    budget_monthly NUMERIC(10,4),
    spent_this_month NUMERIC(10,4) DEFAULT 0,
    capabilities TEXT[] DEFAULT '{}',
    is_busy BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    current_session_id TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(company_id, slug)
);

-- L5: Kanban Cards
CREATE TABLE kanban_cards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id),
    department_id UUID REFERENCES departments(id),
    project_id UUID REFERENCES projects(id),
    goal_id UUID REFERENCES goals(id),
    parent_card_id UUID REFERENCES kanban_cards(id),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    column_status TEXT DEFAULT 'backlog',
    priority INTEGER DEFAULT 0,
    tags TEXT[] DEFAULT '{}',
    assignee_id UUID REFERENCES agents(id),
    reviewer_id UUID REFERENCES agents(id),
    dependency_card_ids UUID[] DEFAULT '{}',
    requires_approval BOOLEAN DEFAULT false,
    session_id TEXT,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    timeout_seconds INTEGER DEFAULT 300,
    budget_limit_usd NUMERIC(10,4),
    cost_usd NUMERIC(10,6) DEFAULT 0,
    tokens_used INTEGER DEFAULT 0,
    created_by UUID REFERENCES users(id),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Card Comments
CREATE TABLE card_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    card_id UUID NOT NULL REFERENCES kanban_cards(id),
    author_type TEXT NOT NULL,  -- 'agent' | 'user'
    author_id UUID NOT NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Task Logs
CREATE TABLE task_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    card_id UUID NOT NULL REFERENCES kanban_cards(id),
    agent_id UUID REFERENCES agents(id),
    event_type TEXT NOT NULL,
    output TEXT,
    stderr TEXT,
    exit_code INTEGER,
    duration_seconds NUMERIC(10,2),
    tokens_used INTEGER,
    cost_usd NUMERIC(10,6),
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Projects
CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id),
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT,
    workspace_path TEXT,
    status TEXT DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(company_id, slug)
);

-- Goals
CREATE TABLE goals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id),
    project_id UUID REFERENCES projects(id),
    title TEXT NOT NULL,
    description TEXT,
    parent_goal_id UUID REFERENCES goals(id),
    status TEXT DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Knowledge Base
CREATE TABLE knowledge_docs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id),
    title TEXT NOT NULL,
    slug TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT[] DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(company_id, slug)
);

-- Events / Activity Log
CREATE TABLE events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id),
    event_type TEXT NOT NULL,
    entity_type TEXT,
    entity_id UUID,
    actor_type TEXT,   -- 'agent' | 'user' | 'system'
    actor_id UUID,
    data JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Users (see User System section)
CREATE TABLE users (...);
CREATE TABLE user_memberships (...);

-- Cost Events
CREATE TABLE cost_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id),
    agent_id UUID REFERENCES agents(id),
    card_id UUID REFERENCES kanban_cards(id),
    tokens_used INTEGER,
    cost_usd NUMERIC(10,6),
    model TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);
```

---

## 15. 技術棧

| 層 | 技術 |
|---|---|
| **Backend** | Node.js + TypeScript + Fastify |
| **ORM** | Drizzle ORM |
| **DB** | PostgreSQL (TrueNAS) |
| **Frontend** | Next.js 15 + React 19 + TypeScript |
| **Styling** | Tailwind CSS + shadcn/ui |
| **Animation** | Framer Motion |
| **Drag & Drop** | @dnd-kit/core |
| **Charts** | Recharts or Tremor |
| **i18n** | next-intl |
| **Auth** | NextAuth.js or Lucia Auth |
| **WebSocket** | Socket.io (Dashboard 即時更新) |
| **Queue** | BullMQ + Redis (較後期) |
| **Hermes 橋接** | Portainer API (Docker exec) |
| **OpenClaw 橋接** | sessions_spawn / sessions_send |
| **Deploy** | Docker on TrueNAS |
| **Monorepo** | Turborepo (apps/web + apps/server + packages/shared) |

---

## 16. 開發路線圖 (Development Roadmap)

```
Phase 1 ──▶ Phase 2 ──▶ Phase 3 ──▶ Phase 4 ──▶ Phase 5
基礎建設     任務看板     Agent系統     自動調度     預算治理
  3-4天       4-5天       4-5天        3-4天       3-4天

Phase 6 ──▶ Phase 7 ──▶ Phase 8 ──▶ Phase 9
協作功能     監控儀表板   異步擴展     多租戶打磨
  4-5天       3-4天       4-5天       持續迭代

                    MVP
           ┌────────────────┐
           │ Phase 1 + 2 + 3│  ← 能用的最小版本
           └────────────────┘
                  ~12天
```

---

### Phase 1: Foundation（基礎建設）— 3-4 天

> 目標：專案骨架搭好，能登入、能看到空殼 UI

**Backend:**
- [ ] Monorepo 初始化（Turborepo：`apps/web` + `apps/server` + `packages/shared`）
- [ ] Fastify server 搭建 + TypeScript 配置
- [ ] PostgreSQL 連線 + Drizzle ORM 設定
- [ ] DB migration：`users` / `groups` / `companies` / `departments` 基礎表
- [ ] Auth 系統（NextAuth.js / Lucia）：Email + Password 登入/註冊
- [ ] JWT session + httpOnly cookie
- [ ] API middleware：auth guard + error handling + request logging

**Frontend:**
- [ ] Next.js 15 + React 19 + TypeScript + Tailwind CSS 初始化
- [ ] shadcn/ui 元件庫安裝
- [ ] 全局 Layout：Sidebar（可收合）+ Top Bar + Main Content Area
- [ ] Dark / Light Mode（CSS variables + localStorage + `prefers-color-scheme`）
- [ ] i18n 框架（next-intl）：繁中 / English / 日本語
- [ ] Login / Sign Up 頁面
- [ ] Skeleton loading + page transition 動畫（Framer Motion）
- [ ] Toast notification 元件

**交付物：**
- 能登入/註冊
- 空殼 Dashboard 頁面（有 Sidebar + Top Bar + Dark Mode + i18n）
- Docker Compose for dev（PostgreSQL + Redis + Server + Web）

---

### Phase 2: Kanban Task Board（任務看板）— 4-5 天

> 目標：能建立 Card、拖拽移動、查看詳情

**Backend:**
- [ ] DB migration：`kanban_cards` / `projects` / `goals` 表
- [ ] Card CRUD API：POST / GET / PUT / DELETE `/api/cards`
- [ ] Card 狀態流轉邏輯：backlog → todo → in_progress → in_review → done / blocked
- [ ] Card filtering / sorting / pagination API
- [ ] Project CRUD API

**Frontend:**
- [ ] Kanban Board 頁面（6 欄：Backlog / Todo / In Progress / In Review / Done / Blocked）
- [ ] Drag & Drop 實作（@dnd-kit/core）
  - Card 跟隨滑鼠 + 目標 column 高亮
  - Drop 後 settle animation（200ms）
  - 觸控設備支援
- [ ] Card 元件設計
  - 標題 / assignee avatar / priority 色帶 / tags / cost badge
  - Sub-task 進度條
- [ ] Card Detail Panel（右側 slide-in，300ms）
  - 完整描述（Markdown rendered）
  - Sub-tasks list
  - Execution log
  - Metadata（created_at / started_at / cost）
- [ ] New Card Modal（建立新 Card）
- [ ] Filter bar（by status / assignee / tags / priority）

**動畫：**
- [ ] Card drag: smooth follow + column highlight
- [ ] Card drop: settle animation
- [ ] New card: fade-in + scale 0.95→1.0
- [ ] Card done: green flash
- [ ] Column count: number morph

**交付物：**
- 能建立、編輯、刪除 Card
- 能拖拽 Card 到不同 column
- 能查看 Card 詳情

---

### Phase 3: Agent System + Hermes Integration（Agent 系統）— 4-5 天

> 目標：能建立 Agent、看到 Org Chart、成功派任務給 Hermes

**Backend:**
- [ ] DB migration：`agents` / `agent_runtimes` 表
- [ ] Agent CRUD API：POST / GET / PUT / DELETE `/api/agents`
- [ ] Agent Runtime 管理 API
- [ ] **Hermes Adapter 實作**（核心！）
  - Portainer API 連線模組
  - `hermes chat -q --profile=<agent> --resume <session_id> "<prompt>"` 執行
  - stdout / stderr parsing
  - Session ID 解析 + 存入 DB
  - Timeout handling
- [ ] Adapter Registry（hermes / openclaw / webhook）
- [ ] Agent testConnection API（驗證 Hermes 環境）
- [ ] Card ↔ Agent 指派 API

**Frontend:**
- [ ] Org Chart 頁面
  - Tree view（SVG 連接線 + 節點卡片）
  - 節點展開/收合動畫（200ms）
  - Agent 狀態指示燈（🟢 idle / 🔵 busy / 🔴 offline）
- [ ] Agent Detail Panel
  - Profile info / role / title
  - Hermes profile path
  - Budget（used / total）
  - Recent tasks + performance
  - Actions：Edit / Pause / Fire / Reset Session
- [ ] New Agent Modal
  - 選擇 adapter type
  - 填寫 profile name / role / boss
- [ ] Kanban Board 整合：Card 上顯示 assignee，可在 detail panel 指派

**交付物：**
- 能建立 Hermes Agent（連接到 TrueNAS 上的 hermes-suite）
- 能在 Kanban 指派 Card 給 Agent
- 能手動觸發一次 dispatch（點 Card → Run → 看到 Hermes 執行結果）
- ⭐ **MVP 達成！** 最小可用版本完成

---

### Phase 4: Dispatch Engine + Review Loop（自動調度）— 3-4 天

> 目標：自動巡邏 pending cards、派任務、重試、review loop

**Backend:**
- [ ] DB migration：`task_logs` 表
- [ ] Dispatch Loop（server-side cron，每 30s）
  - 掃描 `column = 'todo'` 且 dependencies met 的 cards
  - 檢查 agent idle + budget OK
  - 鎖定 card → dispatch → 更新狀態
- [ ] Retry 機制
  - 失敗 → retry_count++ → back to todo
  - retry >= max_retries → blocked
  - Exponential backoff（10s, 20s, 40s...）
- [ ] Review Loop
  - Card 完成 → 如果有 reviewer → column = 'in_review'
  - Reviewer agent 執行 review → pass or reject
  - Reject → back to todo（帶 review feedback）
- [ ] CEO Decomposition
  - 大任務 card → 派給 CEO agent → 拆成 N 張 sub-cards
  - parent_card_id 關聯
  - Sub-cards 全部 done → parent card done
- [ ] Cascade Logic（sub-tasks 完成 → parent 完成 → 通知）
- [ ] Prompt 模板系統（buildTaskPrompt：注入 project context + goal + previous work）

**Frontend:**
- [ ] Card detail：Execution Log tab（顯示每次 run 的 output / cost / duration）
- [ ] Card status badge 即時更新
- [ ] Sub-task 樹狀顯示（parent card 裡看所有 children）
- [ ] Manual dispatch button（Card detail → "Run Now"）

**交付物：**
- Cards 自動被 dispatch 給 agents
- 失敗自動重試
- Review loop 運作
- CEO 能拆解大任務

---

### Phase 5: Budget & Governance（預算與治理）— 3-4 天

> 目標：成本追蹤、預算上限、人類審批

**Backend:**
- [ ] DB migration：`cost_events` / `budget_policies` 表
- [ ] Cost tracking：每次 agent 執行後記錄 tokens / cost_usd
- [ ] Agent monthly budget：`spent_this_month` 自動累加
- [ ] Budget guardrails
  - Warning at 80%（event + notification）
  - Hard stop at 100%（agent 自動暫停，不再 dispatch）
  - Per-card budget limit
- [ ] Approval workflow
  - Card `requires_approval = true` → 完成後等人類審批
  - Approve / Reject API
- [ ] Governance actions：Pause agent / Resume agent / Fire agent（is_active = false）
- [ ] Monthly budget reset cron（每月 1 號歸零 spent_this_month）

**Frontend:**
- [ ] Budget & Costs 頁面
  - 總 spent / 總 budget 進度條
  - Per-agent budget bars（⚠️ warning 高亮）
  - Cost by day bar chart（Recharts）
  - Recent cost events table
- [ ] Approval queue（待審批 cards 列表）
- [ ] Agent actions：Pause / Resume / Fire 按鈕

**交付物：**
- 每次執行有成本記錄
- Agent 超支自動暫停
- 人類可以審批重要任務

---

### Phase 6: Collaboration（協作功能）— 4-5 天

> 目標：Agent 間對話、知識庫、共享工作區

**Backend:**
- [ ] DB migration：`card_comments` / `knowledge_docs` 表
- [ ] Card Comments CRUD API
  - `@mention` agent → 觸發 agent 喚醒回覆
- [ ] Knowledge Base CRUD API
  - Markdown 文件管理
  - Tag-based auto-injection（card tags → KB docs）
- [ ] Context Manager
  - `context_snapshots` 表：備份每次執行的 prompt + output
  - buildTaskPrompt 自動注入：KB + related cards + comments + goal
- [ ] Shared Workspace
  - Project workspace 初始化（git init）
  - Agent branch 管理（auto checkout/commit/merge）

**Frontend:**
- [ ] Card Detail → Comments tab
  - 按時間排列的對話
  - Markdown 支援
  - @mention agent autocomplete
- [ ] Knowledge Base 頁面
  - 左側文件列表 + 右側 Markdown 編輯器/預覽
  - Tag 管理
  - Auto-inject 設定
- [ ] Workspaces 頁面
  - Project workspace list
  - Branch status overview
  - File browser（read-only）

**交付物：**
- Agent 可以在 card 上留言互動
- 公司有共享知識庫
- Agent 在共享 git repo 工作

---

### Phase 7: Dashboard & Analytics（監控儀表板）— 3-4 天

> 目標：即時監控、數據分析、活動日誌

**Backend:**
- [ ] DB migration：`events` 表
- [ ] Event Bus 系統（記錄所有事件到 events 表）
- [ ] Dashboard API：aggregate stats（active tasks / completed today / failed / cost）
- [ ] Agent Health Check cron（每 60s 心跳）
- [ ] Agent Registry API（runtime status / version / capabilities）
- [ ] WebSocket server（Socket.io — 即時推送 dashboard 更新）

**Frontend:**
- [ ] Dashboard 頁面
  - Stat cards（active / completed / failed / cost）+ count-up 動畫
  - Agent status panel（🟢🔵🔴 + last heartbeat）
  - Cost trend chart（7-day line chart）
  - Recent Activity feed（WebSocket 即時更新，slide-in 動畫）
- [ ] Activity Log 頁面
  - Timeline view（infinite scroll）
  - Filter by event type / agent / date
- [ ] Notification system
  - Notification bell（Top Bar）+ unread badge
  - Notification panel（dropdown）
  - Signal 通知（透過 Mea → sessions_send）

**動畫：**
- [ ] Stat cards: number count-up（600ms ease-out）
- [ ] Cost chart: line draw animation（800ms）
- [ ] Agent status: dot pulse animation on change
- [ ] Activity feed: new item slide-in（300ms）

**交付物：**
- 即時 Dashboard
- Agent 健康監控
- 活動日誌時間軸
- 重要事件 Signal 通知

---

### Phase 8: Async + Queue（異步擴展）— 4-5 天

> 目標：大任務不再 timeout，可水平擴展

**Backend:**
- [ ] Worker Sidecar（輕量 HTTP server，部署在 Hermes Suite 旁邊）
  - POST `/tasks/execute` → 202 Accepted → background spawn hermes
  - 完成後 POST callback_url 回報結果
  - 進程監控（timeout / OOM / crash detection）
- [ ] BullMQ + Redis 整合
  - Task queue：priority queue + exponential backoff retry
  - Worker concurrency control（per-agent = 1）
  - Job dashboard（bull-board）
- [ ] Dispatch Engine 改造：sync (<30s) / async (>30s) 雙模式
- [ ] Callback handler API：POST `/api/callbacks/task-complete`

**Frontend:**
- [ ] Card detail：即時 progress（WebSocket from worker）
- [ ] Queue status panel（in Dashboard：queued / processing / completed）
- [ ] Worker health in Agent Registry

**交付物：**
- 大任務（>5min）不再 timeout
- 可同時 dispatch 多個任務
- Worker 可水平擴展

---

### Phase 9: Multi-Tenant & Polish（多租戶 + 打磨）— 持續迭代

> 目標：企業級功能 + UI 打磨 + 穩定性

**Backend:**
- [ ] Multi-Group / Multi-Company 完整隔離
- [ ] Company template Export / Import（JSON + secret scrubbing）
- [ ] Smart Assignment 完整實作（skill match + performance history + budget）
- [ ] More adapters：Claude Code / Cursor / Webhook
- [ ] Rate limiting + API throttling
- [ ] Audit log（immutable event trail）
- [ ] Backup / Restore 機制

**Frontend:**
- [ ] Animation 全面打磨（Framer Motion 所有 transition）
- [ ] Mobile responsive（Sidebar overlay / touch-friendly Kanban）
- [ ] Group / Company 切換器（Sidebar dropdown）
- [ ] Settings 頁面（Company / Agent / Notification / API Keys）
- [ ] Onboarding wizard（首次使用引導）
- [ ] Error boundary + fallback UI
- [ ] Performance optimization（React.memo / virtual scroll / code splitting）

**交付物：**
- Production-ready SaaS 品質
- 多集團多公司支援
- 手機可用
- 流暢的動畫體驗

---

### 里程碑摘要

| Phase | 名稱 | 預估天數 | 累計 | 里程碑 |
|---|---|---|---|---|
| 1 | Foundation | 3-4 天 | ~4 天 | 能登入、空殼 UI |
| 2 | Kanban | 4-5 天 | ~9 天 | 能建/拖/看 Card |
| 3 | Agent + Hermes | 4-5 天 | ~14 天 | ⭐ **MVP — 能派任務給 Hermes** |
| 4 | Dispatch Engine | 3-4 天 | ~18 天 | 全自動 dispatch + review loop |
| 5 | Budget & Governance | 3-4 天 | ~22 天 | 成本控制 + 人類審批 |
| 6 | Collaboration | 4-5 天 | ~27 天 | Comments + KB + Workspace |
| 7 | Dashboard | 3-4 天 | ~31 天 | 即時監控 + Signal 通知 |
| 8 | Async + Queue | 4-5 天 | ~36 天 | 不 timeout + 可擴展 |
| 9 | Polish | 持續 | — | Production-ready |

---

## 17. 異步調度模式 (Async Dispatch)

> v0.3 的 Portainer exec 是同步阻塞的（等 Agent 跑完才回傳），大任務會 timeout。
> v0.4 改為異步：發任務 → 立即回傳 → 背景執行 → callback 回報結果。

### 17.1 兩種模式並存

| 模式 | 適用場景 | 說明 |
|---|---|---|
| **Sync** | 快速任務 (<30s) | Portainer exec 直接等結果，簡單可靠 |
| **Async** | 大任務 (>30s) | 發出後立即 202，背景跑，完成後 callback |

Dispatch Engine 根據 `card.timeout_seconds` 自動選擇模式：
- timeout <= 30s → Sync
- timeout > 30s → Async

### 17.2 Async 流程

```
MegaCorps                    Hermes Worker Sidecar           Hermes CLI
   │                              │                             │
   │  POST /tasks/execute          │                             │
   │  { card, callback_url }       │                             │
   │ ────────────────────────────> │                             │
   │                               │                             │
   │  202 Accepted                 │                             │
   │  { run_id: "xxx" }            │                             │
   │ <──────────────────────────── │                             │
   │                               │  spawn: hermes chat -q ...  │
   │  (MegaCorps 不等待，           │ ──────────────────────────> │
   │   繼續處理其他 cards)          │                             │
   │                               │      ... Agent 執行中 ...    │
   │                               │                             │
   │                               │  stdout + exit code         │
   │                               │ <────────────────────────── │
   │                               │                             │
   │  POST {callback_url}          │                             │
   │  { run_id, result, cost, ... }│                             │
   │ <──────────────────────────── │                             │
   │                               │                             │
   │  Update card status in DB     │                             │
```

### 17.3 Worker Sidecar

在 Hermes Suite 容器旁邊部署一個輕量 HTTP sidecar（Node.js / Python），負責：
- 接收 MegaCorps 的 POST 請求
- Spawn `hermes chat -q` 進程
- 監控進程狀態（timeout / OOM / crash）
- 完成後 POST 結果到 callback URL

```typescript
// Worker Sidecar API
POST /tasks/execute
Body: {
  run_id: string;
  profile: string;
  prompt: string;
  session_id?: string;
  timeout_seconds: number;
  max_turns: number;
  callback_url: string;   // MegaCorps 的回呼 URL
}
Response: 202 { run_id: string; status: 'accepted' }

// Callback payload (Worker → MegaCorps)
POST {callback_url}
Body: {
  run_id: string;
  success: boolean;
  output: string;
  error?: string;
  session_id: string;
  tokens_used: number;
  cost_usd: number;
  duration_seconds: number;
  files_modified?: string[];
}
```

### 17.4 好處

- **不怕 timeout** — 即使 Agent 跑 30 分鐘也沒問題
- **Dispatch Engine 不阻塞** — 可以同時派多個任務
- **可靠性** — Worker 監控進程，crash 也能回報 failure
- **可擴展** — 未來可以多個 Worker 實例 + Load Balancer

---

## 18. Message Queue（任務佇列）

> 在 MegaCorps 和 Agent Workers 之間加一層 Redis Queue，解決並行、重試、負載均衡。

### 18.1 架構

```
MegaCorps Dispatch Engine
        │
        │ enqueue task
        ▼
┌──────────────────┐
│  Redis (BullMQ)  │
│                  │
│  Queue: tasks    │
│  ┌────┐ ┌────┐  │
│  │T-01│ │T-02│  │
│  └────┘ └────┘  │
│  ┌────┐         │
│  │T-03│         │
│  └────┘         │
└───────┬──────────┘
        │ dequeue
   ┌────┼────┐
   ▼    ▼    ▼
 Worker Worker Worker   ← 多個 Worker 可以水平擴展
 (H-1)  (H-2)  (UC-1)
```

### 18.2 BullMQ Job 結構

```typescript
interface DispatchJob {
  card_id: string;
  agent_id: string;
  adapter_type: 'hermes' | 'openclaw' | 'claude_code' | 'webhook';
  task_context: TaskContext;
  callback_url: string;
  priority: number;         // BullMQ 原生支援 priority queue
  attempts: number;         // 自動重試次數 (= card.max_retries)
  backoff: {                // 重試間隔策略
    type: 'exponential';
    delay: 10000;           // 10s, 20s, 40s...
  };
  timeout: number;          // Job-level timeout (ms)
}
```

### 18.3 為什麼需要 Queue

| 問題 | Queue 怎麼解決 |
|---|---|
| HTTP timeout | Job 在 Queue 裡等，Worker 慢慢做 |
| Agent 併發控制 | 每個 Agent 的 concurrency = 1（BullMQ worker options） |
| 重試機制 | BullMQ 內建 exponential backoff retry |
| 負載均衡 | 多個 Worker 從同一 Queue 拿任務 |
| 優先級 | urgent card → high priority job → 先被拿走 |
| 可觀測性 | BullMQ Dashboard (bull-board) 可以看 Queue 狀態 |

### 18.4 實施策略

- **Phase 1-2**: 不用 Queue，直接同步 Portainer exec（夠用）
- **Phase 3+**: 引入 BullMQ + Redis，改為異步 Queue 模式
- **Scale**: 如果需要多個 Hermes 實例，每個實例跑一個 Worker

---

## 19. Agent Registry + Health Check（代理人註冊表）

### 19.1 設計

每個 Agent 後端（Hermes instance、OpenClaw gateway 等）都要在 MegaCorps 註冊。

```typescript
interface AgentRuntime {
  id: string;
  type: 'hermes' | 'openclaw' | 'claude_code';
  name: string;                    // e.g., "Hermes Suite (TrueNAS)"
  host: string;                    // Container ID or IP
  port?: number;                   // Worker Sidecar port
  status: 'online' | 'offline' | 'degraded';
  last_heartbeat: string;          // ISO timestamp
  capabilities: Capability[];      // What this runtime can do
  installed_skills: string[];      // Hermes skills available
  version: string;                 // e.g., "Hermes Agent v0.15.2"
  max_concurrent_tasks: number;    // 最多同時跑幾個任務
  current_tasks: number;
}
```

### 19.2 Health Check（心跳）

MegaCorps 每 60 秒對每個 Runtime 做 health check：

```typescript
async function healthCheck(runtime: AgentRuntime) {
  try {
    if (runtime.type === 'hermes') {
      // Portainer exec: hermes --version
      const result = await portainerExec(runtime.host, ['hermes', '--version'], 10);
      return { status: 'online', version: parseVersion(result.stdout) };
    }
    // ... other types
  } catch (err) {
    return { status: 'offline', error: err.message };
  }
}
```

**狀態判斷：**
| 狀態 | 條件 |
|---|---|
| `online` | Health check pass + 容器 running |
| `offline` | Health check fail 連續 3 次 |
| `degraded` | Health check pass 但 response time > 5s |

**離線處理：**
- Runtime offline → 該 Runtime 下所有 Agent 的 `is_active` 自動設為 false
- 不再 dispatch 任務給這些 Agent
- 恢復後自動重新啟用
- 通知 Board Member（Signal / Dashboard）

### 19.3 DB

```sql
CREATE TABLE agent_runtimes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER,
    status TEXT DEFAULT 'offline',
    last_heartbeat TIMESTAMPTZ,
    version TEXT,
    capabilities TEXT[] DEFAULT '{}',
    installed_skills TEXT[] DEFAULT '{}',
    max_concurrent INTEGER DEFAULT 1,
    current_tasks INTEGER DEFAULT 0,
    config JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now()
);

-- agents table 新增 runtime_id
ALTER TABLE agents ADD COLUMN runtime_id UUID REFERENCES agent_runtimes(id);
```

---

## 20. Context Manager（平台端記憶管理）

> 不完全依賴 Hermes 的 `--resume` session。MegaCorps 自己維護一份 context 備份。

### 20.1 為什麼需要

- Hermes session 可能 corrupt / 被清理 / 超出 context window
- 多個 Agent 協作時，Agent B 需要知道 Agent A 做了什麼（但 B 的 session 裡沒有 A 的記憶）
- 平台需要「全局視角」的 context，不是某一個 Agent 的視角

### 20.2 Context 層級

```
Project Context（專案級）
  │  所有人都能看到的背景資訊
  │  - Project description
  │  - Architecture decisions
  │  - Knowledge Base (auto-injected)
  │
  ├─ Card Context（任務級）
  │    │  這張 Card 的完整歷史
  │    │  - Card description
  │    │  - All comments
  │    │  - Previous execution logs (summary)
  │    │  - Related cards' outcomes
  │    │
  │    └─ Agent Session（Agent 級）
  │         Hermes --resume session
  │         Agent 自己的連續記憶
```

### 20.3 Context Injection

Dispatch 時自動組裝 prompt：

```typescript
function buildTaskPrompt(card: Card, agent: Agent): string {
  const sections = [];
  
  // 1. Project Context
  const project = await getProject(card.project_id);
  if (project) {
    sections.push(`## Project: ${project.name}\n${project.description}`);
  }
  
  // 2. Goal Alignment
  const goal = await getGoal(card.goal_id);
  if (goal) {
    sections.push(`## Goal: ${goal.title}\n${goal.description}`);
  }
  
  // 3. Knowledge Base (auto-injected by tags)
  const kbDocs = await getKBByTags(card.tags, card.company_id);
  if (kbDocs.length) {
    sections.push(`## Company Knowledge\n${kbDocs.map(d => d.content).join('\n---\n')}`);
  }
  
  // 4. Related Cards Summary (dependency chain)
  const relatedCards = await getCompletedDependencies(card.dependency_card_ids);
  if (relatedCards.length) {
    const summaries = relatedCards.map(c => 
      `- [${c.title}] by ${c.assignee.name}: ${summarize(c.last_output, 200)}`
    );
    sections.push(`## Previous Work\n${summaries.join('\n')}`);
  }
  
  // 5. Card Comments (context from discussion)
  const comments = await getCardComments(card.id);
  if (comments.length) {
    const formatted = comments.map(c => `${c.author.name}: ${c.body}`);
    sections.push(`## Discussion\n${formatted.join('\n')}`);
  }
  
  // 6. The Task Itself
  sections.push(`## Task: ${card.title}\n${card.body}`);
  
  // 7. Output Requirements
  sections.push(`## Requirements\n- Work in: ${card.workspace_dir}\n- Report what you did\n- If blocked, explain why`);
  
  return sections.join('\n\n');
}
```

### 20.4 Context Store

每次 Agent 完成任務，MegaCorps 把 output summary 存到 DB：

```sql
CREATE TABLE context_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    card_id UUID NOT NULL REFERENCES kanban_cards(id),
    agent_id UUID REFERENCES agents(id),
    run_number INTEGER NOT NULL,
    input_prompt TEXT,          -- 完整的 prompt (debug 用)
    output_summary TEXT,        -- Agent 產出摘要 (200-500 字)
    output_full TEXT,           -- 完整 stdout
    hermes_session_id TEXT,     -- Hermes session 備份
    tokens_used INTEGER,
    created_at TIMESTAMPTZ DEFAULT now()
);
```

**好處：**
- Agent B 做 Card 時，prompt 裡會包含 Agent A 完成的相關 Card 摘要
- 即使 Hermes session 丟失，MegaCorps 還有完整的執行歷史
- Debug 時可以看到「到底傳了什麼 prompt 給 Agent」

---

> **v0.4 — 2026-06-04**
> 新增：異步調度 + Message Queue + Agent Registry + Health Check + Context Manager
> 完整架構：L1~L7 + 5 個補充模組 + Web UI + User System

---

## 2026-06-05 Implementation Update

This section records the current working implementation in clear text because parts of the original architecture note were encoded incorrectly on Windows.

### Paperclip Reference

MegaCorps now follows the same product direction as `paperclipai/paperclip`: a control plane for AI-agent companies. The core product model is:

- Company: mission, dispatch heartbeat, auto-dispatch switch.
- Department: grouping unit for agents and tasks.
- O-chart: agents report to other agents via `bossId`; agents can also belong to departments.
- Kanban: every task has one UUID and one stage: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`.
- Logs: task lifecycle logs plus API lifecycle logs.
- Intervention: users can comment, stop an agent, send instructions to agent context, and continue a run.

### Current Dispatch Loop

The server starts one heartbeat loop. The global tick defaults to 10 seconds:

```bash
DISPATCH_LOOP_INTERVAL_MS=10000
```

Each company has its own settings:

- `autoDispatchEnabled`
- `dispatchIntervalSeconds`

On each eligible company heartbeat, MegaCorps:

1. Scans `backlog` and `todo` cards.
2. Auto-assigns unassigned cards to an idle active agent.
3. Prefers same department, then tag/capability/role match.
4. Moves assigned work to `todo`, then `in_progress`.
5. Runs the agent adapter.
6. Moves work to `in_review` when approval/reviewer is required, otherwise `done`.
7. Reviews `in_review` cards automatically when a reviewer is configured.
8. Cascades parent cards to `done` when all sub-tasks are done.

### Task Comments

`card_comments` supports user intervention:

- `comment`: audit/context only.
- `pause_agent`: pause the assigned agent, mark the task `blocked`, and write stage/comment logs.
- `send_to_agent`: store the instruction and inject it into the next dispatch prompt.
- `continue_run`: reactivate the assigned agent and move the task back to `todo`.

The dispatch prompt now includes recent comments so a continued run can act on new instructions.

### Logging

`task_logs` records task-local events:

- stage changes
- dispatch/review/decomposition
- retries and cascade
- comments and user interventions

`api_events` records request/response/error lifecycle:

- method and path
- user id when authenticated
- request body
- response body
- status code
- error string
- duration

Sensitive keys matching password/pass/token/secret/jwt are redacted.

### Next Phase

The next implementation phase should deepen the Paperclip-like control plane:

- company template import/export,
- project/goal alignment in dispatch prompts,
- richer department-scoped Kanban filters,
- queue/worker sidecar for long-running Hermes jobs,
- agent runtime health checks,
- immutable audit/event bus,
- budget policies and approval queue.
