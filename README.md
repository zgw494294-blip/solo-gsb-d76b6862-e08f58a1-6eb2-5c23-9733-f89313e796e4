# 透明图层叠序校准台

本地 Web 应用：录入若干个纯色半透明图层与多组「背景色 / 目标色」样本，自动枚举所有底 → 顶叠放顺序，找出对全部样本整体拟合最好的图层顺序；顺序确定后还可以**从目标色反推 1～2 个图层的建议不透明度**；当容差内仍存在多条难分的叠序时，可进一步给出**下一次背景测量建议**——从候选背景中挑出最能把这些顺序的预测色拉开差距的一个；在该候选背景上拿到实测颜色后，还能做**实测颜色复核**——逐条复核容差内的全部叠序哪些仍与测量相符，旧样本不足 4 组时可把测量追加为样本并重新求解；拿到校准台给出的最佳叠序后，还能做**过渡步骤规划**——从当前实际叠序出发，只交换相邻两层，规划一条每一步都合规且旧样本总误差不超过给定上限的最少交换路径；当**先后关系成环**时，在原有冲突提示旁还会给出一组**待确认的解除方案**——从当前至多 12 条关系里选出删去不同关系对最少、剩余关系无环的一组（同向重复按一对计、自环也必须解除），确认后一次性移除这些对的全部重复项、保留其他输入并自动重新求解。

- **后端**：Python + FastAPI（计算核心仅用标准库，便于审阅与测试）
- **前端**：原生 HTML / CSS / JavaScript，无任何构建步骤与外部 CDN 依赖
- **色彩管线**：标准 sRGB 分段函数 ↔ 线性光，在线性光空间做 Porter-Duff alpha 合成
- **择优准则**：所有样本、RGB 三通道在 **0–255 未取整** 尺度上的平方误差总和；总误差相同时，按图层 **ID 序列字典序**（反推时按待调参数元组）决胜

## 一条命令启动

需要已安装 Docker（含 Compose 插件）。

```bash
docker compose up --build
```

启动后用浏览器访问：

```
http://localhost:8000
```

停止：在另一个终端执行 `docker compose down`（或 Ctrl+C 后再 `down` 清理容器）。

## 功能说明

| 区域 | 规则 |
| --- | --- |
| 图层 | 2～7 个；ID 必须唯一且非空；颜色支持 `#RGB` / `#RRGGBB`（`#` 可省略，大小写不限）；不透明度 0～1 |
| 样本 | 1～4 组「背景色 + 目标色」；所有样本共用同一底到顶顺序，误差跨样本求和 |
| 先后关系 | 0～12 条「某图层在更下方 / 另一图层在其上方」约束；形成有向环时明确提示冲突链，例如 `A → B → A`；**成环时在冲突提示下方并列展示待确认的解除方案**，方案**只展示、不自动修改**：从当前关系中选出删去不同关系对最少且删完无环的一组，同向重复按一对计、自环必须删除，并列时依次按「每组待删对已按 (lower, upper) 字典序排好」与待删对列表字典序取最小；点「确认移除并重新求解」后一次性删除这些对的**全部同向重复关系**，图层、样本及其余关系原样保留并触发原求解；无环时不展示方案（接口返回空方案）；其他非法输入仍按原规则报错，不会出现方案 |
| 结果 | 最终顺序（带半透明色点、底→顶方向）、总平方误差、枚举/可行排列数；每个样本并排显示目标色与预测色、HEX、RGB 与 R/G/B 分通道平方误差 |
| 不透明度反推 | 顺序确定后，沿用当前图层、样本与先后关系：确认一条底→顶顺序并勾选 1～2 个待调图层，其余图层保留原不透明度。联合遍历待调图层 0.00～1.00、步长 0.01 的全部组合（原始参数组若落在网格外也额外纳入），按同一未取整 RGB 平方误差总和选最优；同分时按 **ID 字典序排列的待调参数元组从小到大** 决胜。页面展示原值 / 建议值、调整前后总误差、每组样本的目标色与调整前后预测色，可一键把建议值写回图层并重新求解 |
| 下一次背景测量建议 | 沿用当前图层、样本与先后关系，录入 **2～12 个**规范化后互不重复的候选背景 HEX 与**非负有限**的误差容差：枚举合规叠序，保留总误差 ≤ 最优总误差 ＋ 容差的顺序，按（总误差、ID 序列）排序取前 12 条展示，并给出符合容差的总数；在每个候选背景上按同一线性光规则渲染这些顺序，以**任意两条预测色未取整 RGB（0–255）平方距离的最小值**给背景打分，推荐得分最高者（同分取规范化 HEX 字典序最小者），并展示推荐背景上最难区分的一对顺序及其预测色；容差内不足两条顺序时提示无需追加测量 |
| 实测颜色复核 | 在建议区选定**一个候选背景**，录入该背景上的**实测目标 HEX** 与**非负有限的新测量误差上限**，沿用当前图层、旧样本、先后关系及建议容差：先保留旧样本总误差 ≤ 最优总误差 ＋ 容差的**全部**合规叠序（建议页只展示前 12 条，但复核逐条覆盖、不会漏），再以选定背景上**未取整 0～255 RGB** 与实测色计算平方误差，仅留下不超过新上限者；显示筛选前后总数，留下叠序展示旧总误差、新测量误差与预测色，按（新测量误差、旧总误差、ID 序列）排序取前 12 条；没有匹配时提示实测与现有候选不相容；有匹配且旧样本少于 4 组时，可把该测量（选定背景＋实测色）追加为第 N＋1 组样本并触发原求解。参与复核的任一输入变化（图层 / 旧样本 / 先后关系 / 候选背景 / 容差 / 选定背景 / 实测色 / 上限）或追加样本后，旧复核结果立即失效，不能再用于追加 |
| 过渡步骤规划 | 录入**当前实际底→顶完整图层 ID 顺序**（必须恰好包含全部图层 ID 各一次，且符合全部先后关系）与**非负有限的过渡总误差上限**；当前顺序在旧样本上的总误差也必须 ≤ 上限，否则按非法输入报错。目标固定为原求解按（总误差、ID 序列）决胜得到的最佳叠序。服务端在「满足先后关系且旧样本未取整 RGB 总平方误差 ≤ 上限」的状态图上以**相邻两层交换**为边做 BFS，求**交换次数最少**的完整路径；并列时按每步交换前两层的 ID 对（下方 ID、上方 ID）组成的序列**字典序**决胜。页面逐步显示所交换图层、交换后叠序、各样本预测色与该步总误差；当前已是目标时返回**空步骤**；目标虽达标（合规且总误差 ≤ 上限）却没有合规路径时明确说明**不可到达**。图层 / 样本 / 先后关系 / 当前顺序 / 上限任一变化后，旧步骤立即失效 |

输入任意改动后自动重新求解（带防抖），非法颜色、重复 ID、越界不透明度等错误会在页面顶部以中文逐条列出，并暂停计算。反推、背景建议、实测复核与过渡步骤规划均为手动触发；输入变化后，旧结果会在卡片内标记为「可能过期」或「已失效」，过渡卡片可随时把当前叠序一键重置为最新最优叠序。

### 过渡规划的响应失效规则

过渡步骤规划在浏览器端对请求竞态做了严格处理，避免「响应尚未返回时改动输入，旧步骤被当成当前结果」以及「连续规划、响应倒序返回时较早请求覆盖较新结果」：

- 每次点击「规划交换步骤」都会发出一个带**单调递增序号**的请求（序号只增不减，请求以成功、HTTP 错误或连接异常结束后该序号也**不会被后续请求复用**），并记录请求发出时的**参与输入指纹**（图层、样本、先后关系、当前实际叠序、过渡总误差上限）。
- 上述任一参与输入发生变化后，已展示的步骤**立即标记为已失效**；若此时仍有在途请求，该请求（及其响应）**立即作废**，规划区加载状态随即结束。
- 只有**当前在途请求**（即最近发出、尚未被新请求取代、也未因输入变化作废的请求）且其对应输入自发出后**未再变化**的响应才能更新规划：成功则展示新步骤，HTTP 4xx 等业务错误则展示错误信息，二者都会结束加载。
- 输入保持不变时连续规划同样安全：例如先发起两次规划、第二次先返回，再发起第三次——第一次较晚返回的响应不会因为第二次完成而「取回」当前身份，无论它以**成功、HTTP 错误还是连接异常**结束都会被直接丢弃：不覆盖第二次展示的步骤或错误、不提前结束第三次的加载，随后第三次自身返回时也不会被误丢，而是正常展示其步骤或错误并结束加载。
- 一般地，较早请求或已因输入变化而作废的请求，无论其响应是**成功、HTTP 错误还是连接异常**，都会被直接丢弃——不改动当前步骤、不改动错误提示、也不改动加载状态；只要仍有更新的请求在途，加载状态就保持到该请求返回为止。
- 作废后可随时按新输入重新规划；输入先变化后又改回原值的情况，旧请求同样不会复活。

### 色彩与合成细节

1. HEX → sRGB(0～1)；按 IEC 61966-2-1 分段函数转为线性光：
   - `c ≤ 0.04045`：`c / 12.92`
   - 否则：`((c + 0.055) / 1.055) ** 2.4`
2. 以不透明背景色（α=1）打底，按底到顶顺序逐层做 "over" 合成（预乘形式）。
3. 结果经逆函数转回 sRGB，误差比较使用未四舍五入的浮点 RGB × 255 值；页面上的预测 HEX 才是取整后的值。
4. 对 7 个图层最多枚举 7! = 5040 个排列，逐排列过滤约束并评估，响应为毫秒级。

## API

`POST /api/solve`

```json
{
  "layers": [
    { "id": "R", "color": "#ff0000", "opacity": 0.5 },
    { "id": "B", "color": "#0000ff", "opacity": 0.5 }
  ],
  "samples": [
    { "background": "#ffffff", "target": "#e189bc" }
  ],
  "relations": [
    { "lower": "R", "upper": "B" }
  ]
}
```

成功返回 `order`（底→顶 ID 序列）、`orderIndexes`、`layers`（同序）、`totalSse`、`permutationsChecked`、`feasibleCount` 及每个样本的 `target / predictedHex / predictedRgb / channelSse / sse`。

输入非法或约束成环时返回 HTTP 400：

```json
{ "errors": [ { "scope": "layers", "index": 0, "message": "不透明度越界：1.2，必须在 0～1 之间" } ] }
```

`scope` 取值为 `layers` / `samples` / `relations` / `form`。

### `POST /api/infer-opacity` — 不透明度反推

在已有图层、样本与先后关系不变的前提下，显式给出一条底→顶 `order`（必须**恰好包含全部图层 ID 且各一次**，并满足全部先后关系），再给出 `adjustIds`（**1～2 个**已存在、不重复的图层 ID，服务端按 ID 字典序排列作为参数元组序）。其余图层保留输入中的原不透明度。

```bash
curl -s -X POST http://localhost:8000/api/infer-opacity \
  -H "Content-Type: application/json" \
  -d '{
    "layers": [
      { "id": "R", "color": "#ff0000", "opacity": 0.5 },
      { "id": "B", "color": "#0000ff", "opacity": 0.5 }
    ],
    "samples": [
      { "background": "#ffffff", "target": "#e189bc" }
    ],
    "relations": [
      { "lower": "R", "upper": "B" }
    ],
    "order": ["R", "B"],
    "adjustIds": ["R", "B"]
  }'
```

成功返回（节选）：

```json
{
  "order": ["R", "B"],
  "orderIndexes": [0, 1],
  "adjustIds": ["B", "R"],
  "layers": [
    { "id": "R", "color": "#ff0000", "opacity": 0.5 },
    { "id": "B", "color": "#0000ff", "opacity": 0.5 }
  ],
  "adjustments": [
    { "id": "B", "index": 1, "originalOpacity": 0.5, "suggestedOpacity": 0.25 },
    { "id": "R", "index": 0, "originalOpacity": 0.5, "suggestedOpacity": 0.67 }
  ],
  "beforeTotalSse": 2745.3695,
  "afterTotalSse": 1.4198,
  "beforeSamples": [
    { "index": 0, "background": "#ffffff", "target": "#e189bc",
      "predictedHex": "#bc89e1", "predictedRgb": [187.52, 136.96, 224.61],
      "channelSse": [1405.05, 0.0, 1340.32], "sse": 2745.3695 }
  ],
  "afterSamples": [
    { "index": 0, "background": "#ffffff", "target": "#e189bc",
      "predictedHex": "#e188bb", "predictedRgb": [224.61, 136.33, 187.10],
      "channelSse": [0.15, 0.45, 0.82], "sse": 1.4198 }
  ],
  "combosChecked": 10201,
  "opacityGrid": { "min": 0.0, "max": 1.0, "step": 0.01 }
}
```

说明：

- 遍历组合数为 101（调 1 个）或 101² = 10201（调 2 个）；当原始参数组不在 0.01 网格上（如 0.333）时，会把这一个原始元组**额外**纳入评估，`combosChecked` 相应 +1，以保证建议不会差于原值。若原始元组本身最优，建议值就等于原值，页面标注「原值即最优」；应用回图层后与页面预测逐位一致。
- `beforeSamples` / `afterSamples` 结构与 `/api/solve` 的 `samples` 一致（`target / predictedHex / predictedRgb / channelSse / sse`），分别对应调整前、后的预测。
- 同分决胜：按 `adjustIds` 字典序排列的待调参数元组从小到大（如 `(0.0, 0.3)` 优于 `(0.0, 0.4)`，`(0.1, 0.0)` 优于 `(0.2, 0.0)`）。
- 典型 400 报错（HTTP 状态码仍为 400，`scope` 为 `order` / `adjust`，其余校验错误沿用原 scope）：

```json
{ "errors": [
  { "scope": "order",  "message": "order 必须恰好包含全部 3 个图层 ID（各一次），当前 2 个" },
  { "scope": "order",  "message": "order 中图层 ID 重复：R，每个图层必须且只能出现一次" },
  { "scope": "order",  "message": "所给顺序不符合先后关系：R 必须在 B 下方（底 → 顶）" },
  { "scope": "adjust", "message": "待调图层 ID 重复：R，同一图层只能选择一次" },
  { "scope": "adjust", "message": "待调图层 ID 不存在：'X'" }
] }
```

### `POST /api/suggest-background` — 下一次背景测量建议

在 `/api/solve` 请求体的基础上增加两个字段，其余字段（`layers` / `samples` / `relations`）含义与校验完全沿用：

- `candidateBackgrounds`：**2～12 个**候选背景 HEX（`#RGB` / `#RRGGBB`，`#` 可省略），**规范化后互不重复**；
- `tolerance`：**非负有限**数字的误差容差。

服务端枚举合规叠序，保留总误差 ≤ 最优总误差 ＋ 容差的顺序，按（总误差、ID 序列）排序取前 12 条；再在每个候选背景上按同一线性光规则渲染这些顺序，以任意两条预测色**未取整 RGB（0–255 尺度）平方距离的最小值**给背景打分，推荐得分最高者（同分取规范化 HEX 字典序最小者）。

```bash
curl -s -X POST http://localhost:8000/api/suggest-background \
  -H "Content-Type: application/json" \
  -d '{
    "layers": [
      { "id": "R", "color": "#ff0000", "opacity": 0.5 },
      { "id": "B", "color": "#0000ff", "opacity": 0.5 }
    ],
    "samples": [
      { "background": "#ffffff", "target": "#e189bc" }
    ],
    "relations": [],
    "candidateBackgrounds": ["#ffffff", "#000000", "#808080"],
    "tolerance": 10000
  }'
```

成功返回（节选）：

```json
{
  "tolerance": 10000.0,
  "bestSse": 0.3876,
  "feasibleCount": 2,
  "withinCount": 2,
  "orders": [
    { "order": ["B", "R"], "orderIndexes": [1, 0], "totalSse": 0.3876 },
    { "order": ["R", "B"], "orderIndexes": [0, 1], "totalSse": 2745.3695 }
  ],
  "needsMeasurement": true,
  "candidates": [
    { "hex": "#ffffff", "score": 2751.9816,
      "pair": { "a": { "order": ["B", "R"], "predictedHex": "#e189bc",
                       "predictedRgb": [224.61, 136.96, 187.52] },
                "b": { "order": ["R", "B"], "predictedHex": "#bc89e1",
                       "predictedRgb": [187.52, 136.96, 224.61] } } },
    { "hex": "#000000", "score": 5111.7888, "pair": { "a": "…", "b": "…" } },
    { "hex": "#808080", "score": 4331.6991, "pair": { "a": "…", "b": "…" } }
  ],
  "recommended": { "hex": "#000000", "score": 5111.7888, "pair": { "a": "…", "b": "…" } }
}
```

说明：

- `withinCount` 为符合容差的叠序总数（可能多于 12），`orders` 只含排序后的前 12 条；`bestSse` 与 `/api/solve` 的 `totalSse` 逐位一致。
- `needsMeasurement` 为 `false`（容差内不足两条顺序）时，`candidates` 为空、`recommended` 为 `null`，表示当前样本已能唯一区分叠序，无需追加测量。
- 每个候选背景的 `pair` 是得分来源——该背景上最难区分的一对顺序及其未取整预测色（`predictedRgb` 为 0–255 浮点，`predictedHex` 为取整后的展示值）；`recommended` 是得分最高的候选，同分时取规范化 HEX 字典序最小者。
- 典型 400 报错（`scope` 为 `candidates` / `tolerance`，其余校验错误沿用原 scope）：

```json
{ "errors": [
  { "scope": "candidates", "index": 1, "message": "候选背景色重复：#ffffff（与第 1 个规范化后相同）" },
  { "scope": "candidates", "index": 2, "message": "候选背景色非法：需要形如 #RRGGBB 的 HEX 值，实际为 '#gg0000'" },
  { "scope": "candidates", "message": "候选背景数量必须在 2～12 个之间，当前 1 个" },
  { "scope": "tolerance",  "message": "误差容差不能为负：-1" },
  { "scope": "tolerance",  "message": "误差容差必须是非负有限的数字，实际为 'abc'" }
] }
```

### `POST /api/review-measurement` — 实测颜色复核

在 `/api/suggest-background` 请求体的基础上增加三个复核字段（`candidateBackgrounds` / `tolerance` 仍沿用建议区的录入）：

- `selectedBackground`：从候选背景中选定的**一个**背景 HEX（规范化后必须存在于 `candidateBackgrounds`）；
- `measuredColor`：在该背景上测得的目标色 HEX（`#RGB` / `#RRGGBB`，`#` 可省略）；
- `measurementLimit`：**非负有限**数字的新测量误差上限。

服务端先枚举旧样本总误差 ≤ 最优总误差 ＋ 容差的**全部**合规叠序（不按前 12 条截断），再在选定背景上以未取整 0–255 RGB 与实测色计算平方误差，仅保留不超过 `measurementLimit` 的叠序；留下的叠序按（新测量误差、旧总误差、ID 序列字典序）排序，仅前 12 条进入 `orders`，但 `matchedCount` 是覆盖全部叠序筛选后的真实总数。

```bash
curl -s -X POST http://localhost:8000/api/review-measurement \
  -H "Content-Type: application/json" \
  -d '{
    "layers": [
      { "id": "R", "color": "#ff0000", "opacity": 0.5 },
      { "id": "B", "color": "#0000ff", "opacity": 0.5 }
    ],
    "samples": [
      { "background": "#ffffff", "target": "#e189bc" }
    ],
    "relations": [],
    "candidateBackgrounds": ["#ffffff", "#000000", "#808080"],
    "tolerance": 10000,
    "selectedBackground": "#ffffff",
    "measuredColor": "#e289bb",
    "measurementLimit": 5
  }'
```

成功返回：

```json
{
  "tolerance": 10000.0,
  "measurementLimit": 5.0,
  "selectedBackground": "#ffffff",
  "measuredColor": "#e289bb",
  "bestSse": 0.3876,
  "feasibleCount": 2,
  "withinCount": 2,
  "matchedCount": 1,
  "compatible": true,
  "shownCount": 1,
  "orders": [
    {
      "order": ["B", "R"],
      "orderIndexes": [1, 0],
      "oldTotalSse": 0.3876,
      "measurementSse": 0.4521,
      "predictedRgb": [224.61, 136.96, 187.52],
      "predictedHex": "#e189bc",
      "channelSse": [0.15, 0.0, 0.30]
    }
  ],
  "sampleCount": 1,
  "canAppendSample": true
}
```

说明：

- `feasibleCount` 为满足先后关系的叠序总数，`withinCount` 为其中旧总误差 ≤ 最优总误差 ＋ 容差者（**筛选前**），`matchedCount` 为再按新测量误差上限筛选后的数量（**筛选后**）；`orders` 只有排序后的前 12 条，`shownCount` 为本次实际返回条数。
- 每条结果给出 `oldTotalSse`（旧样本总误差，与 `/api/solve` 的 `totalSse` 同口径）、`measurementSse`（选定背景上未取整 RGB 对实测色的平方误差）、`predictedRgb`（0–255 浮点）与取整展示用 `predictedHex`。
- `compatible` 为 `false`（即 `matchedCount = 0`）时，`orders` 为空，表示实测色与现有候选不相容。
- `canAppendSample`：有匹配且旧样本少于 4 组时为 `true`。追加样本由客户端完成——把 `{ "background": selectedBackground, "target": measuredColor }` 加入 `samples` 后重新调用 `/api/solve` 即「触发原求解」；追加后旧复核结果立即失效，不能再用同一次结果重复追加。
- 典型 400 报错（新增错误的 `scope` 为 `review`，容差等沿用 `tolerance` 等原 scope）：

```json
{ "errors": [
  { "scope": "review", "message": "请从候选背景中选择一个用于复核的背景" },
  { "scope": "review", "message": "选定的复核背景 #123456 不在候选背景列表中，请先在建议区选择一个候选背景" },
  { "scope": "review", "message": "选定的复核背景色非法：需要形如 #RRGGBB 的 HEX 值，实际为 'zzz'" },
  { "scope": "review", "message": "实测目标色非法：需要形如 #RRGGBB 的 HEX 值，实际为 '#gg0000'" },
  { "scope": "review", "message": "新测量误差上限不能为负：-1" },
  { "scope": "review", "message": "新测量误差上限必须是非负有限的数字，实际为 'abc'" }
] }
```

### `POST /api/plan-transition` — 过渡步骤规划

在 `/api/solve` 请求体（`layers` / `samples` / `relations`，校验完全沿用）的基础上增加两个字段：

- `currentOrder`：**当前实际底→顶的完整图层 ID 顺序**，必须恰好包含全部图层 ID（各一次），且符合全部先后关系，并且其旧样本总误差 ≤ 上限；
- `transitionLimit`：**非负有限**数字的过渡总误差上限。

目标叠序不需要传入——服务端按原求解规则（未取整 RGB 总平方误差，同分按 ID 序列字典序）枚举得到，即与 `/api/solve` 的 `order` 逐位一致。规划时把每个满足先后关系且旧样本总误差 ≤ 上限的叠序视为一个可达节点，相邻两层交换（交换后仍合规）视为一条边：BFS 求交换次数最少的路径；每个节点的候选交换按交换前「下方图层 ID、上方图层 ID」对的字典序展开，因此并列最短路径中返回的是**每步交换 ID 对序列字典序最小**的一条。

```bash
curl -s -X POST http://localhost:8000/api/plan-transition \
  -H "Content-Type: application/json" \
  -d '{
    "layers": [
      { "id": "R", "color": "#ff0000", "opacity": 0.5 },
      { "id": "G", "color": "#00ff00", "opacity": 0.5 },
      { "id": "B", "color": "#0000ff", "opacity": 0.5 }
    ],
    "samples": [
      { "background": "#ffffff", "target": "#e189bc" },
      { "background": "#000000", "target": "#204060" }
    ],
    "relations": [],
    "currentOrder": ["B", "R", "G"],
    "transitionLimit": 1000000000
  }'
```

成功返回（节选）：

```json
{
  "transitionLimit": 1000000000.0,
  "currentOrder": ["B", "R", "G"],
  "currentOrderIndexes": [2, 0, 1],
  "currentTotalSse": 37439.0488,
  "currentSamples": [{ "…与 /api/solve 的 samples 同结构…" }],
  "targetOrder": ["G", "R", "B"],
  "targetOrderIndexes": [1, 0, 2],
  "targetTotalSse": 24619.8264,
  "targetSamples": [{ "…" }],
  "bestSse": 24619.8264,
  "feasibleCount": 6,
  "allowedCount": 6,
  "alreadyTarget": false,
  "reachable": true,
  "stepCount": 3,
  "statesVisited": 6,
  "steps": [
    {
      "step": 1,
      "swapIndex": 0,
      "swappedLowerId": "B",
      "swappedUpperId": "R",
      "pair": ["B", "R"],
      "order": ["R", "B", "G"],
      "orderIndexes": [0, 2, 1],
      "totalSse": 34647.5773,
      "samples": [{ "…交换后各样本的预测色与分通道误差…" }]
    }
  ]
}
```

说明：

- 每个 `steps[i]` 描述**第 i 步交换之后**的状态：`swapIndex` 是交换前下方图层所在的底→顶位置（0 起），`pair` / `swappedLowerId` / `swappedUpperId` 是交换前相邻两层的 ID（先下后上，也是字典序决胜的比较单元），`order` 是交换后的完整叠序，`totalSse` 与 `samples`（`target / predictedHex / predictedRgb / targetRgb / channelSse / sse`）按现有线性光规则在旧样本上计算，未取整 RGB 总平方误差保证 ≤ `transitionLimit`。
- `currentSamples` / `targetSamples` 分别给出起点（第 0 步，未交换）与目标的逐样本明细；`feasibleCount` 是满足先后关系的叠序总数，`allowedCount` 是其中总误差 ≤ 上限的可停留状态数，`statesVisited` 是本次 BFS 实际访问的状态数。
- 当前实际叠序已经是目标时，HTTP 200 且 `alreadyTarget = true`、`steps = []`、`stepCount = 0`。
- 目标叠序本身合规且总误差 ≤ 上限，但合规子图中不存在从当前叠序到它的相邻交换路径时（例如当前叠序的任一相邻交换都会突破上限），HTTP 200 且 `reachable = false`、`steps = []`，并在 `message` 中给出中文说明。
- 非法顺序（缺漏 / 重复 / 不存在的 ID、不符合先后关系）、当前顺序总误差超过上限、上限为负或非有限数字等情况返回 HTTP 400（新增错误 `scope` 为 `transition`，其余校验错误沿用原 scope）：

```json
{ "errors": [
  { "scope": "transition", "message": "currentOrder 必须恰好包含全部 3 个图层 ID（各一次），当前 2 个" },
  { "scope": "transition", "message": "currentOrder 中图层 ID 重复：R，每个图层必须且只能出现一次" },
  { "scope": "transition", "message": "currentOrder 中的图层 ID 不存在：'X'" },
  { "scope": "transition", "message": "当前顺序不符合先后关系：R 必须在 G 下方（底 → 顶）" },
  { "scope": "transition", "message": "当前顺序的旧样本总误差 37439 已超过过渡总误差上限 100，请放宽上限" },
  { "scope": "transition", "message": "过渡总误差上限不能为负：-1" },
  { "scope": "transition", "message": "过渡总误差上限必须是非负有限的数字，实际为 'abc'" }
] }
```

### `POST /api/resolve-cycle` — 成环解除方案（查询）与确认后原求解

请求体与 `/api/solve` 完全相同（`layers` / `samples` / `relations`，校验完全沿用），可额外带一个布尔字段 `confirm`：

- 不带 `confirm`（或非 `true`）为**方案查询**：其余非法输入仍按现有规则返回 400；输入合法但关系**无环**时 HTTP 200、`cyclic = false` 且 `cycleResolution.removePairs` 为**空方案**；关系**成环**时 HTTP 200，在 `conflict` 中给出与 `/api/solve` 成环 400 同文案的冲突提示与冲突链，并在 `cycleResolution` 给出待确认方案——**删去不同关系对最少、删完后剩余关系无环**的一组：
  - 关系 ID 按现有规则规范化（去空白、引用图层 ID）；**同向重复按一对计**（方案枚举只看唯一有向边），**自环（lower = upper）本身成环、必须删除**；
  - 每组方案的待删对均按 `(lower, upper)` 字典序排序；删除条数并列时，取**待删对列表字典序最小**的一组；
  - 方案**只计算、不修改任何输入**。
- `confirm: true` 为**确认执行**：服务端以**本次请求**为唯一依据重新算出方案，把方案中每个关系对的**全部同向重复项**从 `relations` 中一次性移除，图层、样本及未入选关系**原样保留**，然后执行与 `/api/solve` **完全一致**的原求解，返回字段也与 `/api/solve` 相同，并额外附上本次实际生效的 `cycleResolution`（含实际删除条数）。无环或方案为空时等价于直接调用 `/api/solve`。

查询示例（成环：`A 在 B 下` 与 `B 在 A 下`，其中 `A→B` 还重复了一次）：

```bash
curl -s -X POST http://localhost:8000/api/resolve-cycle \
  -H "Content-Type: application/json" \
  -d '{
    "layers": [
      { "id": "A", "color": "#ff0000", "opacity": 0.5 },
      { "id": "B", "color": "#00ff00", "opacity": 0.5 }
    ],
    "samples": [
      { "background": "#ffffff", "target": "#808080" }
    ],
    "relations": [
      { "lower": "A", "upper": "B" },
      { "lower": "B", "upper": "A" },
      { "lower": "A", "upper": "B" }
    ]
  }'
```

返回（HTTP 200；注意不是 400——冲突提示随方案一并给出）：

```json
{
  "cyclic": true,
  "confirm": false,
  "conflict": {
    "scope": "relations",
    "message": "图层先后关系成环，存在冲突：A → B → A（底 → 顶方向不能绕回自身）",
    "chain": "A → B → A"
  },
  "relationCount": 3,
  "uniqueRelationCount": 2,
  "cycleResolution": {
    "removePairs": [ { "lower": "A", "upper": "B" } ],
    "removeCount": 1,
    "removedDuplicateCount": 2,
    "remainingRelationCount": 1
  }
}
```

确认示例（同一请求体加 `"confirm": true`；两条 `A→B` 重复项被一次性删除，保留 `B→A` 及全部图层、样本，再按原规则求解）：

```bash
curl -s -X POST http://localhost:8000/api/resolve-cycle \
  -H "Content-Type: application/json" \
  -d '{
    "layers": [
      { "id": "A", "color": "#ff0000", "opacity": 0.5 },
      { "id": "B", "color": "#00ff00", "opacity": 0.5 }
    ],
    "samples": [ { "background": "#ffffff", "target": "#808080" } ],
    "relations": [
      { "lower": "A", "upper": "B" },
      { "lower": "B", "upper": "A" },
      { "lower": "A", "upper": "B" }
    ],
    "confirm": true
  }'
```

返回（节选）：字段与 `/api/solve` 相同，`order` 满足保留下来的 `B 在 A 下`；末尾附带实际移除情况。

```json
{
  "order": ["B", "A"],
  "orderIndexes": [1, 0],
  "totalSse": 0.0,
  "permutationsChecked": 2,
  "feasibleCount": 1,
  "samples": [ { "…与 /api/solve 完全一致…" } ],
  "cycleResolution": {
    "removePairs": [ { "lower": "A", "upper": "B" } ],
    "removeCount": 1,
    "removedDuplicateCount": 2,
    "remainingRelationCount": 1
  }
}
```

无环查询返回空方案（页面因此不展示解除区）：

```json
{
  "cyclic": false,
  "confirm": false,
  "conflict": null,
  "relationCount": 1,
  "uniqueRelationCount": 1,
  "cycleResolution": {
    "removePairs": [],
    "removeCount": 0,
    "removedDuplicateCount": 0,
    "remainingRelationCount": 1
  }
}
```

字段与规则说明：

- `relationCount` 是原始关系条数，`uniqueRelationCount` 是规范化去重（同向重复按一条计、自环也是一条）后的有向边数；`removeCount` 是待删的**不同关系对**数，`removedDuplicateCount` 是确认后将被删除的**原始关系条数**（含这些对的全部同向重复），`remainingRelationCount` 为两者之差。
- 方案决胜完全在去重后的有向边（至多 12 条）上进行：自环固定入选，其余边按删除条数从小到大、同数按待删边列表字典序枚举，首个使剩余图无环者中选，因此至多枚举 2¹² = 4096 个子集。
- 其他非法输入（图层数量 / 重复 ID / 非法颜色与不透明度、样本数量与颜色、超过 12 条关系、引用不存在的图层 ID 等）与 `/api/solve` 一样返回 HTTP 400 与相同 `scope` / 文案的 `errors`，**不会**给出解除方案；`confirm: true` 也不绕过校验。

### 解除方案的失效规则

解除方案区与原求解错误横幅并列展示，浏览器端对其请求竞态做了与过渡规划同级的严格处理：

- 方案请求随每次自动求解发出，携带**单调递增、永不归零**的请求序号，并记录发出时的**参与输入指纹**（图层、样本、先后关系）。
- **图层、样本或关系任一变化**（含防抖重发、增删条目、确认移除后触发的新求解）即作废已展示方案及其确认资格，同时作废在途方案请求；之后即使把输入**改回原值**，旧方案也**不能恢复确认资格**，必须随新求解重新获得方案。
- 只有**最近一次**且其参与输入**自发出后始终未变**的方案请求能更新方案区与加载状态；较早请求或已因输入变化作废的请求，无论以**成功、HTTP 错误还是连接异常**结束都会被直接丢弃——不覆盖方案、不改动错误横幅、不提前结束较新请求的加载状态。
- 确认按钮只在「方案来自最近一次请求、且指纹与当前输入逐字节一致」时有效；确认动作一次性删除这些关系对的全部同向重复项，其余输入不动，随即触发原求解；新求解若无环，方案区返回空方案并隐藏。

## 不用 Docker 的本地运行方式（可选）

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

计算核心零第三方依赖，可直接 `python3 -c "from app import core; ..."` 单测。

## 目录结构

```
.
├── app/
│   ├── __init__.py
│   ├── core.py        # sRGB 转换 / alpha 合成 / 环检测 / 枚举择优 / 不透明度反推 / 背景测量建议 / 实测颜色复核 / 过渡步骤规划 / 成环解除方案（纯标准库）
│   └── main.py        # FastAPI：/api/solve、/api/infer-opacity、/api/suggest-background、/api/review-measurement、/api/plan-transition、/api/resolve-cycle 与静态页面托管
├── static/
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── requirements.txt
├── Dockerfile
├── docker-compose.yml
└── README.md
```
