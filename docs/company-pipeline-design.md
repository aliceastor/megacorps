# MegaCorps 公司流水線設計(唯一大方向)

> 2026-09-01 定案。本文件是 MegaCorps 產品方向的單一真相來源;其他 docs 與此衝突時以本文為準。
> 前置:[git-centric 藍圖](./roadmap-status.md)(Gitea、NFS 目錄、per-agent 身分、跨 surface 摘要、peer @mention)已於 2026-08-31 全部落地。

## 0. 願景(用戶原話整理)

> 我/Client 提出想法 → 公司自動拆解需求、brainstorm、修改 → 過程中可能要跟我確認大方向或中期成果 → 最後完成我的想法。
> 過程由 **CEO(公司 boss)+ 各部門主管** 協作,不同部門負責不同部分;**部門主管負責有效分配整個部門的資源**來完成任務。

一句話:**MegaCorps 模擬一間真正的公司,用戶是客戶,不是專案經理。**

## 1. 角色

| 角色 | 是誰 | 系統對應 | 職責 |
|---|---|---|---|
| Client | 用戶(人) | 目標卡的建立者 + **最終審理員** | 提想法、回答 checkpoint、最終驗收 |
| CEO | agent | 持有 `positions.isCompanyBoss` 職位的 agent(每公司一位) | 評估、brainstorm、拆給部門、整合、對 client 負責 |
| 部門主管 | agent | **新增** `departments.head_agent_id` | 拆給成員、分配部門資源、部門內驗收 |
| 成員 | agent | `agents.departmentId` + boss 鏈 | 執行、專業審 |
| 專業審理員 | agent | 卡的 `reviewerId` | 擋 bug / 擋品質問題(不驗收目標) |

現行事實:只有 CEO 有系統概念;部門主管沒有。boss 鏈(`agents.bossId`)是唯一的上下級真相,拆卡與 DELEGATE 都只認直屬下屬。

## 2. 一張目標卡的一生

```
① Client 建目標卡(負責人=CEO,審理員=Client,requiresApproval=true)
② CEO 評估:單部門且需求清楚 → 跳到 ④;否則 → ③   (Client 可在建卡時勾「強制 brainstorm」)
③ Brainstorm 輪:CEO 廣播提問給全部部門主管 → 各自回提案 → 全部回覆或逾時 → CEO 綜合成方案
④ Client checkpoint「方向確認」:拆解方案(涉及部門、各做什麼、依賴、里程碑)→ 阻塞等 Client 回答
⑤ CEO 拆解:一部門一張子卡(負責人=部門主管、審理員=CEO),跨部門依賴用卡依賴
⑥ 部門主管拆解:看成員負載/能力/CV → ≤3 張成員卡(審理員=主管或主管指定的專業審)
⑦ 成員執行 → 專業審 → 子卡 done(現行 dispatch/review 鏈,repo 進 Gitea)
⑧ (可選)中期 checkpoint:主管/CEO 把 interim output 送 Client → 阻塞等回答
⑨ 成員卡全 done → 部門卡回主管「整合」→ 主管送 CEO 審 → 部門卡 done
⑩ 部門卡全 done → 目標卡回 CEO「整合」→ 送 Client 最終驗收
⑪ Client 批准 = done;退回 = 帶意見回爐(REJECT loop,現有)
```

每一步都在**父卡留言板**留下事件,父卡留言板 = 這個目標的完整敘事與審計帳本(見 §6)。

## 3. 拆卡規則(組織版)

**樹的邊界 = 組織圖。** 不用寫死層數,組織圖是人畫的,樹永遠長不出沒授權的形狀。

1. **只能拆給直屬下屬**(`agents.bossId` 鏈;與 DELEGATE 共用同一段檢查)。沒有下屬的 agent 拆不了卡。
2. **每個節點同時最多 N 張「活著」的子卡**(未 done / 未 cancelled)。N 預設 3、公司可調、硬上限 5。**CEO 例外**:上限 = 涉及的部門數,且同一部門同一輪只能一張。
3. **輪次**:本輪子卡全部關閉、父卡負責人完成整合驗收後,才能開下一輪。一張父卡一生最多 3 輪(保險,正常任務不會碰到,碰到即人介入)。
4. **每張卡(不分 agent 拆的還是人建的)必須指定審理員,且審理員 ≠ 該卡負責人。** 拆卡者可自任審理員。預設:成員卡 → 部門主管;部門卡 → CEO;目標卡 → Client。沒有免審。
5. **每張子卡是一個可獨立驗收的交付物**,body 必須含驗收條件(系統軟檢查:body 過短拒收)。
6. 人類在 UI 拆卡不受 1–3 限制,但超過時顯示警告。

**拆法 SOP(寫進 CEO / 部門主管的職位 prompt;來自 2026-09-01 提案 §四)**:
- 按**交付物切片**拆(每張子卡端到端可驗收),不按技術層拆(「前端一張、後端一張」= 兩張都不可驗收)。
- 每張子卡的工作量 **≤ 負責人的 timeout 窗**;預估超過就要再切——這直接消滅長任務 timeout。窗口大小看該 agent 的設定,不寫死分鐘數(文件/圖檔類任務的節奏跟程式不同)。
- 依賴顯式:B 等 A 就設卡依賴,不靠留言「我先等你」。
- 同構任務(N 個檔案各自處理)用 swarm 形態:一輪內平行分給多個成員,每人一份切片。

**與 DELEGATE 鏈的分工(prompt 講死)**:
> 獨立交付物、需要自己的審理員、要在看板上被看見 → **拆子卡**;只是我這份交付物裡的一段幫忙、審理員還是我的審理員 → **DELEGATE**(卡內委派鏈,現有,深度 3 / fan-out 16 護欄不變)。

歷史教訓:child card 當年被禁是因為**無上限的平行展開**。上述規則下,任一目標卡在看板上任一時刻最多 1 + 部門數 + 3×部門數 列,且每層都有整合檢查點——碎片爆炸在結構上不可能。

## 4. Client checkpoint(核心新機制)

**阻塞式**(定案):發問的那張卡及其子樹暫停,其他不相關的卡照跑;Client 回答後繼續。

- 誰能發:目標卡/部門卡的負責人(CEO、部門主管)。成員不能直接問 Client,要經主管。
- 怎麼發:結構化報告加 `checkpoint` 欄位:
  ```json
  "checkpoint": { "kind": "direction" | "interim", "question": "...", "options": ["A", "B"], "recommendation": "A", "artifactRefs": ["..."] }
  ```
- 系統動作:卡進 `waiting_on_client`(**新 columnStatus,定案**;不沿用 `waiting_on_external`——那是等機器事件、回應是 success/failure,checkpoint 等的是人的判斷、回應要注入下一輪 prompt,語意不同,列表也要一眼分得出「等 CI」與「等 Client」);建 `approvals` 列(type=`client_checkpoint`,payload=問題/選項/附件);通知 Client(現有 notify);父卡留言板記事件;釋放 execution lock。
- Client 回答:UI(通知鈴 / 卡片頁 / 列表列內)選選項或自由文字;寫入 `approvals.decisionNote`;卡回 `in_progress`,**答案注入該卡下一輪 prompt 的最前面**(「Client 對你的 checkpoint 回覆:…」)。
- 提醒:超過 `CLIENT_CHECKPOINT_REMIND_HOURS`(預設 4)未回,再通知一次;每日最多一次。
- 「中期成果」型 checkpoint 必附 workProducts(repo 路徑 / URL),Client 看得到成品。
- 現有 `approvals` 表(payload、decisionNote、decidedByUserId、notify)已是八成骨架,只加 type 與 UI。

## 5. Brainstorm 輪

**觸發 = CEO 判斷 + Client 可強制**(定案)。

- CEO 判斷規則(寫進 CEO 職位 prompt):涉及多部門、需求模糊、或預估超過一個部門一輪能完成 → brainstorm;單部門且清楚 → 直接拆或直接派。
- Client 建卡可勾 `forceBrainstorm`(卡欄位),覆蓋 CEO 判斷。
- **參與部門必須指定,不是全公司廣播**(定案):公司可能有很多不相干的部門(例如 Civil Engineering 對一個網站需求完全無關),把它們拉進來只是燒 token 和拖時間。
  - CEO 在 broadcast 裡**點名部門**:`broadcast: { departments: ["it", "content"], question }`,至少一個;系統只對被點名部門的主管各建一則 `peer_question`。沒點名 → 拒收並回傳部門清單要它選。
  - CEO 據以選部門的資料:每個部門的**職掌描述**(新增 `departments.description`,人填,一句話寫這個部門負責什麼)+ 該部門主管的能力聲明,注入 CEO 的評估 prompt。沒寫職掌的部門 CEO 看不懂就不會點,所以職掌是部門設定的必填項。
  - Client 建卡時可預選 `brainstormDepartmentIds`,作為 CEO 的**下限**(CEO 可以多加、不能少於 Client 點的)。
  - 被點名的主管若判斷自己部門不相干,可直接回「不參與,理由…」——一個便宜的 opt-out,CEO 綜合時記入「已徵詢、不參與」,避免 CEO 多點名的成本失控。
  - 方向確認 checkpoint(§4)要列出「徵詢了哪些部門、誰參與、誰不參與」,讓 Client 能一眼抓到漏掉的部門。
- 機制:擴充 peer @mention——`broadcast` 繞過單次 3 人上限,但**只有 CEO/主管可用**;CEO 的卡進 `waiting_on_brainstorm`;全部 `peer_answer` 到齊或 `BRAINSTORM_TIMEOUT_MINUTES`(預設 30)逾時 → 重新 dispatch CEO,提案彙整注入 prompt → CEO 產出拆解方案 → 進 §4 的方向確認 checkpoint。
- 提案與 CEO 的綜合都留在目標卡留言板。

## 6. 留言板 = 敘事與審計帳本

父卡留言板必須出現的系統事件:
- 「第 N 輪拆出 K 張子卡:A(→x,審 y)…」(可點)
- 每張子卡首則留言:「從父卡《…》第 N 輪拆出;驗收條件:…」
- 子卡每次階段變化(進 review / 被退 / done / blocked)回寫父卡一則短留言
- checkpoint 發出與 Client 的回答
- brainstorm 提問、各主管提案、CEO 綜合
- 「第 N 輪全部完成,回到 <負責人> 整合」

列表視圖把子卡展開成縮排子列,只是父卡留言板的即時投影;兩者一致。

## 7. 驗收鏈的修正

現行 `cascadeParentStatus`:子卡全 done → 父卡**直接**進 `in_review`。公司流程要改成:

子卡全 done → 父卡回 `in_progress`、rollup=`integrating`、重新 dispatch 給**父卡負責人**,prompt 明說「你的 N 張子卡已全部完成,整合它們的產出,產出本卡的交付物,再送審」→ 負責人回報 → 進 `in_review` 給審理員。

兩層審不重複:子卡審理員 = 專業審(品質);父卡審理員 = 驗收審(目標達成)。prompt 分別寫明審什麼、不審什麼。

## 8. 部門主管的資源視圖

主管收到部門卡時,prompt 注入每位直屬成員:
- 目前負載:活著的卡數、`isBusy`
- 能力聲明:`agents.capabilities`(現有欄位,結構化為 level / capabilities / responsibilities 寫在職位 prompt + agent capabilities)
- 動態 CV:近 20 次任務的評分平均與樣本數,按審計域(代碼 / 內容)分開
- 最近 REJECT 原因(來自 review feedback)

CV 資料來源:reviewer 在結構化報告填 `score: 0-10`(**加進 `agentReportSchema`,不用正則抽文字**),rubric 寫在 reviewer prompt;SQL 聚合;**併入現有 `agent-digest.ts` 管線**注入,不另起一套。

主管可自己執行小項(player-coach),但 prompt 要求優先分配。

**評分與 CV 的細則(來自提案 §十一,採納)**:
- Rubric 寫死在 reviewer prompt:9–10 全綠且超預期 / 7–8 綠但有小瑕疵 / 5–6 勉強過 / 3–4 與 0–2 為 REJECT 的兩個等級。`score` 管績效,`verdict` 管流程(merge / 退回),兩者並存。
- 動態績效 = **最新 20 次的平均**(滑動窗口抓趨勢);冷啟動有幾次算幾次並標樣本數,樣本 < 5 時注入要標「資料不足」。
- 分數**按審計域分開**(代碼 / 內容 / …),永不跨域比較;MVP 每域一位審計員,分數天然同源。同域出現第二位審計員時才做 calibration(審同一批樣本卡對齊錨點),現在不建。
- 冷啟動兩層並存:能力聲明(靜態,人寫)打底,CV(動態,審計累積)漸進覆蓋;CV 只反映「被審計驗證過的能力」,未驗證的能力不被優先派——保守但正確。
- 審計域的來源:審計員的職位帶 `reviewDomain`(見 §10);卡的域 = 其審理員的域。

## 9. 與現有機制對照

| 需要 | 現有 | 缺口 |
|---|---|---|
| CEO 身分 | `positions.isCompanyBoss` | 無 |
| 部門主管身分 | 無 | `departments.head_agent_id` |
| 拆子卡 | `parentCardId`、`requiredChildPolicy`、`ensureParentWaitingOnChildren`、`completionBlockedByChildren`、`cascadeParentStatus` | 報告欄位 `children[]`、guard(§3)、cascade 改整合優先(§7)、prompt 撤禁令 |
| 跨部門依賴 | `dependencyCardIds` | 無 |
| Client checkpoint | `approvals`、notify、`waiting_on_external` | type、`waiting_on_client`、回答 UI、答案注入、提醒 |
| Brainstorm | peer @mention(`report.mentions`) | broadcast、收齊/逾時後重新 dispatch |
| 資源視圖 | `directReportList`、`agents.capabilities`、`agent-digest.ts` | 負載、CV 聚合、注入 |
| 評分 | `agentReportSchema.verdict` | `score` 欄位 + rubric |
| 留言板事件 | `addCardMessage` | 六種新事件 |
| 列表視圖 / 三區制 | 無(kanban-board.tsx 牆式) | 前端新頁 + 子列 |

## 10. Schema / API / Prompt 變更清單

**Schema(一次 migration)**
- `departments.head_agent_id UUID`
- `kanban_cards.force_brainstorm BOOLEAN DEFAULT false`
- `kanban_cards.brainstorm_department_ids UUID[]`(Client 預選的參與部門,CEO 的下限)
- `departments.description TEXT`(部門職掌,CEO 選參與部門的依據)
- `agents.default_timeout_seconds INTEGER`(每個 agent 的 timeout 預設;卡未覆寫時用它,再沒有才用全域值——提案 §五說的「timeout 分級」目前只能逐卡手填,系統沒有這一層)
- `positions.review_domain TEXT`(審計域:code / content / …,CV 分域統計的鍵)
- `kanban_cards.split_round INTEGER DEFAULT 0`(父卡已開的輪數)
- `companies.max_children_per_card INTEGER DEFAULT 3`
- `columnStatus` 新增 `waiting_on_client`、`waiting_on_brainstorm`(shared `cardStatuses` + transitions)
- `approvals.type` 新值 `client_checkpoint`

**Shared schema**
- `agentReportSchema` 加 `children[]`、`checkpoint`、`broadcast { departments[], question }`、`score`

**API**
- `POST /api/approvals/:id/decide` 支援 checkpoint 回答(選項 + 文字)
- `PUT /api/departments/:id` 支援 `headAgentId`
- 列表視圖用的 `GET /api/cards?view=tree` 或前端自組
- `decisionMode` enum 改為 `auto | solo | pair | swarm`(shared schema);舊值 `execute/delegate/hybrid/review/integrate` 讀取時映射(`delegate`→`auto`),不做資料遷移

**Prompt**
- 撤「child cards are legacy」;加 §3 分工規則與六條限制
- CEO 職位 prompt:評估規則、brainstorm 觸發、拆解 SOP、checkpoint 時機
- 主管 prompt:資源視圖使用方式、拆卡 SOP、整合職責
- reviewer prompt:score rubric、專業審 vs 驗收審的邊界
- 整合 prompt(§7)

**UI**
- 列表視圖(提案 §一的規格全數採納):欄位 專案 / 標題 / 階段 / 負責人 / 審理員 / 部門 / 協作模式 / **最近活動**(相對時間);階段用顏色 badge(新增 `waiting_on_client` 與 `waiting_on_brainstorm` 兩色,要跟 `waiting_on_external` 分得開);預設按最近活動降序(在動的浮上來,卡死的沉底);過濾器 專案 / 階段 / 負責人 / 「只看我的審計」/ 「等我回答」;子卡縮排成子列;成本欄可加總;卡片牆保留為切換視圖;hover 顯示最近活動摘要
- 卡片詳情三區制(提案 §二):① 概要區常駐(標題、body、負責人、審理員、階段、依賴、優先級/協作模式/需審批/最大重試);② 過程區分頁籤(「對話」= 留言板與工單串合併、「產出」= workProducts、「歷史」= execution log 與 task logs);③ 運行時區預設折疊(UUID / session / 重試 / 鎖 / 成本)。**注意**:UI 把「階段負責人 / 階段審核者」收進對話籤的委派事件裡顯示,但後端的委派級 `reviewerScope`(phase / final)必須保留,它是委派鏈與 peer question 的依據;「目標」「標籤」先隱藏。DELEGATE 在 UI 上是對話籤裡的事件,不是欄位。
- checkpoint 回答面板 + 通知
- 部門設定:主管欄位 + 職掌描述(必填);建卡:強制 brainstorm 勾選 + 參與部門預選

## 11. 實施階段

1. **A 組織與拆卡**:`head_agent_id`、`children[]` 報告欄位、guard、cascade 改整合優先、留言板事件、prompt 撤禁令 —— 後端,可測 — **✅ 2026-09-02 完成**。落地內容:migration v13(`departments.head_agent_id/description`、`kanban_cards.split_round`、`companies.max_children_per_card`、`agents.default_timeout_seconds`、`positions.review_domain`);`card-splitting.ts` 純規則引擎(9 個單元測試)+ dispatch 側 `processChildSplits`,掛在 dispatch 與 webhook 兩個完成點;`cascadeParentStatus` 改為子卡全關 → 父卡回負責人 `integrating` 並重新 dispatch,prompt 帶「整合回合」段落;留言板事件 `split_opened / split_child_opened / split_rejected / split_round_complete`;`decisionMode` 改 `auto|solo|pair|swarm`(舊值讀取映射),強制 delegate 退場,solo 同時擋 DELEGATE 與拆卡;每張卡必有審理員(`createCardSchema` refine:reviewerId 或 requiresApproval,且 ≠ assignee;chat 建卡預設 requiresApproval);`PUT /api/departments/:id`;UI:建卡協作模式四選項 + 審理員必填檢查、部門頁主管/職掌欄位。與文件的差異:人類在 UI 拆卡不受規則限制(文件規則 6 說要警告,UI 警告尚未做);`score` 欄位已進 schema 但 D 階段才消費。
2. **B Client checkpoint**:狀態、approvals type、回答 API、答案注入、提醒、通知 —— 後端 + 小 UI — **✅ 2026-09-02 完成**。落地內容:新狀態 `waiting_on_client`(shared 轉移表 `ask_client` / `client_answered`、rollup、lifecycle 進度);`client-checkpoints.ts` 純函數(解析、資格、提醒節奏、措辭,6 個測試)+ dispatch 側 `resolveClientCheckpointRequest / recordClientCheckpoint / finishRunWaitingOnClient / answerClientCheckpoint / sweepClientCheckpointReminders`;`report.checkpoint { kind, question, options, recommendation, artifactRefs }` 在 dispatch 與 webhook 兩個完成點都會覆蓋正常完成流程(不進 review / done / cascade);A2A `input_required` 由有資格者(CEO / 部門主管)在 requiresApproval 卡上發問時自動視為 direction checkpoint;`approvals.type = client_checkpoint`,`PUT /api/approvals/:id` 以 `status=answered` + `selectedOption / answer` 回答,回答寫進留言板並注入負責人下一輪 prompt(最近 3 筆 checkpoint 歷史,最新答案標為 binding),負責人自動重新 dispatch;`cancelled` 撤回並恢復;提醒 4 小時後一次、之後每 24 小時(`CLIENT_CHECKPOINT_REMIND_HOURS`);父卡留言板同步記事件;UI:Kanban 頁頂「等你回答」收件匣(選項按鈕 + 自由文字)、狀態色 amber。與文件差異:成員發的 checkpoint 不會轉給主管代問,而是拒收並提示改用 needs_review / mentions。
3. **C Brainstorm**:broadcast、收齊/逾時、CEO 重 dispatch、`forceBrainstorm` —— 後端 — **✅ 2026-09-02 完成**。落地內容:新狀態 `waiting_on_brainstorm`;`brainstorm.ts` 純函數(解析、點名部門驗證含 client 下限與無主管部門、輪次完成判定、措辭,7 個測試);`report.broadcast { departments: [slug], question }` 在 dispatch 與 webhook 兩個完成點覆蓋正常完成(checkpoint 優先於 broadcast);每個被點名部門的主管各收到一則帶 `brainstorm` 標記的 peer_question,回答走既有 peer 管線但 prompt 改為「提案或明說不參與」;cron `sweepBrainstormRounds` 在全部回覆或 `BRAINSTORM_TIMEOUT_MINUTES`(30)逾時後關輪、留言板記錄誰答了誰沉默、卡回負責人重新 dispatch,prompt 注入本輪各部門提案與「綜合成方案 → 需要 client 就開 direction checkpoint → 否則拆卡」的指示;CEO/主管的 prompt 常駐部門目錄(slug / 主管 / 職掌);卡新欄位 `forceBrainstorm`、`brainstormDepartmentIds`(client 下限)、`brainstormRound`,`forceBrainstorm` 未開輪前拆卡會被 guard 拒絕;UI:建卡勾「強制腦力激盪」+ 部門下限多選,狀態色 cyan。與文件差異:主管 opt-out 是自由文字回覆(不是結構化欄位),CEO 綜合時自行辨識。
4. **D 資源視圖與評分**:`score`、CV 聚合進 digest、主管 prompt 注入 —— 後端 — **✅ 2026-09-02 完成**。落地內容:migration v15 `agent_review_scores`(card / 被評者 / 審核者 / 域 / 分數 / verdict);`agent-cv.ts` 純函數(分數解析:結構化 `report.score` 優先、`Score: N/10` 行為保守 fallback;每域最新 20 次滑動平均、樣本 < 5 標 thin、通過率;團隊資源視圖排版;rubric 文字,3 個測試);`recordReviewScore` 掛在 adapter review 完成點與 webhook review 路徑,域取自審核者職位的 `review_domain`(預設 general);`teamResourceView(companyId, bossId)` 對有直屬下屬的負責人(CEO / 主管)在 bootstrap prompt 注入:每位成員的負載(活卡數、忙碌)、能力聲明、各域驗證紀錄、最近一次退件原因,並明說「聲明是提示、審核是證據、忙碌的人不會更快」;reviewer prompt 兩個變體都加 rubric;agent 編輯器新增可編輯的能力聲明欄位(原本更新時會被空陣列覆蓋——順手修掉)。與文件差異:CV 沒有併入 `agent-digest.ts` 的自我摘要,只注入給上級的資源視圖(agent 自己看自己分數暫無必要,避免 prompt 膨脹)。
5. **E 列表視圖 + 三區制 + checkpoint 面板** —— 前端(可與 A–D 並行開工,最後接線) — **✅ 2026-09-02 完成**。落地內容:`kanban-list-view.tsx` 新元件——專案 / 標題 / 階段(顏色 badge)/ 負責人 / 審理員(人類審批顯示「你」)/ 部門 / 協作模式 / 最近活動(相對時間)八欄,子卡縮排在父卡下、父卡依子樹最新活動浮上來,成本加總,快速過濾「等我回答」「等我審批」,點列開既有詳情面板;Kanban 頁加「列表 / 卡片牆」切換(預設列表,localStorage 記住);詳情面板:協作模式改成 auto/solo/pair/swarm、標籤收進「更多欄位」折疊、UUID/session/重試/鎖/成本收進「運行時細節」折疊(三區制的 ③);checkpoint 面板在 B 階段已上。與文件差異(2026-09-02 當日稍後全數補齊,見 §16):~~① 概要區沒有抽到分頁籤之外常駐~~ → 已常駐;~~② 留言板與工單串沒有合併成單一「對話」籤~~ → 已合併,DELEGATE / REVIEWER 籤變成「委派與審核」過濾器;③ hover 顯示最近活動摘要改由概要區的「最後動態」一行取代。
6. **F 職位 prompt 套件**:CEO / 主管 / reviewer / 整合 的預設 prompt 模板 —— 配置 — **✅ 2026-09-02 完成**。落地內容:`role-playbooks.ts` 四份「結構角色作業程序」(CEO / 部門主管 / 成員 / 審核者),**依組織結構自動注入、不看職位 prompt 文字**——職位 `isCompanyBoss` → CEO playbook;`departments.head_agent_id` 等於本人 → 主管 playbook;其餘 → 成員 playbook;審核 prompt 三個變體(完整審核 / 延續 session 審核 / 留言板委派審核)都帶審核者 playbook + 評分 rubric(完整審核那份原本漏了 rubric,順手補上);Direct Chat 與 Kanban 共用同一注入點(Kanban context 的 Invocation Agent Work Context 段,clip 上限 6000 → 9000)。職位 prompt 只負責人格、專業與公司規矩:五份模板(CEO / Department Head / Code Reviewer(域 code)/ Content Reviewer(域 content)/ Specialist)由 `GET /api/positions/templates` 提供,職位頁「Start from a template」一鍵填入(新建時連名稱 / slug / 描述帶入,公司尚無 boss 才勾 boss 旗標);新公司的 CEO 職位改種模板文字,migration v16 把仍是舊一行佔位文字的 CEO 職位升級成模板(自訂過的不動)。與文件差異:「整合」沒有獨立模板——整合指示已由 A 階段的整合回合段落(`integrationSection`)在子卡全關時系統注入,CEO / 主管 playbook 只保留「你會拿回卡片整合」的行為提醒。

A 是地基;B 是願景的靈魂;E 是「上手好用」的來源。

## 12. 未決與風險

- ~~`waiting_on_client` 用新狀態還是沿用 `waiting_on_external`~~:**定案用新狀態**(見 §4)。
- Brainstorm 逾時後只有部分提案:CEO 照綜合,缺席部門在留言板標記為「已徵詢、逾時未回」。
- CEO 點錯部門(漏了相關的 / 拉了不相干的):漏的由方向確認 checkpoint 的「徵詢部門清單」讓 Client 接住;多拉的由主管 opt-out 消化。兩者都不需要系統硬擋。

## 13. 順手要補的既有缺口(建議,非本文定案)

查 `waiting_on_external` 現況時發現三個既有缺口,與流水線正交但會影響體驗,建議排進 A 或 B 階段一起做:
1. `external_waits.pollIntervalSeconds` 沒有消費者:沒有 sweep 依間隔把卡重新 dispatch 去檢查外部系統,「輪詢」目前是空的。
2. `external_waits.timeoutAt` 沒有消費者:逾時不會自動 blocked、不會通知。
3. Gitea push webhook(`/api/gitea/events`)尚未對接 `external-events`:PR 合進 main 應自動觸發 success 喚醒等待中的卡,這才是「merge 進 main → done」的真閉環。
- CEO 判斷失誤(小任務走大流程 / 大任務沒 brainstorm):前者成本可接受,後者會在方向確認 checkpoint 被 Client 接住——這正是 checkpoint 阻塞式的價值。
- 部門主管是 player-coach:允許,prompt 要求優先分配;主管自己接成員卡時審理員不能是自己(規則 4 自動擋)。
- 一個 agent 同時是多個部門主管:允許但不建議,`head_agent_id` 不設唯一約束。
- ~~協作模式的語意~~:**定案**——協作模式退為卡上的提示/約束,不是流程開關。`decisionMode` 新語意:`auto`(預設;負責人在拆卡規則內自決,有資源視圖支撐)/ `solo`(禁止拆與委派,小任務直通)/ `pair`(每個 checkpoint 先問審理員,建在 peer @mention 上)/ `swarm`(提示按同構切片平行拆)。**「強制 delegate」退場**——`collaborationModeRequiresDelegation` 與現有 `delegate` 值改為 legacy 映射到 `auto`;結構該拆自然會拆,不需要家法。UI 下拉四選項,預設 auto。
- ~~免審與「審理員必填」的張力~~:**定案——全部必填,人建的卡也不例外。** 沒有 label 免審。一張卡一位審理員(可以是建卡者自己),一層審是最便宜的保險,也是 CV 評分的唯一來源;免審等於這張卡不計績效。UI 建卡時審理員為必填欄位。
- ~~swarm 的 fan-out 與每節點 3 張上限~~:**定案——swarm 不拿特權。** 守同一條規則:預設 3、公司可調、硬頂 5,再多分輪。100 個檔案就是 5 人各 20,不夠再開第二輪。

## 14. 可靠性(提案 §五「三件套」的系統化)

1. **Timeout 分級**:改為 `agents.default_timeout_seconds`(§10),卡覆寫 > agent 預設 > 全域;不再逐卡手填。
2. **Watchdog 正式版**:定期掃 `in_progress` 且 heartbeat 過期的 run;A2A adapter 用 `tasks/get` 問 Hermes 該 task 是否還活著(**`a2a-client.ts` 目前沒有 `tasks/get`,要補**);判定死亡 → 釋放鎖、記 task_log、依卡的 retry 政策重派或 blocked + 通知。父卡留言板同步記事件。
3. **重試 + BLOCKED 協議**:現有(`maxRetries`、`needs_review` 求助、blocked 通知),不動。

## 15. 卡片對話:留言、@mention、交接(2026-09-02 落地,後端)

用戶定的三個硬需求:**易讀**、**接手的 agent 知道上一手做了什麼**、**agent 能留言而且 @mention 就能叫人**。前端「易讀」見 §11 第 5 項與 §16;後端三件事如下,全部是既有機制的延伸,沒有新表。

1. **Agent 留言(兩條路,任何 adapter 都有一條)**
   - 結構化報告新增 `notes: string[]`(最多 3 則、各 2000 字):run 結束時由 MegaCorps 以該 agent 名義貼成 `comment`(`metadata.via = 'report'`),掛在 dispatch 完成、留言板委派完成、webhook 兩條路徑共四個既有的報告消費點旁。
   - `POST /api/cards/:id/comments` 接受 per-agent bearer token:只准 `action = comment`(控制動作 pause / continue / escalate / delegate 仍是人類專屬),身分取自 token 而不是 body,`metadata.via = 'agent_token'`;CSRF 對無 cookie 的 bearer 請求本來就放行。hermes 的「Common API Endpoints」在 agent 有 token 時多列這一條。
2. **@mention 叫人(`card-mentions.ts`)**
   - 人類與 agent 的留言、以及 report notes,一律解析 `@slug`(也接受 `@名字`,大小寫不分;email 不會誤判)。每個點到的 agent 得到一則 `peer_question`,`parentCommentId` 指回原留言、`metadata.mention = true`、帶 `authorName / authorKind`;回答走既有 peer 管線,`peer_answer` 掛回同一串,而且回答者的 prompt 現在帶最近的對話串,不只看到一句問題。
   - 上限:一則留言最多叫醒 3 人;agent 作者沿用每卡 5 題的既有上限,人類不設限。找不到的名字與超額的名字合成一列系統 `peer_question_failed` 回報,不會靜默消失;自我提及靜默略過。
   - `@client`(別名 `owner / you / 客戶 / 老闆`)不建留言,只發一則 `mention` 通知到鈴鐺——agent 想讓 Client 看一眼但不需要決定時用這個,需要有約束力的答案仍走 checkpoint。
   - 迴圈守衛不變:`peer_answer` 的內容永遠不掃 mention。
3. **交接段(`card-handover.ts`)**
   - 每次 bootstrap 任務 prompt 在 digest 之後注入「Handover: what happened on this card before this run」:依優先序排:同事問這位負責人、尚未回答的 peer question(只是脈絡——回答由 sweep 另開一輪短回合自動完成,prompt 明說不要在 notes 裡回、不要反過來 @ 提問者,否則會重複付費回答)、上一輪之後人類的新指示、最新審核意見(卡上的 `reviewFeedback` 與最新 `review_*` 留言)、ownership 交接留言、最近 3 次 run(誰、dispatch/message、成敗、時長、產出前 700 字;本人的 run 標 `you`)、目前為止的 work products;總長 3500 字內,超長時從尾端截但結尾句永遠保留:「不要重做已完成的工作,報告時說明相對上一輪改了什麼」。
   - 延續 session 的 prompt 不加(delta context 已含新留言)。
4. **每卡評分可見**:`GET /api/cards/:id/review-scores` 回最近 20 筆 0–10 分(域、審核者、被審者),補上 §8 說到卻在卡上看不到的分數。

`completionProtocol` 與 api-help 同步教學:notes 怎麼寫、@slug 與 @client 的差別、agent 可直接 POST 留言。測試:`card-mentions.test.ts`(10)、`card-handover.test.ts`(5)。

## 16. 卡片詳情三區制:前端落地(2026-09-02)

三個 commit,對應原設計的 PR-0 / PR-1、PR-2、PR-3;PR-4(拆舊分頁)刻意未做,等實際用過一輪流水線再拆。

1. **抽離(0d43d81)**:`kanban-board.tsx` 只剩狀態、loader、handler;面板、表單、舊分頁、歷史、產出、依賴選擇器、型別與 helper 逐字搬進 `apps/web/src/components/kanban/`。純模組 `lib/card-conversation.ts`(四個資料來源合成一條時間線:message / milestone / delegation / review / status / alert / system / product 八類,精確鍵去重、委派串與輪次容器、系統折疊、過濾器、@mention 標亮與候選、`buildCommentPayload` 與舊 `addComment` 逐位元 parity 測試)、`lib/card-situation.ts`(每個狀態一句話)、`lib/relative-time.ts`、`lib/format.ts` + `tf()`;`kanban.situation.*` / `kanban.event.*` 三語系標籤,i18n parity 測試,以及一支掃 server 原始碼確保每個 action 字串都有標籤的測試。web 第一次有測試(62 → 94)。
2. **概要區(5c87c75)**:常駐、唯讀:situation line、最後動態、負責人 / 審理員 / 部門 / 專案、6 行截斷的 body、父卡的子卡 chip(來自 `/subtree`,不吃看板 100 張上限)、設定 chip(點了進編輯並 focus 該欄)、審核中預設展開的審核回饋、動作列、折疊的運行時細節(階段負責人 / 審核者標 `(進行中)` 或 `(歷史 · status)`)。人類要動作時出現琥珀色操作條:回答 checkpoint(與收件匣同一條 PUT)、核准 / 退回 task_review(409 子卡未完成會列出標題)、受阻時帶留言繼續、待辦時立即執行。`✎ 編輯欄位` 才進今日表單;未儲存的草稿或未送出的留言會擋住誤關;status pill 改本地化文字;`localStorage['megacorps.kanban.detailLayout']` 一鍵切回舊版。
3. **對話籤(4fd7085)**:留言板 + DELEGATE / REVIEWER + 工單討論串合成一個「對話」籤,預設最新在前(可切換並記住);系統列預設折成一行,alert 永不折,未知 action 一律可見;過濾器 全部 / 對話 / 里程碑 / 委派與審核 / 系統;日期分隔、未讀線、60 筆視窗接續載入更早的 log、新事件 pill;live 事件每鍵 400ms debounce,一次爆發只刷一次看板。撰寫區收成一行在分頁列下方,打 `@`(或按 `@` 鈕)跳出 agent 選單,送出後被點名者以巢狀列顯示「等待 X 回覆」→「X 已回覆」;agent 自己貼的留言顯示 agent 頭像與 `via` 標記。產出、歷史兩籤保留原樣,歷史籤是對話籤敢隱藏東西的安全網。

**未做 / 待實際使用後決定**:PR-4 拆舊分頁與切換;sticky header;文字搜尋;Markdown 渲染;審核分數 chip(端點已有,UI 未接);人工 smoke(未起本機服務,機器記憶體有限)——PR-2 / PR-3 的檢查清單在各 commit 的 agent 報告裡,重點是七種撰寫動作各送一次、@mention 一次、切回舊版比對「委派與審核」計數。

## 附錄 A:現有組織與本設計的角色對照

| 提案用語 | 本設計角色 | 系統對應 |
|---|---|---|
| alice(派工、拆解、驗收,不寫碼不審碼) | CEO | `isCompanyBoss` 職位 |
| CTO(IT 部門、代碼審計、merge) | IT 部門主管 + 代碼域審計員 | `departments.head_agent_id` + `positions.review_domain = code` |
| 內容審計(待建) | 內容域審計員 | `positions.review_domain = content` |
| ribel / digby | 成員 | `agents.departmentId` + boss 鏈 |
| 哥哥 | Client | 目標卡建立者與最終審理員 |

## 附錄 B:組織配置待辦(非系統功能,來自提案 §十)

- 建內容審計 agent(命名、選模型)並設 `review_domain = content`
- 決定 digby 的 boss 是否改為 ribel(改 boss 鏈 = 改拆卡與委派的授權路徑,會影響規則 1)
- 既有 9 個 PR 的卡設 reviewer = CTO,跑通一層審
- CEO / 各部門主管 / 各審計員的職位 prompt 依 §F 模板重寫;每個部門補職掌描述
