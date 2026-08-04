# Stage A: 結構化報告 + Verdict 必填 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 引入 A2A 對齊的結構化報告 schema(`megacorps-report`),review verdict 改為可缺席即退回(廢除「默認 approve」),webhook 接受結構化 `report` 並以其 delegations 取代散文解析。

**Architecture:** 純合約層改動,不動傳輸與 UI。新增 shared zod schema + server 端 `extractAgentReport()` 抽取器;dispatch 的兩個 verdict 判定點加上「report verdict 優先、比對不到就 feedback requeue」;webhook 加可選 `report` 欄位。舊散文路徑全部保留為 fallback 並打上 `reportFormat: 'legacy'` 標記。

**Tech Stack:** TypeScript、zod、drizzle、node:test(`npx tsx --test`)。

## Global Constraints

- 不破壞既有行為:所有現有測試必須維持綠燈;舊散文/DELEGATE 路徑保留
- 對照 A2A v1.0 命名(見 docs/a2a-adapter-design.md §3.2 的 `agentReportSchema`)
- `report.delegations[].mode='handoff'` 本 Stage 不實作:記 warning 降級為 subroutine(Stage D 實作)
- 測試指令:`cd apps/server; npx tsx --test src/<file>.test.ts`;全套 `npm test`;typecheck `npm run typecheck`
- 每個 Task 完成即 commit(main 分支,沿用本 repo 慣例)

---

### Task 1: `agentReportSchema`(packages/shared)

**Files:**
- Modify: `packages/shared/src/index.ts`(`createWorkProductSchema` 附近)
- Test: `apps/server/src/agent-report.test.ts`(新檔,先只放 schema 案例)

**Interfaces:**
- Produces: `agentReportSchema`、`type AgentReport`、`type AgentReportDelegation`——Task 2/3/4 依賴

- [ ] **Step 1: 寫 failing test**(schema 接受合法報告、拒絕缺 summary、驗證 verdict enum、delegations 上限 8)
- [ ] **Step 2: 跑測試確認 import 失敗**
- [ ] **Step 3: 在 shared 加 schema**:

```ts
export const agentReportDelegationSchema = z.object({
  to: z.string().trim().max(80).optional(),
  objective: z.string().trim().min(1).max(2000),
  outputFormat: z.string().trim().max(1000).optional(),
  boundaries: z.string().trim().max(1000).optional(),
  effort: z.enum(['small', 'medium', 'large']).optional(),
  mode: z.enum(['subroutine', 'handoff']).default('subroutine'),
});
export const agentReportSchema = z.object({
  kind: z.literal('megacorps-report'),
  status: z.enum(['completed', 'input_required', 'failed', 'rejected']),
  verdict: z.enum(['approved', 'revision_requested', 'escalate']).optional(),
  summary: z.string().trim().min(1).max(4000),
  questions: z.array(z.string().trim().min(1).max(1000)).max(10).optional(),
  delegations: z.array(agentReportDelegationSchema).max(8).optional(),
  artifactRefs: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
});
export type AgentReportDelegation = z.infer<typeof agentReportDelegationSchema>;
export type AgentReport = z.infer<typeof agentReportSchema>;
```

- [ ] **Step 4: 測試綠 + typecheck 全過**
- [ ] **Step 5: Commit** `feat: add A2A-aligned agent report schema`

### Task 2: `extractAgentReport()`(server 抽取器)

**Files:**
- Create: `apps/server/src/agent-report.ts`
- Test: `apps/server/src/agent-report.test.ts`(追加)

**Interfaces:**
- Consumes: Task 1 的 `agentReportSchema`
- Produces: `extractAgentReport(output: string | null | undefined): { report: AgentReport } | { error: string } | null` —— null=輸出中沒有 report 區塊;error=有區塊但驗證失敗(供 feedback requeue 用)。另 `delegationLineFromReportItem(item): string` 把結構化 delegation 轉成 `createMessageDelegations` 認得的 `"slug: objective — output: ... — do not: ..."` 行(≤500 chars)。

- [ ] **Step 1: failing tests**:fenced ```json 區塊抽取、bare JSON(輸出即整個物件)、含 `"kind":"megacorps-report"` 的內嵌物件、驗證失敗回 error、無區塊回 null、多區塊取最後一個
- [ ] **Step 2: 實作**:掃描 fenced code blocks 與貪婪的 `{...}` 平衡括號匹配,只嘗試解析含 `megacorps-report` 字樣的候選;`JSON.parse` + `agentReportSchema.safeParse`
- [ ] **Step 3: 測試綠**
- [ ] **Step 4: Commit** `feat: add agent report extractor`

### Task 3: verdict 嚴格化(dispatch.ts)

**Files:**
- Modify: `apps/server/src/dispatch.ts:415-422`(`reviewDecision` 簽名改 `ReviewDecision | null`,刪除第 421 行默認)
- Modify: `apps/server/src/dispatch.ts:2444-2461`(card review 判定點)
- Modify: `apps/server/src/dispatch.ts:2028`(message review 判定點)
- Modify: `dispatchInternals`(2916)加 `extractAgentReport` re-export 供測試
- Test: `apps/server/src/dispatch-verdict.test.ts`(新檔)

**Interfaces:**
- Consumes: Task 2 `extractAgentReport`
- Produces: 判定優先序 = report.verdict → explicitReviewDecision → reviewDecision(keyword 層)→ **null → feedback requeue**

- [ ] **Step 1: failing tests**(`reviewDecision('聊天式無結論輸出', 'quality') === null`;report verdict 優先於散文;help mode 無比對也是 null)
- [ ] **Step 2: 改 `reviewDecision`**:

```ts
function reviewDecision(output: string, _mode: 'quality' | 'help'): ReviewDecision | null {
  const explicit = explicitReviewDecision(output);
  if (explicit) return explicit;
  if (/\b(escalate|…現有 418 行 regex…)\b/i.test(output)) return 'escalate';
  if (/\b(revision[_ -]?requested|…現有 419 行 regex…)\b/i.test(output)) return 'revision_requested';
  if (/\b(pass|approve|approved|done|complete|completed|resolved)\b/i.test(output)) return 'approved';
  return null; // 廢除默認 approve / 默認 revision_requested
}
```

- [ ] **Step 3: card review 判定點(2444-2461)**:

```ts
const reportExtract = extractAgentReport(result.output);
const reportVerdict = reportExtract && 'report' in reportExtract ? reportExtract.report.verdict ?? null : null;
const explicitDecision = reportVerdict ?? explicitReviewDecision(result.output);
// …(2445 的 !result.success && !explicitDecision throw 維持)…
const decision = explicitDecision ?? reviewDecision(result.output, reviewMode);
if (!decision) {
  return sendAgentFeedbackAndRequeue({ card, agent: reviewer, kind: 'review',
    message: 'review_verdict_missing: Your review did not contain a decision. Return a JSON megacorps-report with "verdict", or an explicit VERDICT: APPROVED | REVISION_REQUESTED | ESCALATE line.',
    runId: run.id, taskRunId: options.taskRunId, output: result.output, result });
}
```

- [ ] **Step 4: message review 判定點(2028)**:decision 為 null 時呼叫 `requeueMessageTaskAfterFailure({ card, comment, taskRun, kind: 'message_review', agentId: actorAgentId, message: 'review_verdict_missing: …' })`;requeue 失敗(次數耗盡)才 fallback 為 `'escalate'`(升級而非默認核准)
- [ ] **Step 5: 全套測試 + typecheck**
- [ ] **Step 6: Commit** `feat: require explicit review verdicts, drop silent approve default`

### Task 4: webhook `report` 欄位(routes.ts)

**Files:**
- Modify: `apps/server/src/routes.ts:2515-2525`(webhook body schema)+ `2558-2582`(delegation 來源)
- Test: `apps/server/src/agent-report.test.ts`(追加 `delegationLineFromReportItem` 案例;webhook 端 DB 邏輯以現有測試守護不另建)

**Interfaces:**
- Consumes: Task 1 schema、Task 2 `delegationLineFromReportItem`
- Produces: `body.report` 存在時 → delegations 用 `report.delegations.map(delegationLineFromReportItem)`,activity details 記 `reportFormat: 'structured'`;否則散文解析照舊 + `reportFormat: 'legacy'`

- [ ] **Step 1: schema 加欄位** `report: agentReportSchema.optional()`(import 自 shared)
- [ ] **Step 2: delegation 來源改寫(2560)**:

```ts
const structuredDelegations = body.report?.delegations ?? null;
if (structuredDelegations?.some((d) => d.mode === 'handoff')) {
  app.log.warn({ cardId: card.id }, 'handoff delegation mode not yet implemented; treating as subroutine');
}
const requestedDelegation = structuredDelegations
  ? structuredDelegations.map(delegationLineFromReportItem)
  : delegationItems(executionLog);
```

- [ ] **Step 3: activity log details 加** `reportFormat: body.report ? 'structured' : 'legacy'`(webhook 完成路徑的 addActivity 呼叫)
- [ ] **Step 4: 全套測試 + typecheck**
- [ ] **Step 5: Commit** `feat: accept structured report in task-complete webhook`

### Task 5: prompt 教學(hermes.ts + review 協議行)

**Files:**
- Modify: `apps/server/src/adapters/hermes.ts:102-114`(webhook 指示加 report 範例)
- Modify: `apps/server/src/dispatch.ts:3447/3484` 一帶(review 協議行加「無明確 verdict 會被退回」)

- [ ] **Step 1: hermes.ts webhook Body 範例後加一段**:

```
Prefer including a structured "report" field in the webhook body:
"report": { "kind": "megacorps-report", "status": "completed", "summary": "...",
  "delegations": [{ "to": "<slug>", "objective": "...", "effort": "small" }] }
The legacy DELEGATE block still works but is deprecated.
```

- [ ] **Step 2: review 協議行加**:`Reviews with no explicit verdict are returned for retry — never omit the decision.`
- [ ] **Step 3: hermes.test.ts 既有 prompt 測試維持綠(必要時更新斷言)**
- [ ] **Step 4: Commit** `feat: teach structured report format in agent prompts`

### Task 6: 收尾

- [ ] **Step 1: `npm test` + `npm run typecheck` 全綠**
- [ ] **Step 2: roadmap-status.md 把 P0 #1 #3 標為已實裝、#2 標「A2A agent 路徑於 Stage B」**
- [ ] **Step 3: Commit** `docs: mark Stage A complete in roadmap`

## Self-Review 紀錄

- Spec 覆蓋:P0 #1(Task 1/2/4)、#3(Task 3)、#2 的 webhook 端準備(Task 4;完整單一通道在 Stage B 隨 a2a adapter);設計文件 §3.2/§4 全對應
- 型別一致:`AgentReport`/`extractAgentReport`/`delegationLineFromReportItem` 簽名在 Task 1/2/3/4 一致
- 無 placeholder(Task 3 Step 2 的「現有 regex」指原行內容照抄,執行時以現檔為準)
