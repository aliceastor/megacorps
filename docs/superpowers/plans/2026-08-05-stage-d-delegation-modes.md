# Stage D: 委派模式與樹邊界 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** handoff(所有權移轉)成真、取消「必須委派一次」硬規則(planner 自決 + task spec)、委派樹加上深度/fan-out/時間邊界。

**Scope 收斂(YAGNI,記錄於 roadmap):** messages/tasks 分流(agent 間純訊息)延後——委派+input-required 已覆蓋現有互動需求,無真實 consumer 前不建;子樹預算 rollup 延後——per-agent/per-card 預算已存在。

## Global Constraints

- handoff 僅限卡片層(dispatch/webhook 完成路徑);委派 scope 內(message run)的 handoff 請求 → 錯誤回饋(delegate 不擁有卡片)
- handoff 必須是唯一的 delegation 項(混搭 → `handoff_must_be_sole_delegation` 回饋重試)
- 邊界值走 env:`DELEGATION_MAX_DEPTH`(預設 3)、`DELEGATION_MAX_FANOUT`(預設 16/scope)、`DELEGATION_TREE_TIMEOUT_HOURS`(預設 24)
- 逾時的 delegation 標 **cancelled**(不是 failed)——`childDelegationsPending` 只放行 approved/cancelled,failed 會讓母節點永久卡死

---

### Task 1: 結構化委派進 dispatch 路徑 + handoff 執行
**Files:** dispatch.ts、agent-report.ts(共用 helper)
- [ ] `structuredDelegationPlan(output)`(agent-report.ts):extract report → `{ handoff: AgentReportDelegation | null; subroutineLines: string[]; mixed: boolean } | null`(null=無結構化報告)
- [ ] `executeCardHandoff(card, fromAgent, item)`(dispatch.ts):以 `to` 在 active direct reports 解析目標(缺 `to` 或找不到 → throw `handoff_target_not_found`);card 更新 assigneeId=目標、columnStatus='todo'、reviewerId=null、sessionId=null、retryCount=0、nextRunAt=null;card message `handoff`(含 objective/context)、activity `dispatch.handoff`、enqueue dispatch
- [ ] dispatchCard 站點(~2223):結構化 plan 存在 → handoff 先行(mixed → feedback requeue);否則 subroutineLines 取代 delegationItems;無結構化 → 散文照舊
- [ ] message-run 站點(~1855):plan 含 handoff → feedback `handoff_not_allowed_in_delegation` 重試;否則 subroutineLines
- [ ] webhook 站點(routes.ts):移除「降級為 subroutine」warning,改真 handoff(單一 handoff → executeCardHandoff 並回應;mixed → 409 回饋)
- [ ] 測試:structuredDelegationPlan 純函式(handoff 偵測/mixed/lines);handoff 決策純部分
- [ ] commit `feat: implement handoff delegation mode`

### Task 2: 取消「必須委派一次」
- [ ] 移除三個硬 enforcement:dispatch 站點(collaborationDelegationRequirement required 分支)、webhook 409(`collaboration_mode_requires_delegation`)、nested message 站點;prompt 引導(collaborationDelegationInstructions)保留
- [ ] 相關測試更新(dispatch-delegation.test.ts 若有 enforcement 斷言)
- [ ] commit `feat: make collaboration delegation advisory instead of mandatory`

### Task 3: 委派樹邊界
- [ ] createMessageDelegations 加:深度檢查(沿 parentCommentId 鏈上溯,≥ MAX_DEPTH → throw `delegation_depth_exceeded`)與 fan-out 檢查(同 scope 既有 delegate_request 數 + 新增 > MAX_FANOUT → throw `delegation_fanout_exceeded`)——兩者經現有 catch 路徑轉為回饋重試
- [ ] `expireStaleDelegations()`:cron tick 呼叫;`delegate_request` 停在 queued/running/waiting 且 createdAt 超過 TIMEOUT_HOURS → 標 cancelled + card message `delegate_timeout` + 取消該 comment 的 queued/running message runs;之後:phase scope → 母 request 無 pending 子項時重新 enqueue 母 request;final scope → enqueue 卡片 dispatch(leader 重讀 board)
- [ ] 測試:深度/fan-out 純判定、過期閾值計算
- [ ] commit `feat: bound delegation trees (depth, fanout, timeout)`

### Task 4: 收尾
- [ ] roadmap:P1 #5 已實裝、#6 部分(強制委派已取消、task spec 已有;messages 分流延後+理由)、#7 部分(深度/fan-out/timeout 已實裝;預算 rollup 延後+理由)
- [ ] commit `docs: mark Stage D complete`
