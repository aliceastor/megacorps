# 多 Agent Workflow 檢討與改善方向

> 2026-07-28 · 概念層面的檢討,對照業界(LangGraph、OpenAI Agents SDK、A2A、Vibe Kanban、Anthropic/Cognition 實戰經驗)。
> 姊妹篇:[agent-memory-lifecycle.md](./agent-memory-lifecycle.md)(Agent 記憶生命週期設計)。

## 核心診斷

MegaCorps 把「協作」壓成了一種固定形狀(delegate → report → review 迴圈),而合約全靠散文和 regex 維繫。真實工作的 case 形狀太多,塞不進這一種迴圈;檔案交接有分支隔離、但沒有 merge story。

### 1. 合約是散文 + regex,不是 schema

- 委派靠解析 agent 輸出的 `DELEGATE:` bullet(`dispatch.ts` `delegationItems()`),上限 8 條。
- 指派對象是 `directReports[index % length]` round-robin;`agents.capabilities[]` 存在但未被使用。
- Review 判定是關鍵字 regex,quality mode 比對不到時**默默預設 approve**(`dispatch.ts` `reviewDecision()`)。
- 近期一連串 fix delegation loop / timeout / approval loop 的 commit 都是這個病灶的症狀。

### 2. 只有一種互動形狀

無法表達:中途提問再繼續、移轉所有權(handoff)vs 子程序呼叫(subroutine)、不需審核鏈的輕量問答。Collaboration Mode「每 scope 必須委派恰好一次」是鈍規則,只靠 prompt 勸阻多委派。

### 3. 兩套脫節的狀態機 + 兩個競速的結果通道

- Card 8 個 status 與 comment 上的 delegation status 互不相通,UI 靠合成 workflow actor 標籤硬撐。
- SSH stdout 解析與 `POST /api/webhook/task-complete` 都能完成 run、建委派、移卡;webhook 路徑複製了約 200 行 dispatch 完成邏輯,兩邊會漂移。

### 4. 委派樹沒有邊界

無深度上限、無樹級 timeout、無子樹預算 rollup、無 fan-out 上限;malformed 回覆的 requeue 不消耗 retry,理論上可無限燒錢。

### 5. 檔案:有隔離、沒有整合

- Branch pattern `megacorps/card-{cardId}-{agentSlug}`:同卡每個 agent 各一條 branch,只 rebase main,彼此看不到對方的 code。
- Leader 的「整合」是讀部下的文字報告;reviewer 審的是 push 上去的 branch 的文字摘要。
- `card_integrations.conflictNotes` 存在但沒有程式碼寫入;無 merge queue、無衝突偵測。
- Workspace file API 只有單一 global token,所有 agent 以同一個人類 user 身分寫檔。

## 業界對照(要點)

| 問題 | 業界解法 | 出處 |
|---|---|---|
| 任務生命週期 | `submitted → working → (input-required) → completed/failed/rejected/canceled`;`input-required` 讓子 agent 中途提問再續跑 | A2A protocol、LangGraph interrupt/resume |
| 委派形狀 | 區分 handoff(所有權移轉)vs agent-as-tool(子程序呼叫),per-interaction 選擇 | OpenAI Agents SDK、MS Agent Framework |
| 輕量互動 | Messages vs Tasks 分流:輕量問答用 message(共享 contextId),實質工作才升格 task | A2A |
| 委派規格 | 每次委派必附:目標、輸出格式、工具指引、邊界、effort 等級 | Anthropic multi-agent research system |
| 檔案交接 | 每卡一個 worktree/branch,平行產出、序列整合(merge queue),衝突回派給原 agent | Vibe Kanban、Conductor、Sculptor、Devin/Jules/Codex |
| 報告形式 | Artifact reference + 結構化摘要,不傳全文 | A2A Artifacts、Anthropic |
| 人審 | Policy-gated + 單一 Agent Inbox;approve / edit / reject-with-feedback | LangGraph HITL、HumanLayer |
| 讀寫法則 | **讀取型工作平行,寫入型工作串行**(單一 owner per file area) | Cognition、Anthropic、LangChain 三方共識 |

「大家 push 同一條 branch」被業界一致視為 anti-pattern。最接近 MegaCorps 的開源對照組是 **Vibe Kanban**(Kanban 板驅動 coding agent,每卡一 worktree,審核回饋直接回傳 agent,一鍵 rebase-merge)。

## 改善建議(按優先級)

| # | 建議 | 優先級 | 實裝狀態 |
|---|---|---|---|
| 1 | 報告改結構化 schema(`{status, verdict, summary, artifacts[], questions[], next_action}`),zod 驗證,失敗明確退回 | P0 | 未實裝 |
| 2 | 結果通道只留 webhook 一條,stdout 降為純 log(消滅 race 與重複邏輯) | P0 | 未實裝 |
| 3 | 廢除 regex verdict,尤其「比對不到默認 approve」 | P0 | 未實裝 |
| 4 | 統一 card/delegation 狀態機,加入 `input-required` 暫停態 | P1 | 未實裝 |
| 5 | 委派標記 `handoff` vs `subroutine` 兩種模式 | P1 | 未實裝 |
| 6 | Messages/Tasks 分流;取消「必須委派一次」,改 planner 決定 + 委派必附 task spec | P1 | 未實裝 |
| 7 | 委派樹邊界:深度上限、fan-out 上限、子樹預算 rollup、樹級 timeout | P1 | 未實裝 |
| 8 | Branch-per-card + 序列整合;寫 code 子任務單一 owner 或按檔案區域切分 | P1 | 未實裝 |
| 9 | `work_products` 升級為一等公民 artifact(id/型別/版本),報告引用之 | P2 | 部分(表已存在,未成為報告主體) |
| 10 | Per-agent API token(取代單一 global token) | P2 | 未實裝 |
| 11 | Policy-gated 人審 + 單一收件匣;移除「無 reviewer 自動 done」 | P2 | 未實裝 |

Meta 原則:先問每張卡「真的需要多 agent 嗎?」——多 agent 的甜蜜點是可平行的讀取型工作、資訊量超過單一 context、子任務耦合低;緊耦合 coding 用單一 agent 串行通常更好。

建議起手式:P0 三項一起做(結構化報告 + 單一通道),不改變使用者可見行為,但幾乎所有後續改善都建立在它之上。
