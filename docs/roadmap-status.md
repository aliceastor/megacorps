# MegaCorps 改善路線圖與進度總覽

> 2026-07-28 · 彙整自兩份設計文件與實作進度:
> [multi-agent-workflow-review.md](./multi-agent-workflow-review.md)(workflow 檢討)、[agent-memory-lifecycle.md](./agent-memory-lifecycle.md)(記憶生命週期)。

## 總覽

| 軌道 | 內容 | 狀態 |
|---|---|---|
| 設計文件 | workflow 檢討 + 記憶生命週期設計 | ✅ 完成(commit `27829d9`) |
| 記憶生命週期 Phase 1 | 下班整理 maintenance run 全套 | ✅ 完成(commit `e13ab54`,已 push) |
| 記憶生命週期 Phase 2 | Admin UI、談話後自動整理、失敗通知 | ⏸ 擱置(等痛了再做) |
| Workflow P0 | 結構化報告、單一結果通道、廢 regex verdict——**直接採 A2A 資料模型** | ❌ 未做(**建議的下一步**) |
| Workflow P1 | input-required 狀態機(由 A2A 取代)、兩種委派模式、委派樹邊界、檔案整合 | ❌ 未做 |
| Workflow P2 | artifact 一等公民(由 A2A 取代)、per-agent token、policy-gated 人審 | ❌ 未做 |
| `a2a` adapter | MegaCorps 作為 A2A client 直連 Hermes 0.2 的 A2A server | ❌ 未做(規格待確認) |

---

## ✅ 已完成:記憶生命週期 Phase 1

**概念**:agent 是有記憶的員工——session 是工作記憶(每 task 用完即棄),Hermes 自己的記憶檔是長期記憶;MegaCorps 只負責身分穩定、喊下班、再教育通道。

已實裝(全部在 commit `e13ab54`):

- `agents.memory_config` 欄位(migration v5),`PUT /api/agents/:id` 可設定 `{ enabled, idleMinutes, dailyLimit }`,預設關閉
- **Idle 偵測 sweep**([agent-maintenance.ts](../apps/server/src/agent-maintenance.ts),每 60 秒):六條件判定——啟用、無進行中工作、有新完成的工作、閒置逾門檻(預設 15 分)、未達單日上限(預設 3 次)、預算 OK;失敗按 idle 門檻退避,不 hot-loop
- **Shift summary**:彙整完成的 task runs、review 退件理由(最高優先,「再教育」由此自動發生)、work products
- **整理執行**:fresh session(不 resume)、佔用 `isBusy`(新單排隊)、`heartbeat_runs.source='maintenance'` 記帳 + 預算硬停守衛;限 `hermes-ssh` adapter
- **兩層記憶指示**:職能經驗(跨案通用)與專案/公司事實(標注歸屬)分開存放——為未來產品化預留隔離
- `POST /api/agents/:id/maintenance` 手動觸發(再教育談話後固化用)
- Hermes adapter 新增 `kind: 'maintenance'` prompt(禁止呼叫 webhook、禁止開新工作)
- 測試 11 案例;全 suite 78/78 通過,全 workspace typecheck 通過

**設計決策紀錄**(問答定案):記憶目標=職能成長 · 完全個人不共享 · 再教育=直接對話 · 收工即整理 · 每 agent 固定主機 · 整理中新單排隊 · 錯誤記憶當真人再教育即可。

**啟用方式**:
```
PUT /api/agents/<id>  body: {"memoryConfig":{"enabled":true,"idleMinutes":15,"dailyLimit":3}}
```

---

## ⏸ 擱置:記憶生命週期 Phase 2(決定不特意實裝)

「等痛了再做」,不是「以後做」:

1. Admin UI(記憶開關/上次整理時間/手動按鈕)——設定一次就不動,curl 足矣
2. 教育談話後自動整理——談話 session 本身就能直接更新記憶,手動 API 當保險已夠
3. 整理失敗通知——後果輕(下次 idle 自動重試),`activity_log` 可查

**例外、建議去做**(repo 外,一行 cron):Hermes 主機上每日 `tar` 備份記憶目錄——記憶壞掉時唯一的後悔藥。

---

## ❌ 未做:Workflow P0(建議的下一步)

病灶:合約是散文 + regex。委派靠解析 `DELEGATE:` bullet、review verdict 靠關鍵字、比對不到**默默預設 approve**;近期一連串 delegation loop 修復都是這裡的症狀。

| # | 項目 | 內容 |
|---|---|---|
| 1 | 結構化報告 schema | `{status, verdict, summary, artifacts[], questions[], next_action}`,zod 驗證,失敗明確退回重試 |
| 2 | 單一結果通道 | 結果只走 webhook;stdout 降為純 log(消滅 stdout/webhook 雙通道 race 與約 200 行重複邏輯) |
| 3 | 廢 regex verdict | verdict 改必填欄位,移除「默認 approve」 |

特性:不改變任何使用者可見行為,風險低,是所有後續改動的地基。可向下相容分階段上(舊格式暫收、標記 deprecated)。

**採用決定(2026-07-28)**:schema 不自己發明,**直接照抄 A2A protocol v1.0 的資料模型**——task states 用它的八態(`submitted / working / input-required / auth-required / completed / failed / canceled / rejected`)、報告用它的 Message/Artifact shape、欄位照它的命名。詞彙先對齊,未來換傳輸層就是純 transport swap。A2A 是通訊協議不是編排政策:Kanban 語意、O-chart 委派權限、review 鏈、handoff/subroutine 所有權判斷、merge queue、預算,仍是 MegaCorps 的職責。

## ❌ 未做:`a2a` adapter(新軌道)

Hermes 0.2 已支持 A2A(server 端),因此不需要自建 wrapper 服務;MegaCorps 只需在現有 adapter registry 加一個 `a2a` adapter type(client 側,用官方 `@a2a-js/sdk` 的 `ClientFactory`),與 `hermes-ssh` 並存。附帶紅利:任何 A2A 相容的第三方 agent 都可零 adapter 開發直接受僱。

**Hermes 0.20(2026-08-03「Herald Release」,NousResearch/hermes-agent)A2A 規格已確認**(來源:repo 內 `website/docs/user-guide/messaging/a2a.md`):

- 啟用:`hermes gateway setup` 選 A2A,或 `~/.hermes/config.yaml` 設 `gateway.platforms.a2a.enabled: true`(gateway 常駐服務)
- Endpoint:預設 port `9900`;JSON-RPC 2.0 於 `POST /`(v1.0 標準方法 `SendMessage`/`SendStreamingMessage`/`GetTask`/`CancelTask`/`SubscribeToTask`);Agent Card 於 `/.well-known/agent-card.json`;SSE streaming;push notification 走 HMAC-SHA256 簽名 webhook
- 認證:**無 token 只綁 127.0.0.1**;跨機需 bearer token + 顯式 `A2A_HOST`;支援 per-peer tokens(`A2A_PEER_TOKENS`)、rate limit、audit log、anti-loop 回合上限
- 跨機連線兩條路:(a) token + `A2A_HOST=0.0.0.0` 直連 IP:9900;(b) **SSH tunnel port-forward**(MegaCorps 已有 SSH 憑證,server 維持 localhost 綁定,零防火牆改動)——建議先走 (b)
- 多輪對話以 A2A `contextId` 為鍵(取代 adapter_sessions 的 resume 機制)

原有兩個開放問題已從 plugin 原始碼(`plugins/platforms/a2a/adapter.py`、`DESIGN.md`)確認,均為正面答案:

1. **多 profile 路由:支援,一個 gateway 服務多個 profile,以 URL path 定址**。config 的 `a2a_served_agents` 宣告多個 served agent,每個帶 `slug`(→ path `/<slug>`)與 `profile`(→ 對應的 Hermes profile);root `/` 是 active profile 的預設 agent。session 以 `(profile, slug, contextId)` 為鍵,另有 tenant 概念做隔離。MegaCorps 映射:`agents.hermesProfile` → `http://<host>:9900/<slug>`。
2. **`input-required`:真正暴露**。Hermes 側 agent 以 `[INPUT_REQUIRED]` 開頭回覆時,adapter 將其映射為 `TASK_STATE_INPUT_REQUIRED`、問題放在 `status.message`;caller(MegaCorps)以同一 `contextId` 送下一則 message 作答即續跑。**P1 #4 的核心能力由此免費取得。**

## ❌ 未做:Workflow P1

| # | 項目 | 解決的問題 | 業界對照 |
|---|---|---|---|
| 4 | 統一狀態機 + `input-required` | **由 A2A 協議直接取代**(採 A2A 後即內建);剩餘工作是 card/delegation 兩套狀態機向 A2A 八態收斂 | A2A task lifecycle |
| 5 | 委派兩種模式 | 每個委派標記 `handoff`(所有權移轉)或 `subroutine`(子程序呼叫),覆蓋單一迴圈表達不了的 case | OpenAI Agents SDK |
| 6 | Messages/Tasks 分流 + task spec | 輕量問答不生審核鏈;取消「必須委派一次」,委派必附目標/輸出格式/邊界/effort | A2A、Anthropic |
| 7 | 委派樹邊界 | 深度上限、fan-out 上限、子樹預算 rollup、樹級 timeout;malformed 重試消耗計數 | — |
| 8 | Branch-per-card + 序列整合 | 同卡收斂一條 branch;merge queue 一次合一個;衝突回派原 agent;讀平行、寫串行 | Vibe Kanban、Cognition/Anthropic 共識 |

## ❌ 未做:Workflow P2

| # | 項目 | 內容 |
|---|---|---|
| 9 | work_products 升級 artifact 一等公民 | id/型別/版本,報告引用 artifact 而非全文轉述(表已存在,未成為報告主體) |
| 10 | Per-agent API token | 取代單一 global token,workspace 檔案/artifact 有真實歸屬 |
| 11 | Policy-gated 人審 + 單一收件匣 | 只攔不可逆/對外/最終 merge;移除「無 reviewer 自動 done」 |

---

## 建議的執行順序

1. **先實測記憶**:挑一個 agent 開 `memoryConfig`,做幾張同類卡,幾天後看記憶是否實際改善表現(有數據再走下一步)
2. **Hermes 主機備份 cron**(一行,repo 外)
3. **確認 Hermes 0.2 A2A 規格**(啟動/endpoint/認證/Agent Card/streaming)
4. **P0 三項一起做,schema 採 A2A 資料模型**(先出設計文件再動手,同記憶 Phase 1 的流程)
5. **`a2a` adapter**(client 側)——P0 詞彙對齊後,傳輸層直連 Hermes A2A server
6. P1 按 #5/#6 → #7 → #8 順序(#4 已由 A2A 取代);#8(檔案整合)影響最大
7. P2 在 P0/P1 落地後自然浮現需求時再排

Meta 原則(貫穿所有項目):每張卡先問「真的需要多 agent 嗎?」——多 agent 甜蜜點是可平行的讀取型工作;緊耦合 coding 用單一 agent 串行通常更好。
