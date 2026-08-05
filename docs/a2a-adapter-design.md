# A2A 合約層與 Adapter 設計

> 2026-08-04 · 目標:以 A2A protocol v1.0 作為 MegaCorps ↔ agent 的合約層,一次解決 P0 全部(結構化報告、單一結果通道、廢 regex verdict)、P1 #4(`input-required`)、P2 #9(artifact 一等公民),並為 P1 #5–8、P2 #10–11 鋪路。
> 前情:[multi-agent-workflow-review.md](./multi-agent-workflow-review.md) · [roadmap-status.md](./roadmap-status.md)。
> Server 側:Hermes 0.20+ 內建 A2A gateway(規格已確認,見 roadmap);MegaCorps 只實作 client 側。

## 1. 設計原則

1. **不發明任何 schema**——task 狀態、Message、Artifact 全部照抄 A2A v1.0 資料模型與命名。
2. **不破壞現有行為**——`hermes-ssh` 舊路徑原封不動;`a2a` 是新 adapter type,逐 agent opt-in(改 `agents.adapterType` 即切換,可隨時切回)。
3. **A2A 是合約層,不是編排政策**——Kanban 語意、O-chart 委派權限、review 鏈、預算、merge 策略仍是 MegaCorps 的職責。
4. **分階段落地**——每個 Stage 獨立可驗收、可回退。

## 2. 架構總覽

```
MegaCorps server (Node/TS)
 ├── adapters/a2a.ts        ← 新:client 側 adapter(@a2a-js/sdk ClientFactory)
 ├── a2a-tunnel.ts          ← 新:SSH tunnel 管理(每 host 一條長連 forward)
 └── adapter registry       ← 'a2a' 與 'hermes-ssh' 並存

Hermes host
 └── hermes gateway(常駐)
     └── A2A plugin :9900
         ├── /                      ← active profile(預設 agent)
         ├── /<slug>                ← a2a_served_agents 逐 profile 定址
         └── /.well-known/agent-card.json
```

### 2.1 傳輸:預設 SSH tunnel,直連可選

- **預設(建議)**:MegaCorps 已持有每台主機的 SSH 憑證。`a2a-tunnel.ts` 為每個 host 維護一條 `ssh -N -L <localPort>:127.0.0.1:9900` 長連(斷線指數退避重連,`onClose` 清理)。Hermes 維持 localhost 綁定、**不設 token、防火牆零改動**。
- **直連(config 可選)**:`adapterConfig.a2aBaseUrl` 直接給 URL 時走直連,配 `A2A_BEARER_TOKEN`;適用未來雲端/非 SSH 主機。

### 2.2 Agent 定址

`agents` 既有欄位映射,不加新欄:

| MegaCorps | A2A |
|---|---|
| `adapterConfig.sshHost/sshPort/...`(沿用 hermes-ssh 的別名) | tunnel 目標 |
| `adapterConfig.a2aPort`(預設 9900) | gateway port |
| `hermesProfile` | served agent 的 `slug` → path `/<slug>`(空值 = root agent) |
| `adapterConfig.a2aBaseUrl`(可選) | 覆寫為直連 URL |

### 2.3 部署前置(repo 外,每台 Hermes 主機)

1. 升級 hermes-agent ≥ 0.20
2. `~/.hermes/config.yaml`:`gateway.platforms.a2a.enabled: true` + `a2a_served_agents` 列出該主機所有 MegaCorps agent 的 slug↔profile
3. gateway 以常駐服務跑(systemd);**這是從「SSH 冷啟動 CLI」到「常駐 gateway」的營運模式轉變**,是本設計最大的部署面變更

## 3. 資料模型採用(= P0 的 schema 部分)

### 3.1 Task 狀態映射

A2A 八態為權威詞彙;MegaCorps 兩套狀態機(card 8 態 + delegationStatus)向其收斂:

| A2A TaskState | kanban_cards.columnStatus | card_comments.delegationStatus |
|---|---|---|
| `submitted` | `todo`(已排queue) | `queued` |
| `working` | `in_progress` | `running` |
| `input-required` | `waiting_on_external`(暫用;Stage C 起語意=等澄清) | `waiting`(問題掛在 comment) |
| `auth-required` | `blocked`(需人處理憑證) | — |
| `completed` | `in_review` → `done`(review 鏈之後) | `submitted` → `approved` |
| `failed` | retry 邏輯 → `blocked` | `failed` |
| `canceled` | `cancelled` | `cancelled` |
| `rejected` | `todo`(退回重做) | `rejected` |

註:MegaCorps 的 review 鏈是 A2A 之上的政策層——A2A `completed` 只代表 agent 交付,不代表卡片 `done`。

### 3.2 結構化報告(取代散文)

新 zod schema 進 `packages/shared`(命名照 A2A):

```ts
// A2A Message.parts 內的 DataPart,agent 交付時附上
export const agentReportSchema = z.object({
  kind: z.literal('megacorps-report'),
  status: z.enum(['completed', 'input_required', 'failed', 'rejected']),
  verdict: z.enum(['approved', 'revision_requested', 'escalate']).optional(), // review 任務必填
  summary: z.string().max(4000),
  questions: z.array(z.string()).optional(),      // input_required 時必填
  delegations: z.array(z.object({                  // 取代 DELEGATE: 散文塊
    to: z.string().optional(),                     // slug;缺省由 MegaCorps 分派
    objective: z.string(),
    outputFormat: z.string().optional(),
    boundaries: z.string().optional(),
    effort: z.enum(['small', 'medium', 'large']).optional(),
    mode: z.enum(['subroutine', 'handoff']).default('subroutine'), // P1 #5 預埋
  })).max(8).optional(),
  artifactRefs: z.array(z.string()).optional(),    // 引用 A2A artifactId
});
```

- **A2A agent**:report 作為 task 最終 Message 的 DataPart 回傳(A2A 原生支援 structured parts),Artifacts 走 A2A Artifact(名稱/mediaType/版本內建)。
- **Legacy(hermes-ssh / webhook)**:webhook payload 新增可選 `report` 欄位,zod 驗證;沒有 `report` 時退回散文解析並記 `report_format=legacy` 的 activity log(觀察遷移進度)。

### 3.3 Artifact 映射(= P2 #9)

A2A Artifact → `work_products` 一對一寫入:`artifactId → metadata.a2aArtifactId`、`name → title`、`parts` 內容按 mediaType 落地(URL 型存連結;文本型存 project workspace file 並記路徑)。報告以 `artifactRefs` 引用,審核者看 artifact 不看轉述。

## 4. 廢除 regex verdict(P0 #3)

1. `verdict` 成為 review 任務報告的**必填欄位**(schema 驗證,缺失 = 格式錯誤退回重試,沿用 `sendAgentFeedbackAndRequeue` 通道)。
2. `explicitReviewDecision()` / `reviewDecision()` 只保留給 legacy 散文路徑,且**移除「quality mode 默認 approve」**:比對不到 → 視為格式錯誤退回(不是核准也不是拒絕),重試耗盡 → `needs_review` 升級人審。
3. `delegationItems()` 散文解析同樣降為 legacy fallback;A2A/新 webhook 路徑只認 `report.delegations[]`。

## 5. 單一結果通道(P0 #2)

- **A2A agent**:結果**只**來自 A2A 事件流(SSE `SendStreamingMessage` / `GetTask`)。task prompt 不再包含 webhook 指示(`buildAgentPrompt` 對 a2a 出專用版本);webhook 若仍被呼叫,回 410 並記 log。stdout 撈 session id 的機制整個不存在(`contextId` 是協議欄位)。
- **Legacy agent**:維持現狀不動,避免破壞。雙通道 race 的病灶隨逐 agent 遷移自然縮小,全遷移後刪除 webhook 完成路徑(~200 行重複邏輯)。

## 6. `input-required` 流(P1 #4)

1. A2A 回報 `TASK_STATE_INPUT_REQUIRED`(Hermes 側 agent 以 `[INPUT_REQUIRED]` 開頭回覆即觸發,問題在 `status.message`)。
2. Adapter 將其映射為 `dispatch` 結果的新型別 `needsInput: { question, contextId, taskId }`。
3. Dispatch 層:卡片 → `waiting_on_external`,問題以 `action='agent_question'` 寫進 message board,並依政策路由——委派場景給 requester agent(enqueue 一個 `message` run 讓母 agent 作答),頂層卡片給人(notification)。
4. 答案以**同一 `contextId`** `SendMessage` 送回 → task 續跑 → 卡片回 `in_progress`。
5. 防呆:沿用 Hermes 側 anti-loop 上限;MegaCorps 側每 task 澄清次數上限(預設 3,超過 → `needs_review`)。

## 7. Adapter 實作規格

### 7.1 Stage B:純傳輸模式(先行)✅ 已實裝 2026-08-05

> 實作偏離:未使用 `@a2a-js/sdk`(proto 生成型別過重),改為自寫薄 JSON-RPC client([a2a-client.ts](../apps/server/src/a2a-client.ts)),對齊 Hermes JSON-RPC binding;未來需要 gRPC/push 再引入 SDK。SSE streaming 暫未實作(非串流 SendMessage + timeout)。

`adapters/a2a.ts` 實作與現有 adapter 相同的 `dispatch(agent, task) → TaskResult` 介面:

- 建立/取得 tunnel → `ClientFactory` 建 client(Agent Card 快取 per host+slug)
- task prompt 組裝**沿用現有** `buildKanbanDeltaContext` 等邏輯(A2A 只換傳輸,不換內容)
- `SendStreamingMessage` 送出,SSE frame → `onOutput` hook(串流沿用 chat 的 partial 機制)
- `contextId` 存 `adapter_sessions.adapterSessionId`(scopeType/kind 沿用現制,resume = 帶同 contextId)
- 回傳 `TaskResult { success, output, sessionId: contextId, tokensUsed, costUsd, durationSeconds }`
- **成本計量**:A2A 不回報 token 用量,暫沿用 `chars/4` 估價(與 hermes.ts 一致);Hermes 若在 metadata 附用量則優先採用
- 逾時:`readKanbanTaskTimeoutSeconds()`;超時 `CancelTask` + 標記失敗
- 錯誤分類:tunnel/HTTP 層失敗 → `dispatch_adapter_failed:` 前綴(走 retry/backoff,不走「格式錯誤」通道)

### 7.2 Stage C:原生 task 模式 ✅ 已實裝 2026-08-05

> 實裝註記:(1) DataPart 報告由 adapter 以 fenced JSON 併回 output,Stage A 抽取器直接生效,dispatch 對 A2A 零感知;(2) 頂層 input-required 複用 help-review 機制(無 reviewer 則 blocked),委派場景走現有 report/review 鏈;(3) **push 語意修正**:push 不是備援完成通道,而是「對帳加速器」——驗簽(`X-A2A-Signature`,HMAC-SHA256 over Python sorted-keys JSON)後僅清除重試 backoff 的 `nextRunAt`,結果一律走 adapter 單一通道,避免重造雙通道 race;(4) contextId 由 adapter 預生成(`a2a-ctx-*`)作為 push 關聯鍵。

- 啟用 `agentReportSchema` DataPart 解析、Artifact → work_products、`input-required` 流(§6)
- 長任務備援:向 Hermes 註冊 push-notification config(HMAC 驗簽端點 `POST /api/a2a/push`),SSE 斷線時靠 push + `GetTask` 對帳

### 7.3 測試

- 單元:狀態映射表、report schema 驗證、tunnel 生命週期(mock ssh)、Agent Card 快取
- 整合:以官方 `@a2a-js/sdk` 起一個假 A2A server(`AgentExecutor` 回放腳本)跑完整 dispatch → input-required → 續跑 → completed 循環;不需要真 Hermes
- 對照:同一張卡 hermes-ssh vs a2a 跑出等價結果(遷移驗收)

## 8. 分階段落地(含 P0–P2 全景)

| Stage | 內容 | 解決 | 驗收 |
|---|---|---|---|
| **A** | shared 加 A2A 對齊 schema;webhook 收 `report` 欄位(向下相容);verdict 必填化 + 移除默認 approve;legacy 散文標記 | P0 #1 #3 | 全測試綠;舊 agent 行為不變;新格式 report 走 schema 路徑 |
| **B** | `a2a-tunnel.ts` + `adapters/a2a.ts` 純傳輸模式;registry 註冊;1 個試點 agent 切換 | P0 #2(該 agent) | 試點 agent 完整跑卡;stdout/webhook 病灶在該 agent 消失 |
| **C** | 原生 task 模式:DataPart 報告、Artifact→work_products、input-required 流、push 備援 | P1 #4、P2 #9 | input-required 卡片可被母 agent/人作答續跑 |
| **D** | delegation `mode`(handoff/subroutine)+ messages/tasks 分流 + 委派樹邊界(深度/fan-out/預算 rollup/樹 timeout) | P1 #5 #6 #7 | handoff 卡片 assignee 轉移且原 agent 退場;樹邊界測試 |
| **E** | branch-per-card + merge queue + 衝突回派 | P1 #8 | 同卡協作單 branch;merge 序列化 |
| **F** | per-agent API token + policy-gated 人審收件匣(移除無 reviewer 自動 done) | P2 #10 #11 | 每 agent 獨立 token;頂層無上級 → 人審而非自動過 |

依賴關係:B 依賴 A(prompt 去 webhook 化需要新報告路徑);C 依賴 B;D 依賴 A(mode 欄位在 schema 裡);E、F 獨立於 C/D 可並行。

## 9. 風險與備忘

- **gateway 常駐是新的營運面**:主機重啟後 gateway 要自動起來(systemd);MegaCorps 的 runner-availability 檢查應加「Agent Card 可達」健康檢查(Stage B 順帶做)
- Windows 上 spawn `ssh -N -L` 的行程管理(現有 hermes-ssh 已在用 ssh,風險低)
- 記憶生命週期 maintenance run 的 a2a 版:`kind:'maintenance'` 對 a2a agent 改為直接 `SendMessage`(不帶卡片 context),Stage B 一併處理
- Hermes A2A plugin 是 8/3 剛發布的程式碼——試點期保留 hermes-ssh 一鍵切回
- 舊 `DELEGATE:`/regex 路徑的最終刪除排在全 agent 遷移完成後,不設死線
