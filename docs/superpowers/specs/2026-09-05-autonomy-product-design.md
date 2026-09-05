# MegaCorps 整體檢查與修正設計

2026-09-05。這是檢查結果與實作設計，**不是已修復或已部署報告**。使用者要求繼續，現已在指定共享目錄開始實作。

2026-09-05 補記：SMB 寫入權限已恢復，Z: 已 fast-forward 至 85ec239；現在從同一共享目錄的 codex/autonomy-product-20260905 分支執行。以下權限失敗資訊保留為審查時的時間點記錄。

## 版本與工作目錄

- GitHub `origin/main` 與正式 web/server：`85ec23952545934bfe9fe318ea08f10e94392ea5`（上一輪側欄修正已 commit、push、部署）。
- 使用者指定的主開發目錄：`Z:\AgentsHub\megacorps`。它仍在 `59debb1a34e89aa549ce2d85d6645844904f35e9`，沒有未提交修改。
- 本輪嘗試 `fetch origin main` 被 `.git/FETCH_HEAD: Permission denied` 阻擋；在專案根目錄及 `.git` 建立暫存檔也遭拒。這是 SMB 寫入權限問題，不是 Git 衝突。Z: 映射到 `\\10.0.1.1\DataSet`。
- 檢查基準為先前本機 worktree 中的最新 commit；後續產品修改改回 Z:，先恢復共享目錄寫入權限，再 fast-forward 同步。本檢查證據暫存於本報告目錄。

## 已完成的檢查

1. 閱讀兩張使用者截圖、前次開發／文件生命週期報告與最新程式。
2. 正式環境真實登入，讀取 17 個主要頁面；沒有寫入業務資料、發送聊天、派工或觸發 cron。各頁讀取期間未觀察到 pageerror 或 HTTP 4xx/5xx。
3. 以 1158px 和 390px 檢查版面。第二次幾何檢查明確等待側欄轉場結束，避免把轉場中間尺寸當成缺陷。表格／組織圖內部可捲動區域超出 viewport，不直接判定為整頁出界。
4. API Help 的 5 個現有測試全通過，141 個路由的 method/path 名單相符；另以真實 GET 回應驗證欄位，發現現有測試沒有攔住的四項契約漂移。
5. 對回報、完成門檻與審查解析執行純函式探測；並行只讀審查 UI、組織圖、自主流程及預算路徑。

## 15 項逐項結論

| # | 檢查結論 | 建議落實方式 |
| --- | --- | --- |
| 1 角色／工作流 | 已有 Boss/head playbook，但選擇與刷新不一致，Boss 派工也只是文字建議。使用者已確認：最少 Boss＋一位部門主管；没有員工時主管可執行。 | Boss 專責方向、部門分派與目標驗收；有員工時主管分派與交付驗收，無員工時主管執行。伺服器依結構決定角色及合法轉移，另提供獨立 Boss/head prompt 編輯欄位。 |
| 2 成果／request／失敗處理 | 回報契約互相矛盾，`report.workProducts` 會被 schema 丟棄；格式糾正可無限重派。 | 統一輸出／webhook 契約，平台補齊 PR/SHA 與成果登記。request 只保留種類與具體需要；有限修復、退避、新 context 與角色內升級。 |
| 3 Logs | 一次載入所有分頁、完整 prompt 和 request/response，直接渲染全文。正式樣本約 18.18 MB，273 筆 prompt、6,494 DOM nodes，最長主執行緒工作 1,641ms。 | 只取目前頁籤；50 筆游標分頁；server 搜尋/filter；摘要列表，展開才取全文；取消過時請求。記錄 API 不再把讀取日誌的完整回應再次存進日誌。 |
| 4 全 UI | 確認 Projects 欄位裁切、Direct Chat 壓縮、Dashboard 390px 內容寬 454px，以及多個表單資料行為缺陷。 | 修共用 grid 的最小寬度及換行，對實際欄位寬度響應；保留表格／O-Chart 的區域捲動。補桌面、窄桌面、手機和長內容回歸。 |
| 5 API／Help | 路由清單吻合，資料契約不吻合；見下表。報告 prompt/schema 也不吻合。 | 共用可執行 schema 產生 Help、範例及驗證；契約測試要覆蓋 request、response、狀態與權限，不能只比 method/path。 |
| 6 O-Chart | 畫面忽略 position.rank，按 bossId 遞迴樹排列；沒有部門框。保存 Agent 還會送 `capabilities: []` 清空能力。 | Rank 控制垂直位置，部門為有框的分組；bossId 只決定線。改為正交繞障路由，支援低位置主管管理高位置員工；保存保留未編輯欄位。 |
| 7 Default Company／教程 | 既有 Default Company 不是空殼：包含 `playground` 專案和一個職位。首次註冊依賴預設公司，不能只删 seed。 | 無公司也可建立首位帳號；建立公司精靈取代 seed。既有 `playground` 去向需確認；移除 default 的程式先檢查所有關聯，保留使用者資料。 |
| 8 部門職掌 | `field-wide` 只有 Projects CSS 實作，在 Department form 無效，所以仍與主管並排。 | 主管佔獨立行，職掌放下一行，textarea 兩行。 |
| 9 Projects | 兩欄各至少 260px，窄 editor 不夠卻只看 viewport 1100px 斷點。Goals 綁定／POST 正常，但未存專案時禁用不清楚、title/body 並排。另有切換新專案時複製上一個 publish token 的缺陷。 | 以 editor 寬度換行；Goal title、body 各自一行；先儲存專案的提示清楚，錯誤留在欄位旁。Runtime Commands 收進進階，保留已存值；新專案清空出版目標和 token。 |
| 10 Company docs 注入 | 不是所有調用都有。task bootstrap 先取最新 10 筆才 filter，舊的相關規則會消失；chat/review/delegation/delta 缺公司文件。 | 全調用共用 context builder。公司必讀文件先注入，相關性 filter 在 limit 前，附文件 ID/版本；變更後補增量，顯示截斷及可取回參照。 |
| 11 Hermes SSH | 仍能在多處新建／選取；現場仍有一位舊 SSH Agent。 | 隱藏新建選項；舊記錄標示「舊版連線」並保留讀取／停用能力，避免 UI 隱藏時順便破壞現有資料或更改 Hermes runtime。 |
| 12 Direct Chat | company rail 有六個 children，CSS 只定四列；三欄常駐吃掉至少 490px，聊天區過小。 | 公司／專案／Agent 改上方選擇列，桌面保留 Sessions＋Conversation；手機一次顯示一個 pane，用 Sessions 按鈕切換；輸入區可正常伸展。 |
| 13 新卡片減法 | 審批、依賴、critical 都有行為，不能只删 schema。選 reviewer 還會錯誤連動 `requiresApproval`。 | 主表單只留專案脈絡、標題、要求和「自動交給 Boss」；組織／驗收從公司政策推導。人類簽核、依賴、critical、排程等放進階。選 reviewer 不再自動增加人類 gate，排除自我審查選項。 |
| 14 全自主生命周期 | 已證實 missing evidence fail-open、runtime 呼叫成功當作任務成功、歷史 REJECTED 蓋過本次 PASS、先合併後 wait 無 reconciliation、拆解失敗仍繼續完成。 | 優先修伺服器狀態與成果門檻。角色 prompt、工具預檢、結構化回報、驗證、有限重試和補償共同完成自主流程；驗收不能以卡片 Done 代替成果證據。 |
| 15 預算 | 目前不準，也不具備一致的硬停語義；估價固定、漏帳、月範圍錯誤、runner 繞過、單任務累積未限制。 | 建立唯一 usage ledger，標明 actual／estimated／unknown；所有執行路徑一致結算，公司／Agent／卡片的上限語義明確，使用交易及預留量處理並行。 |

## API Help 的現場反例

| GET | Help | 真實 200 回應 |
| --- | --- | --- |
| `/api/dashboard` | `stageCounts` | `stages` |
| `/api/dashboard/timeseries` | array | `{ days, points }` |
| `/api/cron/status` | `lastRunAt` | `lastStartedAt`、`lastCompletedAt`、`lastStatus`、`lastError` 等 |
| `/api/search` | array | `{ query, cards, agents, projects, companies, chatSessions, knowledgeDocs }` |

`/health`、`/api/me`、`/api/auth/status` 的抽查主要欄位吻合。以上抽查不代表 141 條路由所有輸入與權限都已動態驗證；後續修改時在本機 integration suite 補完整契約，避免在正式環境為測試寫入／刪除資料。

## 建議設計：公司政策驅動的自主執行

可行方案有三種：只整理表單／prompt 的改動較小，但已證實的狀態與成果漏洞仍在；整個調度器重寫的遷移範圍最大；**建議沿用現有卡片／run／review 結構，集中完成契約、角色判定、驗證與結算入口**，逐段替換重複邏輯。

### 角色與最小兩 Agent 模式

使用者只提供目標、已有資料和限制。Boss 明確列出必要假設、可驗收結果及適合的部門，建立有效部門任務後等待。主管有員工時分派，只有自己時執行；跨部門衝突或方向改變交回 Boss。Boss 根據交付摘要和平台驗證證據判斷是否達成目標，不 clone、不寫碼、不替員工登記成果。

獨立 prompt 以公司資料與結構化角色組合，範本：

> 你是 {company} 的 Top Agent／Boss。你負責目標、優先順序、限制、部門選擇與跨部門協調。把可執行工作交給合適的部門主管；等必要交付與驗證完成，再評估原始目標是否達成。不要替主管或員工執行實作。

> 你是 {company} 的 {department} Department Head Agent。你負責拆分部門工作、依能力分派、處理阻礙與最後交付把關。部門沒有其他可執行員工時，由你完成工作並提交驗證證據；已有適合員工時，由員工執行、你驗收。

伺服器必須強制：Boss 未成功委派不能假完成；拆解錯誤不能被 catch 後放行；子卡未接受不能完成父卡。預設允許有限假設下直接執行，只有確實缺權限、缺不可推定的資料、預算或驗收政策無法滿足時提出 request。

兩 Agent 模式沒有第三個獨立專業 reviewer。預設走主管自檢＋平台可執行驗證＋Boss 的目標驗收，清楚記錄驗證類型，不冒稱獨立同儕審查。要求獨立審查或高風險 gate 的卡片，必須有另一位具能力 reviewer 或明確人類簽核，不能藉兩人模式跳過。

### Agent 只需要一個短回報契約

建立有版本的 envelope：`version`、`status`、`summary` 為基本欄位；依階段附 `workProducts`、`request`、`children` 或 `verdict`。狀態統一為 progress／completed／blocked／failed，由平台轉成卡片狀態；review 的本次 verdict 用明確 enum。

- 成果只需連結或檔案參照＋一句說明；平台只對已配置的 repo/provider 補查 PR、branch、完整 SHA 和驗證資訊。
- request 分 clarification／permission／dependency／resource，包含具體需要；runtime permission 與成果驗收是不同狀態。
- 相同 schema 同時用於回傳內容、A2A artifact、webhook、Help。只注入當前角色／階段需要的短範例。
- present-but-invalid 的回報進有限糾正；不能默默丟掉後當成功。無 HTTP 寫入能力時仍能透過既有 transport 回報成果，由平台按其身份與任務 scope 持久化。
- 儲存與跨任務傳播前移除已知秘密值、帶憑證的 URL；憑證不放在子卡要求和一般回報中。

### Retry、fallback 與完成門檻

- 網路／runtime 暫時失敗沿用持久化退避；格式錯誤單獨計數，一次短糾正、一次新 context 重試，再交主管接手或依公司已配置 fallback 換執行者。
- 切換 Agent／模型仍受相同權限、角色與預算限制；不能為避開權限拒絕換身份重試。Boss 自身不可用時顯示具體公司設定／資源 request。
- 可執行驗證及必要成果未齊，completed 只代表提出交付，不能直接 Done。
- PR 合併門檻返回 not_required／ready／missing_evidence／temporarily_unverifiable；需要合併而證據不足時保持未完成。
- 建立 wait 時立即核對 repo 狀態，之後有界 reconciliation，處理先合併後等待、事件重複、事件先後及重啟。核對已批准 head，head 改變必須重審。
- 防止提前合併需要 repo 權限與 protected branch 配合；實作前先只讀查現場設定，產出精確變更，不能假定 prompt 足以禁止 write collaborator 合併。

Hermes 官方說明將 Tirith 判定納入 approval 流程；`tirith_fail_open` 只針對掃描器不可用／逾時，並不等於允許已被判定有問題的命令。[官方安全文件](https://hermes-agent.nousresearch.com/docs/user-guide/security/)

因此建議新手設定加入實際 clone／工作目錄／回報／PR 能力預檢，明確列出需由管理者核准的指定 repo、host、操作。平台正常回報流程由受任務 scope 約束的服務端持久化，避免每個 Agent 自己拼 curl。真正 runtime 拒絕須被如實回報；此設計不要求關閉 Tirith 或啟用全域無限制模式。實際 Hermes 版本及允許政策需在部署前核對，不能把線上最新文件當成已安裝版本。

### O-Chart 的可驗收規格

每位 Agent 只畫一次，Rank 越小越靠上。部門按有標題的框分組，未分部門及公司層另有區域；沒有 position 的 Agent 放入明確的未設定區。位置由 rank 決定、報告線由 bossId 決定，不修改真實管理關係來配合畫面。

線由主管卡片底部向下離開，使用水平／垂直折線繞行，再由下屬卡片上方進入。若下屬位置比主管高，先繞到外侧通道再向上。除自己的端口接入段外，線與所有 Agent 元件可視外框至少距離 10px，並計入 stroke 寬度；禁止 Bezier／曲線和穿越其他卡片。需要量測卡片後做 obstacle routing，不能只靠 CSS pseudo-elements。

自管／循環引用的新資料必須被 API 拒絕；舊壞資料顯示問題關係，所有節點仍可见，不得隱藏或重複。部門、Rank、畫面尺寸或卡片大小變動後重新排線。

### 表單與新手設定

新手精靈依序建立公司目的 → Boss → 第一部門及職掌 → 主管 → runtime 連線與能力檢查 → 確認。允許儲存未完成設定繼續補，但未達最低結構時不派工。

新卡片預設只有「要做什麼」與「要求／資料」，公司／專案依目前頁面預填、交給 Boss。適合進階用戶時仍可手選執行者／reviewer；既有 required-review schema 與公司 policy 一併調整，不能 UI 刪掉 checkbox 卻讓 API 拒絕。

Runtime Commands 目前真正注入派工和聊天提示，用來提供 setup/test 等執行方式。移到「進階：執行與驗證」，空值允許 Agent 從 repo 慣例偵測；保留自訂值與已儲存服務設定，隱藏時不寫空值覆蓋。Dependencies／Critical 亦採進階，不刪其 dispatch／review 能力。

Default Company 的 `playground`（`d7045344-78fb-47d6-9962-030d3c1465f5`）需要先指定保留／搬移或刪除；本輪未操作。現有公司刪除檢查漏了多張關聯表，且會刪全部 positions／活動，因此不能直接呼叫現有 delete 當成安全清理。移除 seeded default 必須同時修首次註冊、bootstrap、global audit、runner／CLI 的隱含 default fallback。

### 預算與成本

現有所有主要 adapter 都使用文字估值，且 `model` 實際常記成 Agent profile 名。現場最新 500 筆 cost events 的 inputTokens 全為 0；這只是被截斷樣本，不能把它與 dashboard 總額直接對帳。

已確認的其他缺陷：runner 不入成本 ledger／不扣 Agent 預算；warning-only 也會擋派工；per-task 比單次呼叫而非累積；card.taskBudgetLimit 沒被執行門檻使用；並行完成使用舊 spent snapshot 做決定；重試、失敗、晚到／取消輸出可能漏算；月重設錯過指定日期就不補做，還會清掉所有 Agent 的 busy 狀態。

設計為按 run/attempt/provider-event identity 去重的 usage ledger。實際量、估計量、未知量分開，晚到真實 usage 修正估計但不重複加費。所有 task、review、chat、maintenance、runner、webhook、失敗及取消結果統一結算。UI 各頁與預算用相同期間／scope 查帳，公司額度計公司總和，卡片額度計重試及審查累積。

按月份時間窗查詢，取消破壞式 spent/reset；預算暫停與手動停用／執行容量分離。並行派工使用交易和預留量，未知成本清楚顯示，不顯示為免費。是否能與 provider 帳單精確一致，取決於 runtime 是否提供完整 usage/模型／價格來源；介面必須呈現這個證據等級。

## 建議實作分組與驗收

1. **交付契約與狀態**：report/schema/Help、失敗結果、Boss 分派、成果正規化、fail-closed、review verdict、reconciliation、遮蔽、有限 retry。
2. **角色與設定**：集中 prompt／knowledge 注入、两 Agent 模式、新手精靈、移除隱含 default、SSH 新建選項。
3. **表單與效能**：Logs 列表／全文 API 和分頁、Projects／Goal／Department、Direct Chat、新卡片減法、共用窄版問題。
4. **組織圖**：Rank／部門框／正交繞線／保存 capabilities／循環防護。
5. **成本**：統一 usage settlement、範圍／月份／累積／並行預算，UI 真實性。
6. **整合**：全部測試、typecheck、production build、CI/Docker；然後沿既有授權更新 stack 42，驗證實際 revision 和服務健康。

每個可獨立審查的修復先紅後綠、獨立 commit；新契約變更保持舊資料與舊事件可轉換。具體測試包括：URL-only PR、缺失／不可達證據、權限阻擋、failed/input_required、無效 children、純歷史 REJECTED、事件早到／重複／head 漂移、重啟後 retry 次數、不同注入 surface、公司／專案切換不複製 token、幾何留距和轉場完成後尺寸、成本重複／晚到／並行及月末。

最终自主驗收使用兩個新隔離測試專案：一個小型開發目標、一個文件目標，僅提供自然語言目標和少量限制，不提供 curl／schema／手工步驟。至少驗證 Boss→單主管，以及有員工時 Boss→主管→員工。全程記錄自動採納的假設、分派、成果、驗證、review、合併／發布和收尾；不由 operator 補欄位或重送事件。遇到需要真實新增權限的任務須正確停為 request，不能把停住包裝為 Done。

## 主要程式證據位置（皆以 85ec239 為準）

| 範圍 | 檔案與行 |
| --- | --- |
| Logs 全量讀取／渲染 | `apps/web/src/components/logs-page.tsx:56`、`:160`；`apps/server/src/routes.ts:726`；`apps/server/src/request-log.ts:75` |
| API Help 漂移 | `apps/server/src/api-help.ts:395`、`:635`、`:643`；`api-help-coverage.test.ts:42` |
| Merge gate | `apps/server/src/merge-gate.ts:163`、`:323`、`:374`、`:425` |
| 回報狀態／糾正 | `packages/shared/src/index.ts:425`；`apps/server/src/dispatch.ts:382`、`:2726`、`:3328`、`:4608` |
| 審查／知識 | `apps/server/src/dispatch.ts:499`、`:4914`、`:4940`、`:4996`；`chat.ts:100` |
| Projects／Goal | `apps/web/src/components/project-authority-panel.tsx:97`、`:135`、`:174`、`:364`；`globals.css:5190`、`:5650` |
| Chat／Department／Card | `chat-page.tsx:346`；`globals.css:4801`；`departments-page.tsx:267`；`kanban/card-details-form.tsx:74` |
| O-Chart | `apps/web/src/components/company-o-chart-page.tsx:9`、`:54`、`:115`、`:155`、`:209`；`globals.css:5560` |
| Default／signup／delete | `apps/server/src/db/migrate.ts:490`；`routes.ts:510`、`:550`、`:1189`、`:1231` |
| 成本／預算 | `apps/server/src/adapters/hermes.ts:51`；`routes.ts:927`；`dispatch.ts:2184`、`:2482`、`:4072`；`runner-routes.ts:129`、`:403`；`chat.ts:459` |

本目錄的實測證據：`production-audit.json`（效能／初次巡查）、`ui-geometry.json`（等待轉場後的版面）、`api-contract-audit.json`（真實 API 欄位）、`projects-1158.png`、`chat-1158.png`、`departments-o-chart-1158.png` 及對應手機圖。初次巡查的轉場中間尺寸不作最終版面缺陷判定。

