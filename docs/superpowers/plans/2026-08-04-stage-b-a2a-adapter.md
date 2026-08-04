# Stage B: A2A Adapter(純傳輸模式)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `a2a` adapter type:MegaCorps 經 SSH tunnel(或直連 URL)以 A2A JSON-RPC 呼叫 Hermes 0.20 gateway,行為與 hermes-ssh 等價(同 prompt、同 TaskResult),逐 agent opt-in。

**Architecture:** 三個新模組——`a2a-client.ts`(薄 JSON-RPC client,零依賴)、`a2a-tunnel.ts`(`ssh -N -L` 長連管理,斷線按需重建)、`adapters/a2a.ts`(組裝)。Prompt 沿用 `buildAgentPrompt`(webhook 指示照舊,Stage C 才切原生模式)。

**設計偏離紀錄:** 不用 `@a2a-js/sdk`——其 proto 生成型別($case unions、全必填欄位)對 client 與測試都過重,且唯一對端 Hermes 走 JSON-RPC binding。自寫 ~120 行 client,對齊 Hermes 文件的 wire 格式(`SendMessage`/`GetTask`/`CancelTask`,parts `{text}`,role `ROLE_USER`)。未來需要 gRPC/push 再引入 SDK。

## Global Constraints

- 不動 hermes-ssh 現行為;`a2a` 為新增並存
- `assertAdapterTargetAllowed` 不得用於 tunnel-local URL(內部產生非用戶輸入);直連 `a2aBaseUrl` 必須經過它
- Wire 韌性:SendMessage 結果同時容忍 `{task}`/`{message}`/裸物件;TaskState 以後綴比對正規化(`TASK_STATE_COMPLETED` 與 `completed` 皆可)
- 成本沿用 `estimateTokens`/`estimateCost`(chars/4)
- 測試不需真 Hermes:fake JSON-RPC http server + 注入 fake tunnel/spawn

---

### Task 1: shared 加 `a2a` adapter type
- [ ] `agentAdapterTypes` 加 `'a2a'`(packages/shared/src/index.ts:7)
- [ ] `adapters/config.ts` 的 `externalAdapterTypes` 加 `'a2a'`
- [ ] typecheck 全過 + commit `feat: register a2a adapter type`

### Task 2: `a2a-client.ts`
**Produces:** `sendA2aMessage(opts) → Promise<A2aSendOutcome>`、`normalizeA2aSendResult(result)`、`fetchAgentCard(baseUrl, fetchImpl?)`;`A2aSendOutcome = { text: string; contextId: string | null; taskId: string | null; state: A2aTaskState | null }`;`A2aTaskState = 'submitted'|'working'|'input_required'|'auth_required'|'completed'|'failed'|'canceled'|'rejected'`
- [ ] failing tests(`a2a-client.test.ts`):normalize 各形狀(task 包裹/裸 task/message)、state 正規化、text 抽取(status.message parts + artifacts)、JSON-RPC error 拋出、bearer header、timeout abort
- [ ] 實作:`fetch` POST JSON-RPC 2.0;`AbortController` timeout;parts 文字抽取容忍 `{text}` 與 `{content:{$case:'text',value}}` 兩形
- [ ] 測試綠 + commit `feat: add minimal A2A JSON-RPC client`

### Task 3: `a2a-tunnel.ts`
**Produces:** `ensureA2aTunnel(target, deps?) → Promise<number>`(localPort)、`closeAllA2aTunnels()`;target = `{ host, user, sshPort, keyPath?, sshBin?, sshOptions?, remotePort }`;deps 注入 `{ spawnFn, probeFn, allocatePortFn }` 供測試
- [ ] failing tests:同 target 重用同 tunnel;child exit 後下次呼叫重建;probe 失敗逾時報錯並清理
- [ ] 實作:free-port 分配(net listen 0)、`ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -L 127.0.0.1:<l>:127.0.0.1:<r>`、TCP probe until ready(15s)、exit 即從 map 移除(按需重建,不做背景重連)
- [ ] 測試綠 + commit `feat: add SSH tunnel manager for A2A gateways`

### Task 4: `adapters/a2a.ts` + registry
**Consumes:** Task 2/3;hermes.ts 的 `buildAgentPrompt`/`estimateTokens`/`estimateCost`;hermes-ssh 的 SSH config 別名解析邏輯(複用 `resolveHermesSshConnectionConfig` 匯出)
**Produces:** `dispatchToA2a(agent, task, hooks?)`,registry `'a2a'`
- [ ] failing test(`a2a-adapter.test.ts`):以 fake tunnel(回傳 fake server port)+ fake JSON-RPC server 跑 dispatch,斷言 output/contextId/成本估算;transport 失敗 → `success:false` 且 output 帶 `a2a_transport_error:` 前綴;`contextId` 續傳(resume)
- [ ] 實作要點:
  - baseUrl:`adapterConfig.a2aBaseUrl`(經 assert)或 tunnel → `http://127.0.0.1:<localPort>`
  - path:`adapterConfig.a2aAgentPath` ?? (`hermesProfile` → `/<slug>`) ?? root
  - contextId 續傳:`currentSessionId` 非 fallback 前綴才傳;回應無 contextId 時產 `a2a-fallback-<uuid>` 且不續傳
  - timeout:`task.timeoutSeconds`(+10s margin);bearer:`adapterConfig.a2aBearerToken`
  - `success = state ∉ {failed, canceled, rejected}`(input_required 在 Stage B 視為成功回覆,Stage C 才特殊處理)
  - deps 注入面:`createA2aDispatch(deps)`;registry 用預設 deps
- [ ] 測試綠 + 全套綠 + commit `feat: add a2a adapter (pure transport mode)`

### Task 5: 收尾
- [ ] roadmap-status.md:P0 #2 標「已具備 a2a 路徑,逐 agent 遷移中」;`a2a` adapter 軌道標 Stage B 完成
- [ ] a2a-adapter-design.md §7.1 註記實作偏離(無 SDK)
- [ ] commit `docs: mark Stage B complete`

## Self-Review 紀錄
- 覆蓋設計 §2.1/§2.2/§7.1;§7.1 的「Agent Card 健康檢查」延後到試點時隨 Stage C(不阻擋純傳輸)
- input-required 在 B 的語意(視為成功文字回覆)與 C 的升級路徑不衝突
- 型別:`A2aSendOutcome` 在 Task 2 定義、Task 4 消費,一致
