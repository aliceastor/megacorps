# Agent 記憶生命週期(Memory Lifecycle)設計

> 2026-07-28 · 目標:讓 MegaCorps 裡的 agent(Hermes)像正常員工一樣——上班接 task、下班按自己的 config 整理記憶/skills、下一個 task 帶著經驗來。
> 姊妹篇:[multi-agent-workflow-review.md](./multi-agent-workflow-review.md)。本設計與該文的 P0–P2 完全正交,可獨立先行。

## 核心概念

**Agent 是有記憶的獨立個體,不是無狀態工人。**

- **Session = 工作記憶**:每個 task 開新 session,用完即棄(卡內多輪往返沿用現有 resume 機制)。
- **Hermes 記憶檔 = 長期記憶**:跨天累積,由 Hermes 自己的記憶+整理機制維護,MegaCorps 不碰內容、不發明格式。
- MegaCorps 只負責三件事:**保證身分穩定、在對的時機喊下班、提供再教育的對話通道。**

## 已定案的設計決定

| 決定點 | 選擇 | 設計後果 |
|---|---|---|
| 記憶目標 | 職能成長 | 記憶 scope 綁 agent 本人,跨專案帶著走 |
| 租戶邊界 | 自用為主、預留產品化 | 整理時要求 Hermes 把「職能經驗」與「專案/公司事實」分開存放;現在不強制隔離,為未來留口 |
| Hermes 能力 | 已有記憶+整理機制 | MegaCorps 只觸發,零記憶基建 |
| 成長歸屬 | 完全個人 | 不做共享/升級/審核機制;每個 agent 獨立成長、各有個性 |
| 再教育 | 直接對話 | 用現有 direct chat 通道「找 agent 談話」,它自己改記憶;不做記憶檢視 UI |
| 整理時機 | 收工即整理(idle 觸發) | idle 偵測 + 單日次數上限兜底 |
| 主機拓撲 | 每 agent 固定一台主機 | 記憶天然安全,不需 affinity 規則或同步 |
| 整理中接單 | 新單排隊等 | 整理佔用 busy 狀態,走一般 capacity 機制 |
| 錯誤記憶治理 | 當真人員工看:有錯就再教育 | 不做重型治理;備份為唯一後悔藥(Hermes 主機側) |

## 觸發條件(maintenance sweep)

每次 dispatch cron tick 順帶檢查,對每個開啟記憶的 agent,同時滿足以下條件即觸發「下班整理」:

1. `isActive = true` 且 `isBusy = false`;
2. 該 agent 沒有 `queued|running` 的 task_runs;
3. 距上次整理之後**有新完成的工作**(否則沒東西可整理,跳過);
4. 最後一次完成工作距今超過 idle 門檻(預設 15 分鐘);
5. 今日整理次數未達單日上限(預設 3 次);
6. 預算檢查通過(整理也是 LLM 開銷,計入該 agent 的 budget)。

整理執行期間佔用 agent capacity(`isBusy`),新卡自動在佇列排隊——等同「真的下班了」。

## 整理任務的內容

發給 Hermes 的 prompt 包含:

1. **這班的工作摘要**:距上次整理後完成的卡片清單(標題、結果、review 結論、被退件的理由)、work_products 連結。被退件/被糾正的紀錄一定要在——這是「再教育自動發生」的管道。
2. **整理指示**:「按你自己的方式整理記憶與 skills」,並要求**分兩層存放**:
   - 職能經驗(做法、套路、技巧)——跨專案通用;
   - 專案/公司事實(某 repo 的架構、某客戶的偏好)——標注所屬 project/company。
3. 不使用 `--resume`(整理用乾淨 session;跨任務連續性靠記憶檔本身)。

## 再教育流程

發現 agent 學壞了(記錯結論、養成壞習慣)→ 從 direct chat 找它談話指出問題 → 它自己更新記憶。談話後可手動觸發一次整理讓糾正立刻固化(見手動觸發 API)。

備援(不在本 repo 實作):Hermes 主機上每日 cron 備份記憶目錄(`tar` 一份即可),壞到談不回來時可回滾到某天。

---

## 實作方案

### Phase 1:maintenance run(核心)

**不動 `task_runs` 佇列**。`task_runs.cardId` 為 notNull([schema.ts:264](../apps/server/src/db/schema.ts))、整個佇列語意都綁卡片;而 `heartbeat_runs.cardId` 可為 null([schema.ts:246](../apps/server/src/db/schema.ts)),且 chat.ts 已有「不經 task_runs、直接呼叫 adapter + 記 heartbeat/費用」的先例。maintenance 循此模式,是 agent 級、非卡片級的執行。

1. **Schema**(migrate.ts 加 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`,循現有慣例):
   - `agents.memory_config JSONB DEFAULT '{}'` — `{ enabled: boolean, idleMinutes?: number, dailyLimit?: number }`,預設關閉,逐 agent 開啟。
   - 不需要 `last_maintenance_at` 欄位:以 `heartbeat_runs where agent_id = ? and source = 'maintenance'` 的最新 `completedAt` 為準,零冗餘。

2. **新模組 `apps/server/src/agent-maintenance.ts`**:
   - `findMaintenanceCandidates(companyId?)` — 依上節六條件篩選;工作紀錄以 `heartbeat_runs`(`source != 'maintenance'`)與 `task_runs.completedAt` 推導。
   - `buildShiftSummary(agent, since)` — 彙整完成的 task_runs、card 標題與結果、review 退件理由(card_actions / card_comments)、work_products。
   - `runAgentMaintenance(agent)` — `claimAgentCapacity` → 預算檢查(`getBudgetGuard`/`budgetOk`)→ `getAdapter(agent.adapterType).dispatch(...)`(fresh session,不 resume)→ 寫 `heartbeat_runs`(`source='maintenance'`, `cardId=null`)與 `cost_events` → 釋放 capacity。逾時沿用 `runtime-settings.ts` 的 kanban task timeout。
   - 整理 prompt 模板(含兩層記憶指示)。

3. **接進 cron**:[dispatch.ts:2750](../apps/server/src/dispatch.ts) `runDispatchCronTick` 末端加 `await runMaintenanceSweep(app)`(有工作可派時 agent 不會 idle,順序天然正確)。

4. **手動觸發 API**:`POST /api/agents/:id/maintenance`(admin/operator)——再教育談話後立即固化用;繞過 idle 門檻,但仍尊重 busy 與預算。

5. **測試 `agent-maintenance.test.ts`**:候選判定(idle 門檻、單日上限、busy 跳過、無新工作跳過)、shift summary 內容(含退件理由)、預算拒絕路徑。

### Phase 2(可後續)

- Admin UI:agent 卡片顯示記憶開關、上次整理時間、今日次數;手動觸發按鈕。
- 教育談話結束後自動觸發整理(chat 端加一個「談話收尾」動作)。
- 整理結果的通知(notifications 表已存在,失敗時通知人類)。

### 明確不做(依設計決定)

- 記憶內容的檢視/編輯 UI(再教育 = 對話,不開腦手術)。
- 記憶共享/升級/審核機制(完全個人成長)。
- 記憶同步/affinity 機制(每 agent 固定主機)。
- MegaCorps 側的記憶格式或儲存(Hermes 全權)。

---

## 自我檢視:設計 vs 現況(未實裝清單)

| 設計元素 | 現況 | 落點 |
|---|---|---|
| Agent 固定主機/profile 綁定 | **已存在** | `agents.runtimeId` + `agents.hermesProfile`([schema.ts:114-115](../apps/server/src/db/schema.ts)) |
| 整理佔用 busy、新單排隊 | **已存在機制可重用** | `claimAgentCapacity`(dispatch.ts)、`agents.isBusy` |
| 預算計費 | **已存在機制可重用** | `budgetOk`/`getBudgetGuard`、`cost_events`、`heartbeat_runs` 費用欄位 |
| 再教育對話通道 | **已存在** | direct chat(chat.ts);`send_to_agent` 只是把留言排進下次 run 的 context([routes.ts:1930](../apps/server/src/routes.ts)),談話請用 direct chat |
| 卡內 session resume(工作記憶) | **已存在** | `adapter_sessions` per (agent, card, kind) |
| `agents.memory_config` 欄位 | **未實裝** | migrate.ts + schema.ts |
| idle 偵測 / maintenance sweep | **未實裝** | 新模組 agent-maintenance.ts |
| 整理執行(fresh session、heartbeat 記帳) | **未實裝** | 同上;`heartbeat_runs.source='maintenance'` |
| 單日整理上限 | **未實裝** | memory_config.dailyLimit |
| Shift summary 彙整(含退件理由) | **未實裝**(素材都在:task_runs、card_actions、work_products) | buildShiftSummary |
| 兩層記憶(職能/專案事實)指示 | **未實裝** | 整理 prompt 模板 |
| 手動觸發 API | **未實裝** | routes.ts |
| 教育談話後自動整理 | **未實裝**(Phase 2) | chat.ts |
| 記憶目錄每日備份 | **未實裝,且不在本 repo**(Hermes 主機側 cron) | 部署文件待補 |
| Machine runner 與記憶的衝突防護 | **未實裝**;目前固定主機拓撲下無風險,**若未來啟用 machine runner 動態接單,必須先加 affinity 防護**,否則記憶會散落多台主機 | runner-routes.ts claim 邏輯 |

### 已知風險備忘

- `hermes-ssh` 在 stdout 撈不到 session id 時即使 exit 0 也判失敗(hermes.ts)——maintenance run 同樣受此影響,失敗只記 log 不重試(下次 idle 自然再觸發)。
- 整理成本估算沿用現有 `chars/4` 估價,單日上限是成本的實際護欄。
