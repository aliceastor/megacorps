# Stage C: A2A 原生 Task 模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a2a adapter 升級原生模式:DataPart 結構化報告、A2A Artifact → work_products、`input-required` 中途提問流(頂層卡片複用 needs_review 機制)、HMAC push 備援(對帳加速器)。

**Architecture:** client 層擴充解析(DataPart/artifacts/GetTask/push 驗簽);adapter 把 DataPart 報告以 fenced JSON 併回 output(Stage A 的抽取器直接生效,dispatch 零改動)、`input_required` 映射為 `TaskResult.needsInput`;dispatch 只加兩個小分支(needsInput → needs_review;artifacts → work_products);push 端點驗簽後僅做「清 `nextRunAt` 加速重試」,**絕不成為第二條完成通道**(P0 #2 原則)。

**已確認的 Hermes wire 事實**(源碼 `plugins/platforms/a2a/`):push payload = `{"statusUpdate":{"taskId","contextId","status":{"state","timestamp","message"?}}}`;簽名 = HMAC-SHA256 hex over Python `json.dumps(payload, sort_keys=True, ensure_ascii=False)`(注意 `", "`/`": "` 分隔符),header `X-A2A-Signature`,secret = `A2A_PUSH_SECRET`(預設 bearer token,tunnel 模式無 token 即無簽名);註冊走 `message/send` 的 `configuration.taskPushNotificationConfig.url`(one-shot,送達即消耗);Hermes 側對 callback URL 有 SSRF 檢查(localhost-only 模式允許內網)。

## Global Constraints

- 未簽名 push 僅允許觸發「對帳加速」(本來就冪等且無害);有 secret 配置時強制驗簽
- push 端點對 payload 內容零信任:只用 contextId 做關聯,狀態以 GetTask 向 gateway 回查為準(本 Stage 只實作加速語意,GetTask 對帳留待需要時)
- `TaskResult` 擴充全部 optional,舊 adapter 不受影響
- 委派場景的 input-required 不需新機制:delegate 的提問即 delegate_report,requester 以 REVISION_REQUESTED+答案回覆(現有鏈路)

---

### Task 1: a2a-client 擴充
**Produces:** `A2aSendOutcome` 加 `report: AgentReport | null`、`artifacts: A2aArtifactRef[]`(`{artifactId, name?, uri?, text?}`);`pythonSortedJson(value)`、`verifyA2aPushSignature(payload, secret, signature)`、`parseA2aPushPayload(body)` → `{taskId, contextId, state, text} | null`
- [ ] failing tests:DataPart 兩形(`{data:{...}}`/`{content:{$case:'data',value}}`)報告抽取與 schema 驗證失敗忽略;artifacts uri/text 抽取;pythonSortedJson 對齊 Python 分隔符與鍵排序(嵌套);驗簽正反例;push payload 解析
- [ ] 實作 + 測試綠 + commit `feat: extend a2a client with reports, artifacts, and push verification`

### Task 2: adapter 原生模式
**Files:** Modify `adapters/hermes.ts`(TaskResult optional 欄位)、`adapters/a2a.ts`
- [ ] `TaskResult` 加 `needsInput?: { question: string } | null; artifacts?: A2aArtifactRef[]`
- [ ] adapter:無前置 context 時**預生成** `a2a-ctx-<uuid>` 傳入(push 關聯的前提;取代 fallback-after 模式);`turnId = outcome.taskId`;`state==='input_required'` → `success:true, needsInput:{question:text}`;DataPart 報告以 ```` ```json ```` fenced 併回 output;artifacts 傳遞;`configuration.taskPushNotificationConfig = { url: <megacorpsApiUrl>/api/a2a/push }`(config `a2aPushEnabled !== false` 時)
- [ ] 更新 a2a-adapter.test.ts(contextId 預生成、needsInput、報告內嵌、push 註冊參數)+ commit `feat: a2a native task mode in adapter`

### Task 3: dispatch 接線
- [ ] dispatchCard 的 adapter 結果處理:`result.needsInput` → 走 needs_review 路徑(question 為 reviewFeedback + `agent_question` card message);help-review 回答後卡回 todo 續跑(現有機制)
- [ ] `result.artifacts` 中含 `uri` 者 → `work_products` rows(type 'external',title=name??artifactId,url=uri),dispatch 與 message report 兩處
- [ ] 測試(internals 層可測的純函式部分)+ 全套綠 + commit `feat: wire a2a input-required and artifacts into dispatch`

### Task 4: push 端點(對帳加速器)
**Files:** routes.ts 加 `POST /api/a2a/push`(無 session auth)
- [ ] 流程:parse payload → 以 contextId 查 `adapter_sessions`(`adapterSessionId = contextId`, adapterType 'a2a')→ 得 agent;agent 配置了 `a2aPushSecret ?? a2aBearerToken` 時強制驗簽(失敗 401);記 activity `a2a.push_received`;若該 agent 的對應卡片正處於重試 backoff(todo 且 `nextRunAt` 在未來)→ 清 `nextRunAt`(下個 cron tick 立即重試,resume 同 contextId 拿現成結果)
- [ ] 不做:直接完成 task run / 移動卡片(單一結果通道原則)
- [ ] 測試(驗簽/解析純函式已在 Task 1;路由層以 typecheck + 現有測試守護)+ commit `feat: add a2a push reconciliation endpoint`

### Task 5: 收尾
- [ ] roadmap-status.md:P1 #4 標已實裝(a2a 路徑)、P2 #9 標部分實裝(a2a artifacts);a2a adapter 軌道標 Stage C 完成
- [ ] a2a-adapter-design.md §6/§7.2 加實裝註記(push=對帳加速器的語意修正)
- [ ] commit `docs: mark Stage C complete`

## Self-Review 紀錄
- input-required 頂層=needs_review 複用(用戶決定);委派場景走現有 report/review 鏈,無需程式碼
- push 語意從設計文件的「備援完成通道」修正為「對帳加速器」——理由:避免重造雙通道 race;已記為設計偏離
- 型別:`A2aArtifactRef` Task 1 定義、Task 2/3 消費一致
