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
4. **每張子卡必須指定審理員,且審理員 ≠ 該卡負責人。** 拆卡者可自任審理員。預設:成員卡 → 部門主管;部門卡 → CEO;目標卡 → Client。
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

1. **A 組織與拆卡**:`head_agent_id`、`children[]` 報告欄位、guard、cascade 改整合優先、留言板事件、prompt 撤禁令 —— 後端,可測
2. **B Client checkpoint**:狀態、approvals type、回答 API、答案注入、提醒、通知 —— 後端 + 小 UI
3. **C Brainstorm**:broadcast、收齊/逾時、CEO 重 dispatch、`forceBrainstorm` —— 後端
4. **D 資源視圖與評分**:`score`、CV 聚合進 digest、主管 prompt 注入 —— 後端
5. **E 列表視圖 + 三區制 + checkpoint 面板** —— 前端(可與 A–D 並行開工,最後接線)
6. **F 職位 prompt 套件**:CEO / 主管 / reviewer / 整合 的預設 prompt 模板 —— 配置

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
- **(待拍板)協作模式的語意**:提案要四模式 solo / delegate / pair / swarm 且預設值前後矛盾(§三說預設 solo,§十一說預設 agent 自行決定)。在本設計裡,拆不拆已由組織結構與資源視圖決定,「強制 delegate」失去必要性;協作模式應退為卡上的**提示/約束**而非流程開關。候選:`auto`(預設,負責人在規則內自決)/ `solo`(禁止拆與委派)/ `pair`(每個 checkpoint 先問審理員,建在 peer @mention 上)/ `swarm`(提示按同構切片平行拆)。
- **(待拍板)免審與「審理員必填」的張力**:提案要小卡可 label 免審;本設計規則 4 要求每張子卡必有審理員。候選折衷:agent 拆出的子卡一律必填(便宜的保險),只有**人**建的卡可以不設審理員。
- **(待拍板)swarm 的 fan-out 與每節點 3 張上限**:提案的 swarm 例子是 10 檔 → 3 人(合規),100 檔 → 5 人會撞上限。候選:swarm 走公司層級可調的上限(硬上限 5),再多就分輪。

## 14. 可靠性(提案 §五「三件套」的系統化)

1. **Timeout 分級**:改為 `agents.default_timeout_seconds`(§10),卡覆寫 > agent 預設 > 全域;不再逐卡手填。
2. **Watchdog 正式版**:定期掃 `in_progress` 且 heartbeat 過期的 run;A2A adapter 用 `tasks/get` 問 Hermes 該 task 是否還活著(**`a2a-client.ts` 目前沒有 `tasks/get`,要補**);判定死亡 → 釋放鎖、記 task_log、依卡的 retry 政策重派或 blocked + 通知。父卡留言板同步記事件。
3. **重試 + BLOCKED 協議**:現有(`maxRetries`、`needs_review` 求助、blocked 通知),不動。

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
