"""透明图层叠序校准台 —— 纯标准库计算核心。

- sRGB <-> 线性光分段转换（IEC 61966-2-1）
- 线性光空间内逐层 alpha 合成（Porter-Duff "over"）
- 枚举全部底到顶排列，按未取整 RGB 通道平方误差总和选优
- 同分时按 ID 序列字典序决胜
- 图层顺序确定后，可在 0.00～1.00（步长 0.01）网格上联合反推 1～2 个图层的不透明度
- 下一次背景测量建议：保留总误差不高于最优总误差 + 容差的叠序，
  在候选背景上渲染后以「任意两条预测色未取整 RGB 平方距离最小值」打分并推荐
- 实测颜色复核：在选定候选背景上拿到实测色后，对容差内的全部叠序（不止建议页
  展示的前 12 条）计算该背景上的未取整 RGB 平方误差，留下不超过新测量上限者
- 过渡步骤规划：给出当前实际底→顶叠序与非负有限的过渡总误差上限，在
  「满足先后关系且旧样本总误差不超过上限」的状态图上，以相邻交换为边做 BFS，
  求交换次数最少的完整路径；并列时按每步交换前两层 ID 对序列的字典序决胜
"""

from __future__ import annotations

import itertools
import math
import re
from collections import deque
from dataclasses import dataclass
from typing import Any

_HEX_RE = re.compile(r"^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")

MAX_LAYERS = 7
MIN_LAYERS = 2
MAX_SAMPLES = 4
MIN_SAMPLES = 1
MAX_RELATIONS = 12
OPACITY_STEPS = 101  # 0.00～1.00，步长 0.01
MAX_ADJUST = 2
MIN_ADJUST = 1
MIN_CANDIDATES = 2
MAX_CANDIDATES = 12
MAX_SUGGEST_ORDERS = 12
MAX_REVIEW_ORDERS = 12

class CalibrationError(Exception):
    """输入校验失败，errors 为可直接展示给用户的中文错误列表。"""

    def __init__(self, errors: list[dict[str, Any]]):
        super().__init__("; ".join(e["message"] for e in errors))
        self.errors = errors


def _err(scope: str, message: str, index: int | None = None) -> dict[str, Any]:
    e: dict[str, Any] = {"scope": scope, "message": message}
    if index is not None:
        e["index"] = index
    return e


# ---------------------------------------------------------------- 颜色基础 --


def parse_hex(text: Any) -> tuple[str, tuple[float, float, float]]:
    """把 '#rgb' / '#rrggbb'（# 可省略）解析为 (规范 hex, 0~1 sRGB 三元组)。"""
    if not isinstance(text, str):
        raise ValueError("颜色必须是字符串")
    s = text.strip()
    m = _HEX_RE.fullmatch(s)
    if not m:
        raise ValueError(f"非法颜色 {text!r}：需要形如 #RRGGBB 的 HEX 值")
    h = m.group(1)
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    rgb = (int(h[0:2], 16) / 255.0, int(h[2:4], 16) / 255.0, int(h[4:6], 16) / 255.0)
    return "#" + h.lower(), rgb


def srgb_to_linear(c: float) -> float:
    """sRGB 传递函数（0~1）-> 线性光。"""
    if c <= 0.04045:
        return c / 12.92
    return ((c + 0.055) / 1.055) ** 2.4


def linear_to_srgb(c: float) -> float:
    """线性光 -> sRGB 传递函数（0~1）。"""
    if c <= 0.0031308:
        return 12.92 * c
    return 1.055 * (c ** (1.0 / 2.4)) - 0.055


def _clamp01(x: float) -> float:
    return 0.0 if x < 0.0 else (1.0 if x > 1.0 else x)


def over(
    bottom: tuple[float, float, float, float],
    top: tuple[float, float, float, float],
) -> tuple[float, float, float, float]:
    """线性光空间内的 Porter-Duff "over" 合成（两者均为预乘表示）。"""
    br, bg, bb, ba = bottom
    tr, tg, tb, ta = top
    out_a = ta + ba * (1.0 - ta)
    if out_a <= 0.0:
        return (0.0, 0.0, 0.0, 0.0)

    def chan(tc: float, bc: float) -> float:
        return (tc * ta + bc * ba * (1.0 - ta)) / out_a

    return (chan(tr, br), chan(tg, bg), chan(tb, bb), out_a)


def render_stack(
    background_srgb: tuple[float, float, float],
    order: list[int],
    layer_colors_lin: list[tuple[float, float, float]],
    layer_alphas: list[float],
) -> tuple[float, float, float]:
    """以不透明背景打底，按底到顶 order 逐层合成，返回 sRGB(0~1) 结果色。"""
    r, g, b = (srgb_to_linear(v) for v in background_srgb)
    cur = (r, g, b, 1.0)
    for idx in order:
        lr, lg, lb = layer_colors_lin[idx]
        cur = over(cur, (lr, lg, lb, layer_alphas[idx]))
    out = tuple(_clamp01(linear_to_srgb(cur[c])) for c in range(3))
    return out  # type: ignore[return-value]


# ----------------------------------------------------------------- 环检测 --


def _find_cycle(adj: list[list[int]]) -> list[int] | None:
    """DFS 找有向图中的环，返回环上节点下标序列（首尾相同），无环返回 None。"""
    n = len(adj)
    WHITE, GRAY, BLACK = 0, 1, 2
    color = [WHITE] * n
    parent = [-1] * n

    def dfs(u: int) -> list[int] | None:
        color[u] = GRAY
        for v in adj[u]:
            if color[v] == GRAY:  # 自环与回边均落在此处
                path = [u]
                cur = u
                while cur != v:
                    cur = parent[cur]
                    path.append(cur)
                path.reverse()
                path.append(v)
                return path
            if color[v] == WHITE:
                parent[v] = u
                found = dfs(v)
                if found is not None:
                    return found
        color[u] = BLACK
        return None

    for start in range(n):
        if color[start] == WHITE:
            found = dfs(start)
            if found is not None:
                return found
    return None


# --------------------------------------------------------- 输入解析（共用） --


@dataclass
class _Parsed:
    ids: list[str]
    hexes: list[str]
    lins: list[tuple[float, float, float]]
    alphas: list[float]
    seen_ids: dict[str, int]
    bg_hex: list[str]
    bg_srgb: list[tuple[float, float, float]]
    tg_hex: list[str]
    tg_srgb: list[tuple[float, float, float]]
    pairs: list[tuple[int, int]]


def _parse_inputs(payload: Any) -> tuple[_Parsed, list[dict[str, Any]]]:
    """解析 layers/samples/relations。结构性致命错误直接抛，字段错误收集后返回。"""
    if not isinstance(payload, dict):
        raise CalibrationError([_err("form", "请求体必须是 JSON 对象")])

    errors: list[dict[str, Any]] = []

    raw_layers = payload.get("layers")
    raw_samples = payload.get("samples")
    raw_relations = payload.get("relations", [])

    # ---- 图层 -------------------------------------------------------------
    if not isinstance(raw_layers, list):
        raise CalibrationError([_err("layers", "缺少 layers 列表或其格式不正确")])
    if not (MIN_LAYERS <= len(raw_layers) <= MAX_LAYERS):
        errors.append(
            _err("layers", f"图层数量必须在 {MIN_LAYERS}～{MAX_LAYERS} 个之间，当前 {len(raw_layers)} 个")
        )

    layer_ids: list[str] = []
    layer_hex: list[str] = []
    layer_lin: list[tuple[float, float, float]] = []
    layer_alpha: list[float] = []
    seen_ids: dict[str, int] = {}

    for i, item in enumerate(raw_layers):
        if not isinstance(item, dict):
            errors.append(_err("layers", "图层数据格式不正确，应为对象", i))
            continue

        lid = item.get("id")
        if not isinstance(lid, str) or not lid.strip():
            errors.append(_err("layers", "图层 ID 不能为空", i))
            lid = ""
        else:
            lid = lid.strip()
            if lid in seen_ids:
                errors.append(_err("layers", f"图层 ID 重复：{lid}", i))
            else:
                seen_ids[lid] = i

        try:
            norm, rgb = parse_hex(item.get("color"))
        except ValueError as exc:
            errors.append(_err("layers", str(exc), i))
            norm, rgb = "#000000", (0.0, 0.0, 0.0)

        opacity = item.get("opacity")
        if isinstance(opacity, bool) or not isinstance(opacity, (int, float)) or not math.isfinite(opacity):
            errors.append(_err("layers", f"不透明度必须是 0～1 的数字（图层 {lid or i + 1}）", i))
            opacity = 1.0
        elif not (0.0 <= float(opacity) <= 1.0):
            errors.append(
                _err("layers", f"不透明度越界：{opacity}，必须在 0～1 之间（图层 {lid or i + 1}）", i)
            )
            opacity = 1.0

        layer_ids.append(lid)
        layer_hex.append(norm)
        layer_lin.append(tuple(srgb_to_linear(c) for c in rgb))  # type: ignore[arg-type]
        layer_alpha.append(float(opacity))

    # ---- 样本 -------------------------------------------------------------
    if not isinstance(raw_samples, list):
        raise CalibrationError([_err("samples", "缺少 samples 列表或其格式不正确")])
    if not (MIN_SAMPLES <= len(raw_samples) <= MAX_SAMPLES):
        errors.append(
            _err("samples", f"样本（背景/目标）组数必须在 {MIN_SAMPLES}～{MAX_SAMPLES} 之间，当前 {len(raw_samples)} 组")
        )

    samples_bg_hex: list[str] = []
    samples_bg_srgb: list[tuple[float, float, float]] = []
    samples_tg_hex: list[str] = []
    samples_tg_srgb: list[tuple[float, float, float]] = []

    for i, item in enumerate(raw_samples):
        if not isinstance(item, dict):
            errors.append(_err("samples", "样本数据格式不正确，应为对象", i))
            continue
        for field, label, sink_hex, sink_rgb in (
            ("background", "背景色", samples_bg_hex, samples_bg_srgb),
            ("target", "目标色", samples_tg_hex, samples_tg_srgb),
        ):
            try:
                norm, rgb = parse_hex(item.get(field))
            except ValueError:
                errors.append(_err("samples", f"{label}非法：需要形如 #RRGGBB 的 HEX 值，实际为 {item.get(field)!r}", i))
                norm, rgb = "#000000", (0.0, 0.0, 0.0)
            sink_hex.append(norm)
            sink_rgb.append(rgb)

    # ---- 先后关系 ---------------------------------------------------------
    if not isinstance(raw_relations, list):
        errors.append(_err("relations", "relations 字段格式不正确，应为数组"))
        raw_relations = []
    if len(raw_relations) > MAX_RELATIONS:
        errors.append(
            _err("relations", f"图层先后关系至多 {MAX_RELATIONS} 条，当前 {len(raw_relations)} 条")
        )

    id_set = {lid for lid in layer_ids if lid}
    pairs: list[tuple[int, int]] = []
    pair_seen: set[tuple[int, int]] = set()
    for i, item in enumerate(raw_relations[:MAX_RELATIONS]):
        if not isinstance(item, dict):
            errors.append(_err("relations", "关系数据格式不正确，应为对象", i))
            continue
        lower, upper = item.get("lower"), item.get("upper")
        if not isinstance(lower, str) or lower.strip() not in id_set:
            errors.append(_err("relations", f"关系下方图层 ID 不存在：{lower!r}", i))
            continue
        if not isinstance(upper, str) or upper.strip() not in id_set:
            errors.append(_err("relations", f"关系上方图层 ID 不存在：{upper!r}", i))
            continue
        lower, upper = lower.strip(), upper.strip()
        li, ui = seen_ids[lower], seen_ids[upper]
        key = (li, ui)
        if key in pair_seen:
            continue  # 重复关系直接去重
        pair_seen.add(key)
        pairs.append((li, ui))

    parsed = _Parsed(
        ids=layer_ids,
        hexes=layer_hex,
        lins=layer_lin,
        alphas=layer_alpha,
        seen_ids=seen_ids,
        bg_hex=samples_bg_hex,
        bg_srgb=samples_bg_srgb,
        tg_hex=samples_tg_hex,
        tg_srgb=samples_tg_srgb,
        pairs=pairs,
    )
    return parsed, errors


def _raise_if_cycle(parsed: _Parsed) -> None:
    n = len(parsed.ids)
    adj: list[list[int]] = [[] for _ in range(n)]
    for li, ui in parsed.pairs:
        adj[li].append(ui)
    cycle = _find_cycle(adj)
    if cycle is not None:
        chain = " → ".join(parsed.ids[x] for x in cycle)
        raise CalibrationError(
            [_err("relations", f"图层先后关系成环，存在冲突：{chain}（底 → 顶方向不能绕回自身）")]
        )


# ------------------------------------------------------- 成环解除方案 --


def _acyclic_pairs(n: int, pairs: list[tuple[int, int]]) -> bool:
    """去掉自环后，给定（已去重）有向边集合是否无环（Kahn 判环）。"""
    indeg = [0] * n
    adj: list[list[int]] = [[] for _ in range(n)]
    for li, ui in pairs:
        if li == ui:
            return False
        adj[li].append(ui)
        indeg[ui] += 1
    queue = deque(i for i in range(n) if indeg[i] == 0)
    seen = 0
    while queue:
        u = queue.popleft()
        seen += 1
        for v in adj[u]:
            indeg[v] -= 1
            if indeg[v] == 0:
                queue.append(v)
    return seen == n


def _minimum_feedback_pairs(parsed: _Parsed) -> list[tuple[int, int]]:
    """在已去重关系边中求「删去条数最少且剩余无环」的一组下标对。

    关系至多 12 条，直接按删除条数升序枚举子集；同条数时边按下标对
    （(lower,upper) 数值对）字典序排列，故首个可行组合即规则要求的
    最少条数并列中列表字典序最小者。自环必删（任何拓扑序都无法满足）。
    """
    n = len(parsed.ids)
    edges = sorted(parsed.pairs)  # (lower 下标, upper 下标) 字典序
    self_loops = {(i, i) for i in range(n)}
    mandatory = [e for e in edges if e in self_loops]
    rest = [e for e in edges if e not in self_loops]

    # 先看仅删自环后是否已经无环（空方案也由此覆盖：edges 为空时无环）
    kept0 = [e for e in rest]
    if _acyclic_pairs(n, kept0):
        return mandatory

    m = len(rest)
    for size in range(1, m + 1):
        remove_rest: list[tuple[int, int]] | None = None
        for combo in itertools.combinations(range(m), size):
            drop = {rest[k] for k in combo}
            kept = [e for e in rest if e not in drop]
            if _acyclic_pairs(n, kept):
                remove_rest = [rest[k] for k in combo]
                break
        if remove_rest is not None:
            return mandatory + remove_rest
    # 全删必然无环，不可达
    raise AssertionError("unreachable")  # pragma: no cover


def _cycle_chain(parsed: _Parsed) -> str:
    """复用 _raise_if_cycle 的提示口径，返回当前关系图上的一条冲突链。"""
    n = len(parsed.ids)
    adj: list[list[int]] = [[] for _ in range(n)]
    for li, ui in parsed.pairs:
        adj[li].append(ui)
    cycle = _find_cycle(adj)
    if cycle is None:
        return ""
    return " → ".join(parsed.ids[x] for x in cycle)


def _has_cycle(parsed: _Parsed) -> bool:
    return bool(_cycle_chain(parsed))


def resolve_cycle(payload: Any) -> dict[str, Any]:
    """成环时给出待确认的最少解除方案；无环时方案为空。

    其余输入非法（图层 / 样本 / 关系字段本身）仍按现有规则收集报错。
    方案中的关系对以规范化 ID 表示并按 (lower, upper) 字典序排序；
    occurrences 为该规范化对在原始 relations 中出现的次数（同向重复
    在方案里只算一条，确认时这些重复项会被一并移除）。
    """
    parsed, errors = _parse_inputs(payload)
    if errors:
        raise CalibrationError(errors)

    n = len(parsed.ids)
    adj: list[list[int]] = [[] for _ in range(n)]
    for li, ui in parsed.pairs:
        adj[li].append(ui)
    cycle = _find_cycle(adj)
    if cycle is None:
        return {
            "cyclic": False,
            "conflictChain": "",
            "relationCount": len(parsed.pairs),
            "removePairs": [],
            "removeCount": 0,
            "removedOccurrences": 0,
        }

    remove_idx = _minimum_feedback_pairs(parsed)
    remove_set = set(remove_idx)

    # 统计原始 relations（截断到上限后、字段合法的条目）中每个规范化对的出现次数
    raw_relations = payload.get("relations", [])
    if not isinstance(raw_relations, list):
        raw_relations = []
    occurrences: dict[tuple[int, int], int] = {}
    id_set = {lid for lid in parsed.ids if lid}
    for item in raw_relations[:MAX_RELATIONS]:
        if not isinstance(item, dict):
            continue
        lower, upper = item.get("lower"), item.get("upper")
        if not isinstance(lower, str) or lower.strip() not in id_set:
            continue
        if not isinstance(upper, str) or upper.strip() not in id_set:
            continue
        key = (parsed.seen_ids[lower.strip()], parsed.seen_ids[upper.strip()])
        occurrences[key] = occurrences.get(key, 0) + 1

    pairs_out = [
        {
            "lower": parsed.ids[li],
            "upper": parsed.ids[ui],
            "selfLoop": li == ui,
            "occurrences": occurrences.get((li, ui), 1),
        }
        for li, ui in sorted(remove_set)
    ]
    return {
        "cyclic": True,
        "conflictChain": " → ".join(parsed.ids[x] for x in cycle),
        "relationCount": len(parsed.pairs),
        "removePairs": pairs_out,
        "removeCount": len(pairs_out),
        "removedOccurrences": sum(p["occurrences"] for p in pairs_out),
    }


def confirm_cycle_resolution(payload: Any) -> dict[str, Any]:
    """确认解除方案：一次性移除指定关系对的全部同向重复项，随后触发原求解。

    removePairs 必须与按当前输入算出的规范化最少方案完全一致（顺序无关，
    多退少补均拒绝）——方案随输入变化即作废，改回原值也不能恢复确认资格。
    """
    parsed, errors = _parse_inputs(payload)
    assert isinstance(payload, dict)  # _parse_inputs 已保证是 dict

    raw_remove = payload.get("removePairs")
    req_pairs: list[tuple[str, str]] = []
    if not isinstance(raw_remove, list):
        errors.append(
            _err("cycleResolution", "缺少 removePairs 列表或其格式不正确：应为待删除关系对数组")
        )
    else:
        seen_req: set[tuple[str, str]] = set()
        id_set = {lid for lid in parsed.ids if lid}
        for i, item in enumerate(raw_remove):
            if not isinstance(item, dict):
                errors.append(_err("cycleResolution", "待删除关系对格式不正确，应为对象", i))
                continue
            lower, upper = item.get("lower"), item.get("upper")
            if not isinstance(lower, str) or lower.strip() not in id_set:
                errors.append(
                    _err("cycleResolution", f"待删除关系的下方图层 ID 不存在：{lower!r}", i)
                )
                continue
            if not isinstance(upper, str) or upper.strip() not in id_set:
                errors.append(
                    _err("cycleResolution", f"待删除关系的上方图层 ID 不存在：{upper!r}", i)
                )
                continue
            key = (lower.strip(), upper.strip())
            if key in seen_req:
                errors.append(
                    _err(
                        "cycleResolution",
                        f"待删除关系对重复：{key[0]} → {key[1]}（同向重复只需列一次）",
                        i,
                    )
                )
                continue
            seen_req.add(key)
            req_pairs.append(key)

    if errors:
        raise CalibrationError(errors)

    # 当前输入无环时唯一合法方案是空方案；有环时取规范化最少方案
    canonical_idx = _minimum_feedback_pairs(parsed) if _has_cycle(parsed) else []
    canonical = {(parsed.ids[li], parsed.ids[ui]) for li, ui in canonical_idx}
    requested = set(req_pairs)
    if requested != canonical:
        raise CalibrationError(
            [
                _err(
                    "cycleResolution",
                    "解除方案已失效：图层、样本或关系已发生变化，请重新获取当前方案后再确认",
                )
            ]
        )

    # 一次性移除这些对的全部重复项（按规范化 ID 匹配），其余输入原样保留
    kept_relations: list[Any] = []
    raw_relations = payload.get("relations", [])
    if isinstance(raw_relations, list):
        for item in raw_relations:
            if isinstance(item, dict):
                lower = item.get("lower")
                upper = item.get("upper")
                if (
                    isinstance(lower, str)
                    and isinstance(upper, str)
                    and (lower.strip(), upper.strip()) in canonical
                ):
                    continue
            kept_relations.append(item)

    solve_payload = {**payload, "relations": kept_relations}
    solve_payload.pop("removePairs", None)
    return solve(solve_payload)


def _total_sse(
    parsed: _Parsed, order: list[int], alphas: list[float]
) -> float:
    """给定顺序与不透明度，计算全部样本未取整 RGB 平方误差总和。"""
    total = 0.0
    for s in range(len(parsed.bg_hex)):
        pred = render_stack(parsed.bg_srgb[s], order, parsed.lins, alphas)
        for c in range(3):
            diff = pred[c] * 255.0 - parsed.tg_srgb[s][c] * 255.0
            total += diff * diff
    return total


def _sample_details(
    parsed: _Parsed, order: list[int], alphas: list[float]
) -> tuple[list[dict[str, Any]], float]:
    """组装每个样本的预测色与分通道误差，并返回总 SSE。"""
    results: list[dict[str, Any]] = []
    total = 0.0
    for s in range(len(parsed.bg_hex)):
        pred = render_stack(parsed.bg_srgb[s], order, parsed.lins, alphas)
        pred255 = [_clamp01(pred[c]) * 255.0 for c in range(3)]
        tgt255 = [parsed.tg_srgb[s][c] * 255.0 for c in range(3)]
        channel_sse = [(pred255[c] - tgt255[c]) ** 2 for c in range(3)]
        sse = sum(channel_sse)
        total += sse
        rounded = [max(0, min(255, int(round(v)))) for v in pred255]
        results.append(
            {
                "index": s,
                "background": parsed.bg_hex[s],
                "target": parsed.tg_hex[s],
                "predictedRgb": pred255,
                "predictedHex": "#{:02x}{:02x}{:02x}".format(*rounded),
                "targetRgb": tgt255,
                "channelSse": channel_sse,
                "sse": sse,
            }
        )
    return results, total


# ------------------------------------------------------------------- 求解 --


def _feasible_perms(
    n: int, pairs: list[tuple[int, int]]
) -> list[tuple[int, ...]]:
    """枚举满足全部先后关系（lower 在 upper 下方）的底→顶排列。"""
    def feasible(perm: tuple[int, ...]) -> bool:
        pos = [0] * n
        for p, idx in enumerate(perm):
            pos[idx] = p
        return all(pos[li] < pos[ui] for li, ui in pairs)

    return [perm for perm in itertools.permutations(range(n)) if feasible(perm)]


def _orders_within_tolerance(
    parsed: _Parsed, tolerance: float
) -> tuple[list[tuple[float, tuple[str, ...], tuple[int, ...]]], float, list[tuple[int, ...]]]:
    """枚举全部合规叠序，返回 (旧总误差 ≤ 最优旧总误差 + 容差的叠序, 最优旧总误差, 全部合规排列)。

    返回列表已按（旧总误差、ID 序列）排序；旧总误差走 _total_sse（0–255
    未取整平方误差总和），与 solve/建议页同一口径。
    """
    perms = _feasible_perms(len(parsed.ids), parsed.pairs)
    evaluated: list[tuple[float, tuple[str, ...], tuple[int, ...]]] = []
    best_sse = math.inf
    for perm in perms:
        sse = _total_sse(parsed, list(perm), parsed.alphas)
        best_sse = min(best_sse, sse)
        evaluated.append((sse, tuple(parsed.ids[idx] for idx in perm), perm))

    limit = best_sse + tolerance
    kept = [e for e in evaluated if e[0] <= limit]
    kept.sort(key=lambda e: (e[0], e[1]))
    return kept, best_sse, perms


# ------------------------------------------------------------------- 求解 --


def solve(payload: Any) -> dict[str, Any]:
    parsed, errors = _parse_inputs(payload)
    if errors:
        raise CalibrationError(errors)
    _raise_if_cycle(parsed)

    n = len(parsed.ids)
    pairs = parsed.pairs

    # ---- 枚举排列并选优 ---------------------------------------------------
    def feasible(perm: tuple[int, ...]) -> bool:
        pos = [0] * n
        for p, idx in enumerate(perm):
            pos[idx] = p
        return all(pos[li] < pos[ui] for li, ui in pairs)

    best_sse = math.inf
    best_key: tuple[float, tuple[str, ...]] | None = None
    best_perm: tuple[int, ...] | None = None
    feasible_count = 0
    total_count = math.factorial(n)

    for perm in itertools.permutations(range(n)):
        if not feasible(perm):
            continue
        feasible_count += 1
        total_sse = _total_sse(parsed, list(perm), parsed.alphas)
        id_seq = tuple(parsed.ids[idx] for idx in perm)
        if best_key is None or (total_sse, id_seq) < best_key:
            best_sse = total_sse
            best_key = (total_sse, id_seq)
            best_perm = perm

    # 有环已在上面拦截；这里仅作防御
    if best_perm is None:  # pragma: no cover
        raise CalibrationError([_err("relations", "约束过强，没有任何可行的图层顺序")])

    assert best_perm is not None
    # 与 infer_opacities 的「调整前」走同一明细汇总，保证两边 totalSse 逐位一致
    sample_results, total_sse = _sample_details(parsed, list(best_perm), parsed.alphas)

    return {
        "order": [parsed.ids[idx] for idx in best_perm],
        "orderIndexes": list(best_perm),
        "layers": [
            {"id": parsed.ids[i], "color": parsed.hexes[i], "opacity": parsed.alphas[i]}
            for i in best_perm
        ],
        "totalSse": total_sse,
        "permutationsChecked": total_count,
        "feasibleCount": feasible_count,
        "samples": sample_results,
    }


# --------------------------------------------------------- 不透明度反推 --


def infer_opacities(payload: Any) -> dict[str, Any]:
    """顺序固定、其余图层不透明度保留原值，网格联合反推 1～2 个图层的不透明度。"""
    parsed, errors = _parse_inputs(payload)
    n = len(parsed.ids)
    id_set = {lid for lid in parsed.ids if lid}

    # ---- 底到顶顺序 -------------------------------------------------------
    raw_order = payload.get("order") if isinstance(payload, dict) else None
    order_ids: list[str] = []
    order_valid = True
    if not isinstance(raw_order, list):
        errors.append(
            _err("order", "缺少 order 列表或其格式不正确：必须按底→顶顺序给出全部图层 ID")
        )
        order_valid = False
    else:
        if len(raw_order) != n:
            errors.append(
                _err("order", f"order 必须恰好包含全部 {n} 个图层 ID（各一次），当前 {len(raw_order)} 个")
            )
            order_valid = False
        seen_order: set[str] = set()
        for x in raw_order:
            if not isinstance(x, str) or not x.strip():
                errors.append(_err("order", f"order 中的图层 ID 非法：{x!r}（必须是已存在的图层 ID）"))
                order_valid = False
                continue
            x = x.strip()
            if x not in id_set:
                errors.append(_err("order", f"order 中的图层 ID 不存在：{x!r}"))
                order_valid = False
            elif x in seen_order:
                errors.append(
                    _err("order", f"order 中图层 ID 重复：{x}，每个图层必须且只能出现一次")
                )
                order_valid = False
            else:
                seen_order.add(x)
            order_ids.append(x)

    # ---- 待调图层 ---------------------------------------------------------
    raw_adjust = payload.get("adjustIds") if isinstance(payload, dict) else None
    adjust_ids: list[str] = []
    if not isinstance(raw_adjust, list):
        errors.append(
            _err("adjust", "缺少 adjustIds 列表或其格式不正确：必须选择 1～2 个待反推图层 ID")
        )
    else:
        if not (MIN_ADJUST <= len(raw_adjust) <= MAX_ADJUST):
            errors.append(
                _err("adjust", f"待调图层必须为 {MIN_ADJUST}～{MAX_ADJUST} 个，当前 {len(raw_adjust)} 个")
            )
        seen_adjust: set[str] = set()
        for x in raw_adjust:
            if not isinstance(x, str) or not x.strip() or x.strip() not in id_set:
                errors.append(_err("adjust", f"待调图层 ID 不存在：{x!r}"))
                continue
            x = x.strip()
            if x in seen_adjust:
                errors.append(_err("adjust", f"待调图层 ID 重复：{x}，同一图层只能选择一次"))
                continue
            seen_adjust.add(x)
            adjust_ids.append(x)

    if errors:
        raise CalibrationError(errors)
    _raise_if_cycle(parsed)

    order_idx = [parsed.seen_ids[x] for x in order_ids]

    # ---- 顺序必须符合先后关系 ---------------------------------------------
    pos = [0] * n
    for p, idx in enumerate(order_idx):
        pos[idx] = p
    for li, ui in parsed.pairs:
        if pos[li] >= pos[ui]:
            raise CalibrationError(
                [
                    _err(
                        "order",
                        f"所给顺序不符合先后关系：{parsed.ids[li]} 必须在 {parsed.ids[ui]} 下方（底 → 顶）",
                    )
                ]
            )

    # 待调图层按 ID 字典序排列，元组决胜均以此顺序为准
    adjust_ids = sorted(adjust_ids)
    adjust_idx = [parsed.seen_ids[x] for x in adjust_ids]
    k = len(adjust_idx)
    original_tuple = tuple(round(parsed.alphas[i], 10) for i in adjust_idx)
    original_on_grid = all(abs(a - round(a, 2)) <= 1e-9 for a in original_tuple)

    # ---- 联合遍历 0.00～1.00（步长 0.01），并额外纳入原始参数组 -----------
    best_sse = math.inf
    best_tuple: tuple[float, ...] | None = None

    def consider(values: tuple[float, ...], total_sse: float) -> None:
        nonlocal best_sse, best_tuple
        if best_tuple is None or (total_sse, values) < (best_sse, best_tuple):
            best_sse = total_sse
            best_tuple = values

    alphas = parsed.alphas.copy()
    for steps in itertools.product(range(OPACITY_STEPS), repeat=k):
        combo = tuple(s / 100.0 for s in steps)
        for j, ai in enumerate(adjust_idx):
            alphas[ai] = combo[j]
        consider(combo, _total_sse(parsed, order_idx, alphas))

    if not original_on_grid:
        for j, ai in enumerate(adjust_idx):
            alphas[ai] = original_tuple[j]
        consider(original_tuple, _total_sse(parsed, order_idx, alphas))

    combos_checked = OPACITY_STEPS**k + (0 if original_on_grid else 1)
    assert best_tuple is not None

    # ---- 调整前后明细（建议值即最优元组；若原始参数组最优则建议=原值）-------
    before_samples, before_total = _sample_details(parsed, order_idx, parsed.alphas)

    after_alphas = parsed.alphas.copy()
    for j, ai in enumerate(adjust_idx):
        after_alphas[ai] = best_tuple[j]
    after_samples, after_total = _sample_details(parsed, order_idx, after_alphas)

    adjustments = [
        {
            "id": adjust_ids[j],
            "index": adjust_idx[j],
            "originalOpacity": parsed.alphas[adjust_idx[j]],
            "suggestedOpacity": round(best_tuple[j], 10),
        }
        for j in range(k)
    ]

    return {
        "order": [parsed.ids[i] for i in order_idx],
        "orderIndexes": order_idx,
        "adjustIds": adjust_ids,
        "layers": [
            {"id": parsed.ids[i], "color": parsed.hexes[i], "opacity": parsed.alphas[i]}
            for i in order_idx
        ],
        "adjustments": adjustments,
        "beforeTotalSse": before_total,
        "afterTotalSse": after_total,
        "beforeSamples": before_samples,
        "afterSamples": after_samples,
        "combosChecked": combos_checked,
        "opacityGrid": {"min": 0.0, "max": 1.0, "step": 0.01},
    }


# --------------------------------------------------------- 背景测量建议 --


def _parse_candidate_backgrounds(
    raw_candidates: Any, errors: list[dict[str, Any]]
) -> tuple[list[str], list[tuple[float, float, float]]]:
    """解析 2～12 个规范化后互不重复的候选背景 HEX，非法/重复记入 errors。"""
    if not isinstance(raw_candidates, list):
        errors.append(_err("candidates", "缺少 candidateBackgrounds 列表或其格式不正确"))
        raw_candidates = []
    if not (MIN_CANDIDATES <= len(raw_candidates) <= MAX_CANDIDATES):
        errors.append(
            _err(
                "candidates",
                f"候选背景数量必须在 {MIN_CANDIDATES}～{MAX_CANDIDATES} 个之间，当前 {len(raw_candidates)} 个",
            )
        )

    cand_hex: list[str] = []
    cand_srgb: list[tuple[float, float, float]] = []
    seen_cand: dict[str, int] = {}
    for i, item in enumerate(raw_candidates[:MAX_CANDIDATES]):
        try:
            norm, rgb = parse_hex(item)
        except ValueError:
            errors.append(
                _err("candidates", f"候选背景色非法：需要形如 #RRGGBB 的 HEX 值，实际为 {item!r}", i)
            )
            continue
        if norm in seen_cand:
            errors.append(
                _err("candidates", f"候选背景色重复：{norm}（与第 {seen_cand[norm] + 1} 个规范化后相同）", i)
            )
            continue
        seen_cand[norm] = i
        cand_hex.append(norm)
        cand_srgb.append(rgb)
    return cand_hex, cand_srgb


def _parse_nonneg_number(
    raw: Any, scope: str, label: str, errors: list[dict[str, Any]]
) -> tuple[float, bool]:
    """解析非负有限数字，非法/为负时把中文错误写入 errors。label 为字段中文名。"""
    if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not math.isfinite(raw):
        errors.append(_err(scope, f"{label}必须是非负有限的数字，实际为 {raw!r}"))
        return 0.0, False
    if raw < 0:
        errors.append(_err(scope, f"{label}不能为负：{raw}"))
        return 0.0, False
    return float(raw), True


def suggest_background(payload: Any) -> dict[str, Any]:
    """下一次背景测量建议。

    沿用当前图层、样本与先后关系：枚举合规叠序，保留总误差不高于
    最优总误差 + 容差的顺序（按总误差、ID 序列排序取前 12 条），再在每个
    候选背景上按现有线性光规则渲染这些顺序，以任意两条预测色未取整
    RGB（0–255 尺度）平方距离的最小值给背景打分；推荐得分最高者，
    同分取规范化 HEX 字典序最小者。容差内不足两条顺序时无需追加测量。
    """
    parsed, errors = _parse_inputs(payload)
    assert isinstance(payload, dict)  # _parse_inputs 已保证是 dict

    # ---- 候选背景 ---------------------------------------------------------
    cand_hex, cand_srgb = _parse_candidate_backgrounds(
        payload.get("candidateBackgrounds"), errors
    )

    # ---- 误差容差 ----------------------------------------------------------
    tolerance, _ = _parse_nonneg_number(payload.get("tolerance"), "tolerance", "误差容差", errors)

    if errors:
        raise CalibrationError(errors)
    _raise_if_cycle(parsed)

    # ---- 枚举合规叠序，按容差保留 ------------------------------------------
    kept, _, all_feasible = _orders_within_tolerance(parsed, tolerance)
    feasible_count = len(all_feasible)
    within_count = len(kept)
    top = kept[:MAX_SUGGEST_ORDERS]

    # 展示用总误差走 _sample_details 汇总，与 /api/solve 的 totalSse 逐位一致
    orders: list[dict[str, Any]] = []
    for _sse, id_seq, perm in top:
        _, display_sse = _sample_details(parsed, list(perm), parsed.alphas)
        orders.append(
            {
                "order": list(id_seq),
                "orderIndexes": list(perm),
                "totalSse": display_sse,
            }
        )

    result: dict[str, Any] = {
        "tolerance": tolerance,
        "bestSse": orders[0]["totalSse"] if orders else 0.0,
        "feasibleCount": feasible_count,
        "withinCount": within_count,
        "orders": orders,
        "needsMeasurement": len(orders) >= 2,
        "candidates": [],
        "recommended": None,
    }

    if len(orders) < 2:
        return result  # 容差内不足两条顺序：当前样本已能唯一区分，无需追加测量

    # ---- 在每个候选背景上渲染并打分 ----------------------------------------
    order_perms = [list(perm) for _sse, _ids, perm in top]

    def pred_entry(k: int, preds255: list[tuple[float, float, float]]) -> dict[str, Any]:
        p = preds255[k]
        rounded = [max(0, min(255, int(round(v)))) for v in p]
        return {
            "order": orders[k]["order"],
            "orderIndexes": orders[k]["orderIndexes"],
            "predictedRgb": [p[0], p[1], p[2]],
            "predictedHex": "#{:02x}{:02x}{:02x}".format(*rounded),
        }

    recommended: dict[str, Any] | None = None
    for hex_norm, bg_srgb in zip(cand_hex, cand_srgb):
        preds255: list[tuple[float, float, float]] = []
        for perm in order_perms:
            pred = render_stack(bg_srgb, perm, parsed.lins, parsed.alphas)
            preds255.append((pred[0] * 255.0, pred[1] * 255.0, pred[2] * 255.0))

        # 任意两条顺序预测色的平方距离最小值即该背景得分；同分保留先枚举到的一对
        min_dist = math.inf
        min_pair = (0, 1)
        for i in range(len(preds255)):
            ai = preds255[i]
            for j in range(i + 1, len(preds255)):
                aj = preds255[j]
                d = (ai[0] - aj[0]) ** 2 + (ai[1] - aj[1]) ** 2 + (ai[2] - aj[2]) ** 2
                if d < min_dist:
                    min_dist = d
                    min_pair = (i, j)

        entry = {
            "hex": hex_norm,
            "score": min_dist,
            "pair": {"a": pred_entry(min_pair[0], preds255), "b": pred_entry(min_pair[1], preds255)},
        }
        result["candidates"].append(entry)
        if (
            recommended is None
            or entry["score"] > recommended["score"]
            or (entry["score"] == recommended["score"] and entry["hex"] < recommended["hex"])
        ):
            recommended = entry

    result["recommended"] = recommended
    return result


# ----------------------------------------------------------- 实测颜色复核 --


def review_measurement(payload: Any) -> dict[str, Any]:
    """候选背景上的实测颜色复核。

    沿用当前图层、旧样本、先后关系及建议容差：先枚举旧样本总误差不高于
    最优值 + 容差的全部合规叠序（建议页只展示前 12 条，但这里一条不漏），
    再在选定候选背景上以未取整 0～255 RGB 与实测色计算平方误差，仅留下
    不超过新测量误差上限的叠序；结果按（新测量误差、旧总误差、ID 序列）
    排序后展示前 12 条，并给出筛选前后总数。
    """
    parsed, errors = _parse_inputs(payload)
    assert isinstance(payload, dict)  # _parse_inputs 已保证是 dict

    # ---- 候选背景（沿用建议页录入，复核只需选定其中一个）-------------------
    cand_hex, _cand_srgb = _parse_candidate_backgrounds(
        payload.get("candidateBackgrounds"), errors
    )
    cand_set = set(cand_hex)

    raw_selected = payload.get("selectedBackground")
    selected_norm = ""
    selected_srgb: tuple[float, float, float] | None = None
    if not isinstance(raw_selected, str) or not raw_selected.strip():
        errors.append(_err("review", "请从候选背景中选择一个用于复核的背景"))
    else:
        try:
            selected_norm, selected_rgb = parse_hex(raw_selected)
        except ValueError:
            errors.append(
                _err(
                    "review",
                    f"选定的复核背景色非法：需要形如 #RRGGBB 的 HEX 值，实际为 {raw_selected!r}",
                )
            )
        else:
            if selected_norm not in cand_set:
                errors.append(
                    _err(
                        "review",
                        f"选定的复核背景 {selected_norm} 不在候选背景列表中，请先在建议区选择一个候选背景",
                    )
                )
            else:
                selected_srgb = selected_rgb

    # ---- 实测目标色 -------------------------------------------------------
    raw_measured = payload.get("measuredColor")
    measured_norm = ""
    measured_srgb: tuple[float, float, float] | None = None
    if not isinstance(raw_measured, str) or not raw_measured.strip():
        errors.append(
            _err(
                "review",
                f"实测目标色非法：需要形如 #RRGGBB 的 HEX 值，实际为 {raw_measured!r}",
            )
        )
    else:
        try:
            measured_norm, measured_srgb = parse_hex(raw_measured)
        except ValueError:
            errors.append(
                _err(
                    "review",
                    f"实测目标色非法：需要形如 #RRGGBB 的 HEX 值，实际为 {raw_measured!r}",
                )
            )

    # ---- 沿用建议容差 / 新测量误差上限 -------------------------------------
    tolerance, _ = _parse_nonneg_number(payload.get("tolerance"), "tolerance", "误差容差", errors)
    measure_limit, limit_ok = _parse_nonneg_number(
        payload.get("measurementLimit"), "review", "新测量误差上限", errors
    )

    if errors:
        raise CalibrationError(errors)
    _raise_if_cycle(parsed)
    assert selected_srgb is not None and measured_srgb is not None and limit_ok

    # ---- 容差内的全部合规叠序（不截断为前 12 条，复核必须逐条参与）--------
    kept, _, all_feasible = _orders_within_tolerance(parsed, tolerance)
    feasible_count = len(all_feasible)
    within_count = len(kept)

    # ---- 在选定背景上渲染并按新测量误差上限筛选 ----------------------------
    measured255 = (
        measured_srgb[0] * 255.0,
        measured_srgb[1] * 255.0,
        measured_srgb[2] * 255.0,
    )
    matched: list[dict[str, Any]] = []
    for _raw_sse, id_seq, perm in kept:
        pred = render_stack(selected_srgb, list(perm), parsed.lins, parsed.alphas)
        pred255 = [_clamp01(pred[c]) * 255.0 for c in range(3)]
        channel_sse = [(pred255[c] - measured255[c]) ** 2 for c in range(3)]
        measure_sse = sum(channel_sse)
        if measure_sse > measure_limit:
            continue
        rounded = [max(0, min(255, int(round(v)))) for v in pred255]
        # 展示用旧总误差走 _sample_details，与 /api/solve、建议页逐位一致
        _, display_old_sse = _sample_details(parsed, list(perm), parsed.alphas)
        matched.append(
            {
                "order": list(id_seq),
                "orderIndexes": list(perm),
                "oldTotalSse": display_old_sse,
                "measurementSse": measure_sse,
                "predictedRgb": pred255,
                "predictedHex": "#{:02x}{:02x}{:02x}".format(*rounded),
                "channelSse": channel_sse,
            }
        )

    matched.sort(key=lambda o: (o["measurementSse"], o["oldTotalSse"], tuple(o["order"])))
    matched_count = len(matched)

    # 最优旧总误差：kept 已按（旧总误差、ID 序列）排序，取第一条的展示口径即可
    _, best_sse = _sample_details(parsed, list(kept[0][2]), parsed.alphas)

    return {
        "tolerance": tolerance,
        "measurementLimit": measure_limit,
        "selectedBackground": selected_norm,
        "measuredColor": measured_norm,
        "bestSse": best_sse,
        "feasibleCount": feasible_count,
        "withinCount": within_count,
        "matchedCount": matched_count,
        "compatible": matched_count > 0,
        "shownCount": min(matched_count, MAX_REVIEW_ORDERS),
        "orders": matched[:MAX_REVIEW_ORDERS],
        "sampleCount": len(parsed.bg_hex),
        "canAppendSample": matched_count > 0 and len(parsed.bg_hex) < MAX_SAMPLES,
    }


# ----------------------------------------------------------- 过渡步骤规划 --


def _parse_full_order(
    raw_order: Any, parsed: _Parsed, errors: list[dict[str, Any]]
) -> list[int] | None:
    """校验「恰好包含全部图层 ID 各一次」的底→顶顺序，成功返回下标序列。"""
    n = len(parsed.ids)
    id_set = {lid for lid in parsed.ids if lid}
    order_ids: list[str] = []
    ok = True
    if not isinstance(raw_order, list):
        errors.append(
            _err("transition", "缺少 currentOrder 列表或其格式不正确：必须按底→顶顺序给出全部图层 ID")
        )
        return None
    if len(raw_order) != n:
        errors.append(
            _err(
                "transition",
                f"currentOrder 必须恰好包含全部 {n} 个图层 ID（各一次），当前 {len(raw_order)} 个",
            )
        )
        ok = False
    seen: set[str] = set()
    for x in raw_order:
        if not isinstance(x, str) or not x.strip():
            errors.append(_err("transition", f"currentOrder 中的图层 ID 非法：{x!r}（必须是已存在的图层 ID）"))
            ok = False
            continue
        x = x.strip()
        if x not in id_set:
            errors.append(_err("transition", f"currentOrder 中的图层 ID 不存在：{x!r}"))
            ok = False
        elif x in seen:
            errors.append(_err("transition", f"currentOrder 中图层 ID 重复：{x}，每个图层必须且只能出现一次"))
            ok = False
        else:
            seen.add(x)
        order_ids.append(x)
    if not ok:
        return None
    return [parsed.seen_ids[x] for x in order_ids]


def plan_transition(payload: Any) -> dict[str, Any]:
    """从当前实际叠序调整到原求解最优叠序的最少相邻交换路径。

    节点为满足全部先后关系的底→顶叠序，边为相邻两层交换（交换后仍须
    合规）；只允许经过旧样本未取整 RGB 总平方误差不超过 transitionLimit
    的节点。BFS 求最少交换次数；每个节点的后继按「交换前两层 ID 对」
    字典序展开，首次到达目标的路径即字典序决胜后的最短路径。
    """
    parsed, errors = _parse_inputs(payload)
    assert isinstance(payload, dict)  # _parse_inputs 已保证是 dict

    current_idx = _parse_full_order(payload.get("currentOrder"), parsed, errors)
    limit, _ = _parse_nonneg_number(
        payload.get("transitionLimit"), "transition", "过渡总误差上限", errors
    )

    if errors:
        raise CalibrationError(errors)
    _raise_if_cycle(parsed)
    assert current_idx is not None

    n = len(parsed.ids)

    # ---- 当前顺序必须符合全部先后关系 -------------------------------------
    pos = [0] * n
    for p, idx in enumerate(current_idx):
        pos[idx] = p
    for li, ui in parsed.pairs:
        if pos[li] >= pos[ui]:
            raise CalibrationError(
                [
                    _err(
                        "transition",
                        f"当前顺序不符合先后关系：{parsed.ids[li]} 必须在 {parsed.ids[ui]} 下方（底 → 顶）",
                    )
                ]
            )

    # ---- 枚举全部合规叠序及旧样本总误差 ------------------------------------
    # 所有比较与展示统一使用 _sample_details 口径（与 /api/solve 的 totalSse
    # 逐位一致），这样用户直接把求解返回的 totalSse 作为 transitionLimit 时
    # 不会被不同运算顺序的浮点舍入差误伤；每个排列只渲染一次。
    perms = _feasible_perms(n, parsed.pairs)
    sse_cache: dict[tuple[int, ...], tuple[float, list[dict[str, Any]]]] = {}
    best_key: tuple[float, tuple[str, ...]] | None = None
    best_perm: tuple[int, ...] | None = None
    for perm in perms:
        samples, sse = _sample_details(parsed, list(perm), parsed.alphas)
        sse_cache[perm] = (sse, samples)
        id_seq = tuple(parsed.ids[idx] for idx in perm)
        if best_key is None or (sse, id_seq) < best_key:
            best_key = (sse, id_seq)
            best_perm = perm
    assert best_perm is not None

    start = tuple(current_idx)
    goal: tuple[int, ...] = best_perm
    current_sse, current_samples = sse_cache[start]

    # ---- 当前顺序的旧样本总误差不允许超过上限 -------------------------------
    if current_sse > limit:
        raise CalibrationError(
            [
                _err(
                    "transition",
                    f"当前顺序的旧样本总误差 {fmt_num(current_sse)} 已超过过渡总误差上限 "
                    f"{fmt_num(limit)}，无法在此上限下开始调整，请放宽上限",
                )
            ]
        )

    allowed = {perm for perm, (sse, _s) in sse_cache.items() if sse <= limit}
    current_display_sse = current_sse
    target_display_sse, target_samples = sse_cache[goal]

    result_base: dict[str, Any] = {
        "transitionLimit": limit,
        "currentOrder": [parsed.ids[i] for i in start],
        "currentOrderIndexes": list(start),
        "currentTotalSse": current_display_sse,
        "currentSamples": current_samples,
        "targetOrder": [parsed.ids[i] for i in goal],
        "targetOrderIndexes": list(goal),
        "targetTotalSse": target_display_sse,
        "targetSamples": target_samples,
        "bestSse": target_display_sse,
        "feasibleCount": len(perms),
        "allowedCount": len(allowed),
        "alreadyTarget": start == goal,
    }

    # ---- 当前已是目标：空步骤 ----------------------------------------------
    if start == goal:
        return {**result_base, "reachable": True, "steps": [], "stepCount": 0, "statesVisited": 1}

    # ---- BFS：后继按交换前（下方 ID, 上方 ID）字典序展开 ---------------------
    parent: dict[tuple[int, ...], tuple[tuple[int, ...], tuple[str, str], int]] = {}
    visited = {start}
    queue: deque[tuple[int, ...]] = deque([start])
    found = False

    while queue and not found:
        node = queue.popleft()
        neighbors: list[tuple[tuple[str, str], int, tuple[int, ...]]] = []
        for k in range(n - 1):
            lower_idx = node[k]
            upper_idx = node[k + 1]
            # 显式先后关系禁止的相邻交换一律不合法（传递约束在此结构下自动满足）
            violates = any(li == lower_idx and ui == upper_idx for li, ui in parsed.pairs)
            if violates:
                continue
            nxt = list(node)
            nxt[k], nxt[k + 1] = nxt[k + 1], nxt[k]
            nxt_t = tuple(nxt)
            if nxt_t not in allowed:
                continue
            pair = (parsed.ids[lower_idx], parsed.ids[upper_idx])
            neighbors.append((pair, k, nxt_t))
        neighbors.sort(key=lambda nb: nb[0])
        for pair, k, nxt_t in neighbors:
            if nxt_t in visited:
                continue
            visited.add(nxt_t)
            parent[nxt_t] = (node, pair, k)
            if nxt_t == goal:
                found = True
                break
            queue.append(nxt_t)

    if goal not in visited:
        return {
            **result_base,
            "reachable": False,
            "steps": [],
            "stepCount": 0,
            "statesVisited": len(visited),
            "message": (
                f"目标叠序 {result_base['targetOrder']} 虽满足先后关系且总误差 "
                f"{fmt_num(target_display_sse)} ≤ 上限 {fmt_num(limit)}，但在只交换相邻两层、"
                f"每一步都满足先后关系且旧样本总误差不超过上限的条件下，从当前叠序 "
                f"{result_base['currentOrder']} 没有合规路径可以到达"
            ),
        }

    # ---- 回溯路径（目标 → 当前），再反转为底 → 顶的执行顺序 ------------------
    chain: list[tuple[tuple[int, ...], tuple[str, str], int]] = []
    cur = goal
    while cur != start:
        prev, pair, k = parent[cur]
        chain.append((cur, pair, k))
        cur = prev
    chain.reverse()

    steps: list[dict[str, Any]] = []
    for step_no, (node_after, pair, k) in enumerate(chain, start=1):
        total_sse, samples = sse_cache[node_after]
        steps.append(
            {
                "step": step_no,
                "swapIndex": k,
                "swappedLowerId": pair[0],
                "swappedUpperId": pair[1],
                "pair": [pair[0], pair[1]],
                "order": [parsed.ids[i] for i in node_after],
                "orderIndexes": list(node_after),
                "totalSse": total_sse,
                "samples": samples,
            }
        )

    return {
        **result_base,
        "reachable": True,
        "steps": steps,
        "stepCount": len(steps),
        "statesVisited": len(visited),
    }


def fmt_num(v: float) -> str:
    """把 SSE / 上限数字格式化为简洁中文报错文本（避免过长浮点尾数）。"""
    r = float(v)
    if r == int(r):
        return str(int(r))
    return f"{r:.6g}"
