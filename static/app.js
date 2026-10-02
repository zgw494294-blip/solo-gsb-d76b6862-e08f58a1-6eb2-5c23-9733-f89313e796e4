/* 透明图层叠序校准台 —— 前端逻辑（原生 JS） */
"use strict";

const MIN_LAYERS = 2, MAX_LAYERS = 7;
const MIN_SAMPLES = 1, MAX_SAMPLES = 4;
const MAX_RELATIONS = 12;
const MIN_CANDIDATES = 2, MAX_CANDIDATES = 12;

const state = {
  layers: [
    { id: "R", color: "#ff0000", opacity: 0.5 },
    { id: "B", color: "#0000ff", opacity: 0.5 },
  ],
  samples: [
    { background: "#ffffff", target: "#e189bc" },
    { background: "#000000", target: "#bc0089" },
  ],
  relations: [], // {lower, upper}
};

let solveTimer = null;
let lastErrorKey = "";
let inflightToken = 0;
let lastSolveResult = null; // 最近一次成功的求解结果（供过渡面板重置/默认上限）

const $ = (sel) => document.querySelector(sel);
const elLayers = $("#layers");
const elSamples = $("#samples");
const elRelations = $("#relations");
const elErrorBanner = $("#errorBanner");
const elErrorList = $("#errorList");
const elResultBody = $("#resultBody");
const elStatus = $("#status");

// ------------------------------------------------------------ 工具函数 --

function normalizeHex(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;
  if (s[0] !== "#") s = "#" + s;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    s = "#" + s[1].repeat(2) + s[2].repeat(2) + s[3].repeat(2);
  }
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function scheduleSolve(delay = 200) {
  clearTimeout(solveTimer);
  solveTimer = setTimeout(runSolve, delay);
  markInferStaleness();
  markSuggestStaleness();
  markReviewStaleness();
  markTransitionStaleness();
  markCycleStaleness();
}

// ------------------------------------------------------------ 渲染输入 --

function render() {
  renderLayers();
  renderSamples();
  renderRelations();
  $("#addLayerBtn").disabled = state.layers.length >= MAX_LAYERS;
  $("#addSampleBtn").disabled = state.samples.length >= MAX_SAMPLES;
  $("#addRelationBtn").disabled = state.relations.length >= MAX_RELATIONS;
}

function renderLayers() {
  elLayers.innerHTML = "";
  const idCounts = {};
  state.layers.forEach((l) => {
    const k = l.id.trim();
    if (k) idCounts[k] = (idCounts[k] || 0) + 1;
  });
  const duplicateIds = new Set(
    Object.entries(idCounts).filter(([, n]) => n > 1).map(([k]) => k)
  );
  state.layers.forEach((layer, i) => {
    const validHex = normalizeHex(layer.color);
    const opNum = typeof layer.opacity === "number" ? layer.opacity : NaN;
    const opValid = Number.isFinite(opNum) && opNum >= 0 && opNum <= 1;
    const opValue = opValid ? opNum : "";
    const row = document.createElement("div");
    row.className = "layer-row";
    row.innerHTML = `
      <span class="row-index">${i + 1}</span>
      <input class="id-input ${layer.id && duplicateIds.has(layer.id) ? "invalid" : ""}"
             data-act="layer-id" data-i="${i}" type="text"
             value="${escapeHtml(layer.id)}" placeholder="ID" />
      <input type="color" data-act="layer-picker" data-i="${i}"
             value="${validHex || "#000000"}" title="选色" />
      <input class="hex-input ${validHex ? "" : "invalid"}" data-act="layer-hex" data-i="${i}"
             type="text" value="${escapeHtml(layer.color)}" placeholder="#RRGGBB" />
      <input class="opacity-range" data-act="layer-opacity-range" data-i="${i}"
             type="range" min="0" max="1" step="0.01" value="${opValid ? opNum : 1}" />
      <input class="opacity-input ${opValid ? "" : "invalid"}" data-act="layer-opacity"
             data-i="${i}" type="number" min="0" max="1" step="0.01"
             value="${opValue}" />
      <span class="opacity-val">${opValid ? Math.round(opNum * 100) + "%" : "—"}</span>
      <span class="spacer"></span>
      <button class="btn btn-ghost btn-small" data-act="remove-layer" data-i="${i}"
              type="button" ${state.layers.length <= MIN_LAYERS ? "disabled" : ""}>删除</button>
    `;
    elLayers.appendChild(row);
  });
}

function renderSamples() {
  elSamples.innerHTML = "";
  state.samples.forEach((smp, i) => {
    const bg = normalizeHex(smp.background);
    const tg = normalizeHex(smp.target);
    const row = document.createElement("div");
    row.className = "sample-row";
    row.innerHTML = `
      <span class="row-index">${i + 1}</span>
      <span class="field-label">背景
        <input type="color" data-act="sample-bg-picker" data-i="${i}"
               value="${bg || "#000000"}" />
        <input class="hex-input" data-act="sample-bg" data-i="${i}" type="text"
               value="${escapeHtml(smp.background)}" placeholder="#RRGGBB" />
      </span>
      <span class="field-label">目标
        <input type="color" data-act="sample-target-picker" data-i="${i}"
               value="${tg || "#000000"}" />
        <input class="hex-input" data-act="sample-target" data-i="${i}" type="text"
               value="${escapeHtml(smp.target)}" placeholder="#RRGGBB" />
      </span>
      <span class="spacer"></span>
      <button class="btn btn-ghost btn-small" data-act="remove-sample" data-i="${i}"
              type="button" ${state.samples.length <= MIN_SAMPLES ? "disabled" : ""}>删除</button>
    `;
    elSamples.appendChild(row);
  });
}

function renderRelations() {
  elRelations.innerHTML = "";
  if (state.relations.length === 0) {
    const empty = document.createElement("div");
    empty.className = "result-empty";
    empty.textContent = "暂无约束（任意图层顺序均可参与择优）。";
    elRelations.appendChild(empty);
    return;
  }
  const options = state.layers
    .map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.id)}</option>`)
    .join("");
  state.relations.forEach((rel, i) => {
    const row = document.createElement("div");
    row.className = "relation-row";
    row.innerHTML = `
      <select data-act="rel-lower" data-i="${i}">
        ${optionWith(options, rel.lower)}
      </select>
      <span class="relation-arrow">在更下方 ▲ 叠在</span>
      <select data-act="rel-upper" data-i="${i}">
        ${optionWith(options, rel.upper)}
      </select>
      <span class="relation-arrow">之上</span>
      <span class="spacer"></span>
      <button class="btn btn-ghost btn-small" data-act="remove-relation" data-i="${i}"
              type="button">删除</button>
    `;
    elRelations.appendChild(row);
  });
}

// select 选项无法靠内部标记 selected，重写一份带 selected 的
function optionWith(allOptions, selectedId) {
  if (!state.layers.some((l) => l.id === selectedId)) {
    return `<option value="" selected>（请选择）</option>${allOptions}`;
  }
  return state.layers
    .map(
      (l) =>
        `<option value="${escapeHtml(l.id)}"${l.id === selectedId ? " selected" : ""}>${escapeHtml(
          l.id
        )}</option>`
    )
    .join("");
}

// ------------------------------------------------------------ 事件代理 --

document.addEventListener("input", (e) => {
  const t = e.target;
  const act = t.dataset.act;
  if (!act) return;
  const i = Number(t.dataset.i);

  switch (act) {
    case "layer-id":
      state.layers[i].id = t.value;
      renderRelationsKeepFocus(t);
      scheduleSolve();
      break;
    case "layer-hex":
      state.layers[i].color = t.value;
      syncPicker(t, "layer-picker", i, t.value);
      t.classList.toggle("invalid", normalizeHex(t.value) === null);
      scheduleSolve();
      break;
    case "layer-picker":
      state.layers[i].color = t.value.toLowerCase();
      syncTextInput("layer-hex", i, t.value.toLowerCase());
      scheduleSolve();
      break;
    case "layer-opacity": {
      const v = parseFloat(t.value);
      state.layers[i].opacity = Number.isNaN(v) ? t.value : v;
      if (typeof state.layers[i].opacity === "number" &&
          state.layers[i].opacity >= 0 && state.layers[i].opacity <= 1) {
        syncRange(i, state.layers[i].opacity);
      }
      scheduleSolve();
      break;
    }
    case "layer-opacity-range":
      state.layers[i].opacity = parseFloat(t.value);
      syncNumberInput(i, state.layers[i].opacity);
      scheduleSolve();
      break;
    case "sample-bg":
    case "sample-target": {
      const key = act === "sample-bg" ? "background" : "target";
      state.samples[i][key] = t.value;
      syncPicker(t, act + "-picker", i, t.value);
      t.classList.toggle("invalid", normalizeHex(t.value) === null);
      scheduleSolve();
      break;
    }
    case "sample-bg-picker":
      state.samples[i].background = t.value.toLowerCase();
      syncTextInput("sample-bg", i, t.value.toLowerCase());
      scheduleSolve();
      break;
    case "sample-target-picker":
      state.samples[i].target = t.value.toLowerCase();
      syncTextInput("sample-target", i, t.value.toLowerCase());
      scheduleSolve();
      break;
    case "rel-lower":
      state.relations[i].lower = t.value;
      scheduleSolve();
      break;
    case "rel-upper":
      state.relations[i].upper = t.value;
      scheduleSolve();
      break;
    case "suggest-hex":
      suggestState.candidates[i] = t.value;
      syncPicker(t, "suggest-picker", i, t.value);
      refreshSuggestCandValidity();
      markSuggestStaleness();
      renderReviewBgOptions();
      markReviewStaleness();
      break;
    case "suggest-picker":
      suggestState.candidates[i] = t.value.toLowerCase();
      syncTextInput("suggest-hex", i, t.value.toLowerCase());
      refreshSuggestCandValidity();
      markSuggestStaleness();
      renderReviewBgOptions();
      markReviewStaleness();
      break;
    case "suggest-tolerance": {
      const v = parseFloat(t.value);
      suggestState.tolerance = Number.isNaN(v) ? t.value : v;
      markSuggestStaleness();
      markReviewStaleness();
      break;
    }
    case "review-color":
      reviewState.measuredColor = t.value;
      {
        const hx = normalizeHex(t.value);
        if (hx) $("#reviewPicker").value = hx;
      }
      t.classList.toggle("invalid", normalizeHex(t.value) === null);
      markReviewStaleness();
      break;
    case "review-picker":
      reviewState.measuredColor = t.value.toLowerCase();
      {
        const colorInput = $("#reviewColor");
        colorInput.value = t.value.toLowerCase();
        colorInput.classList.remove("invalid");
      }
      markReviewStaleness();
      break;
    case "review-limit": {
      const v = parseFloat(t.value);
      reviewState.measurementLimit = Number.isNaN(v) ? t.value : v;
      markReviewStaleness();
      break;
    }
    case "transition-limit": {
      const v = parseFloat(t.value);
      transitionState.limit = t.value.trim() === "" || Number.isNaN(v) ? null : v;
      markTransitionStaleness();
      break;
    }
  }
});

function syncPicker(textEl, pickerAct, i, raw) {
  const hx = normalizeHex(raw);
  const picker = document.querySelector(`input[data-act="${pickerAct}"][data-i="${i}"]`);
  if (picker && hx) picker.value = hx;
}
function syncTextInput(act, i, value) {
  const el = document.querySelector(`input[data-act="${act}"][data-i="${i}"]`);
  if (el && el.value !== value) {
    el.value = value;
    el.classList.remove("invalid");
  }
}
function syncRange(i, value) {
  const el = document.querySelector(`input[data-act="layer-opacity-range"][data-i="${i}"]`);
  if (el) el.value = value;
  const val = document.querySelectorAll(".layer-row")[i]?.querySelector(".opacity-val");
  if (val) val.textContent = Math.round(value * 100) + "%";
}
function syncNumberInput(i, value) {
  const el = document.querySelector(`input[data-act="layer-opacity"][data-i="${i}"]`);
  if (el && parseFloat(el.value) !== value) el.value = value;
  const val = document.querySelectorAll(".layer-row")[i]?.querySelector(".opacity-val");
  if (val) val.textContent = Math.round(value * 100) + "%";
}

// ID 文本框输入时只重建关系下拉，避免打断图层区输入焦点
function renderRelationsKeepFocus(activeEl) {
  const activeStart = activeEl.selectionStart;
  const activeEnd = activeEl.selectionEnd;
  renderRelations();
  activeEl.focus();
  try {
    activeEl.setSelectionRange(activeStart, activeEnd);
  } catch (_) { /* ignore */ }
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const i = Number(btn.dataset.i);

  if (act === "add-layer" && state.layers.length < MAX_LAYERS) {
    state.layers.push({ id: uniqueId("L"), color: "#808080", opacity: 0.5 });
    render();
    scheduleSolve(0);
  } else if (act === "remove-layer" && state.layers.length > MIN_LAYERS) {
    const removed = state.layers[i].id.trim();
    state.layers.splice(i, 1);
    state.relations = state.relations.filter(
      (r) => r.lower.trim() !== removed && r.upper.trim() !== removed
    );
    render();
    scheduleSolve(0);
  } else if (act === "add-sample" && state.samples.length < MAX_SAMPLES) {
    state.samples.push({ background: "#ffffff", target: "#ffffff" });
    render();
    markTransitionStaleness();
    scheduleSolve(0);
  } else if (act === "remove-sample" && state.samples.length > MIN_SAMPLES) {
    state.samples.splice(i, 1);
    render();
    markTransitionStaleness();
    scheduleSolve(0);
  } else if (act === "add-relation" && state.relations.length < MAX_RELATIONS) {
    const first = state.layers[0]?.id || "";
    const second = state.layers[1]?.id || first;
    state.relations.push({ lower: first, upper: second });
    render();
    scheduleSolve(0);
  } else if (act === "remove-relation") {
    state.relations.splice(i, 1);
    render();
    scheduleSolve(0);
  } else if (act === "suggest-add" && suggestState.candidates.length < MAX_CANDIDATES) {
    suggestState.candidates.push("#808080");
    renderSuggestControls();
    markSuggestStaleness();
    renderReviewBgOptions();
    markReviewStaleness();
  } else if (act === "suggest-remove" && suggestState.candidates.length > MIN_CANDIDATES) {
    suggestState.candidates.splice(i, 1);
    renderSuggestControls();
    markSuggestStaleness();
    renderReviewBgOptions();
    markReviewStaleness();
  }
});

let idCounter = 0;
function uniqueId(prefix) {
  let candidate;
  do {
    idCounter += 1;
    candidate = `${prefix}${idCounter}`;
  } while (state.layers.some((l) => l.id === candidate));
  return candidate;
}

// ------------------------------------------------------------ 调用后端 --

function buildSolvePayload() {
  return {
    layers: state.layers.map((l) => ({
      id: l.id,
      color: l.color,
      opacity: l.opacity,
    })),
    samples: state.samples.map((s) => ({
      background: s.background,
      target: s.target,
    })),
    relations: state.relations.map((r) => ({ lower: r.lower, upper: r.upper })),
  };
}

async function runSolve() {
  // 成环确认请求在途时跳过自动求解：确认成功后会用删除关系后的输入触发求解；
  // 确认被作废 / 失败后，用户的下一次输入会重新走「求解 → 方案」流程，避免
  // 「在途确认尚未落地、自动求解先用旧关系渲染」造成的短暂不一致。
  if (cycleState.confirmReqId !== 0) return;
  const payload = buildSolvePayload();

  const token = ++inflightToken;
  elStatus.textContent = "计算中…";
  elStatus.className = "status busy";

  try {
    const resp = await fetch("/api/solve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (token !== inflightToken) return; // 已有更新的请求，丢弃旧结果
    const data = await resp.json();
    if (!resp.ok) {
      const errors = data.errors || [{ scope: "form", message: "求解失败" }];
      showErrors(errors);
      // 是否成环、以及待确认解除方案，都以 /api/resolve-cycle 的判定为准；
      // 其他非法输入（无环 / 混有别的错误）时该伴随请求不会展示方案卡片。
      void runCyclePlan(payload, { silentOnError: true });
    } else {
      showErrors([]);
      lastSolveResult = data;
      clearCyclePlan();
      renderResult(data);
    }
  } catch (err) {
    if (token !== inflightToken) return;
    showErrors([{ scope: "form", message: "无法连接计算服务：" + err.message }]);
  }
}

function showErrors(errors) {
  const key = JSON.stringify(errors);
  if (key === lastErrorKey) {
    // 内容不变时只更新状态文字，不重绘
    if (errors.length) {
      elStatus.textContent = "存在输入错误";
      elStatus.className = "status";
    }
    return;
  }
  lastErrorKey = key;

  if (!errors.length) {
    elErrorBanner.hidden = true;
    elErrorList.innerHTML = "";
    return;
  }
  elErrorList.innerHTML = errors
    .map((er) => `<li>${escapeHtml(er.message)}</li>`)
    .join("");
  elErrorBanner.hidden = false;
  elStatus.textContent = "存在输入错误";
  elStatus.className = "status";
  elResultBody.innerHTML = `<div class="result-empty">修正输入后将自动重新计算。</div>`;
  $("#inferCard").hidden = true;
}

// ------------------------------------------------------------ 结果渲染 --

function renderResult(r) {
  elStatus.textContent = "";
  elStatus.className = "status";

  const chips = r.order
    .map((id, k) => {
      const layer = r.layers[k];
      const rgba = hexToRgba(layer.color, layer.opacity);
      return `
        <span class="chip">
          <span class="dot" style="background:${rgba}" title="${escapeHtml(id)}"></span>
          <span class="cid">${escapeHtml(id)}</span>
          <span class="cop">α=${Number(layer.opacity.toFixed(2))}</span>
        </span>`;
    })
    .join('<span class="order-sep">↑</span>');

  const body = `
    <div class="order-panel">
      <div class="order-title">最优叠放顺序（底 → 顶）</div>
      <div class="checker">
        <div class="order-chips">
          <span class="order-ends">底</span>
          ${chips}
          <span class="order-ends">↑ 顶</span>
        </div>
      </div>
      <div class="metric-row">
        <span>总平方误差（未取整 0–255 通道）：<b>${fmtSse(r.totalSse)}</b></span>
        <span>枚举排列：<b>${r.permutationsChecked}</b> 个</span>
        <span>满足约束：<b>${r.feasibleCount}</b> 个</span>
        <span>同分时按 ID 字典序决胜</span>
      </div>
    </div>
    ${r.samples.map(renderSample).join("")}
  `;
  elResultBody.innerHTML = body;
  $("#suggestCard").hidden = false;
  $("#reviewCard").hidden = false;
  renderReviewBgOptions();
  syncInferPanel(r);
  syncTransitionPanel(r);
}

function renderSample(s) {
  const targetRgb = s.targetRgb.map((v) => Math.round(v)).join(", ");
  const predRgb = s.predictedRgb.map((v) => Math.round(v)).join(", ");
  const [cr, cg, cb] = s.channelSse;
  const rating =
    s.sse < 1 ? "r-good" : s.sse < 100 ? "r-mid" : "r-bad";
  return `
    <div class="sample-result">
      <div class="sample-result-head">
        <span>样本 ${s.index + 1}</span>
        <span class="${rating}">SSE = ${fmtSse(s.sse)}</span>
      </div>
      <div class="compare">
        <div class="swatch-box">
          <span class="swatch-big" style="background:${s.target}"></span>
          <span class="swatch-meta">
            <div class="name">目标色</div>
            <div class="hexval">${s.target}</div>
            <div class="name">rgb(${targetRgb})</div>
          </span>
        </div>
        <div class="compare-arrow">→</div>
        <div class="swatch-box">
          <span class="swatch-big" style="background:${s.predictedHex}"></span>
          <span class="swatch-meta">
            <div class="name">预测色</div>
            <div class="hexval">${s.predictedHex}</div>
            <div class="name">rgb(${predRgb})</div>
          </span>
        </div>
      </div>
      <div class="bg-note">
        <span class="mini" style="background:${s.background}"></span>
        在背景 ${s.background} 上叠放
      </div>
      <div class="sse-line">
        <span class="sse-chan">R²误差 ${fmtSse(cr)}</span>
        <span class="sse-chan">G²误差 ${fmtSse(cg)}</span>
        <span class="sse-chan">B²误差 ${fmtSse(cb)}</span>
      </div>
    </div>
  `;
}

function hexToRgba(hex, alpha) {
  const h = normalizeHex(hex) || "#000000";
  const r = parseInt(h.slice(1, 3), 16);
  const g = parseInt(h.slice(3, 5), 16);
  const b = parseInt(h.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function fmtSse(v) {
  if (v === 0) return "0";
  if (v < 0.001) return v.toExponential(3);
  return Number(v.toFixed(4)).toString();
}

// 网格值（0.01 整数倍）显示为两位小数；原始参数组入选时保留必要精度
function fmtOpacity(v) {
  if (Math.abs(v - Math.round(v * 100) / 100) < 1e-9) return Number(v.toFixed(2)).toString();
  return String(v);
}

// ============================================================ 不透明度反推 ==

const inferState = {
  order: [],          // 当前确认顺序（ID 数组）
  picks: new Set(),   // 勾选的待调 ID
  result: null,       // 最近一次成功返回
  resultKey: "",      // 结果产生时的输入指纹
  appliedSig: "",     // 上一次点「应用」之后的输入指纹（与当前一致则结果仍代表现状）
  applied: false,     // 当前结果是否已写回图层
};

let orderSlotBefore = "";

const elInferCard = $("#inferCard");
const elInferOrder = $("#inferOrder");
const elInferPick = $("#inferPick");
const elInferHint = $("#inferHint");
const elInferErrors = $("#inferErrors");
const elInferResult = $("#inferResult");
const elInferStatus = $("#inferStatus");

function inferSignature() {
  // 用于判断已有反推结果是否对应当前输入
  return JSON.stringify({
    layers: state.layers,
    samples: state.samples,
    relations: state.relations,
    order: inferState.order,
    picks: [...inferState.picks].sort(),
  });
}

function syncInferPanel(solveResult) {
  elInferCard.hidden = false;
  const idSig = state.layers.map((l) => l.id).join("");
  const layerSet = new Set(state.layers.map((l) => l.id));

  if (inferState._idSig !== idSig) {
    // 图层集合（ID 列表）变化：重建顺序与勾选，默认采用求解顺序
    inferState._idSig = idSig;
    inferState.order = [...solveResult.order];
    inferState.picks = new Set();
    inferState.result = null;
    inferState.resultKey = "";
    inferState.appliedSig = "";
    inferState.applied = false;
    elInferResult.innerHTML = "";
    elInferErrors.hidden = true;
  } else {
    // 集合未变：把求解新出现、但当前顺序未包含的 ID 补齐（防御性）
    inferState.order = inferState.order.filter((id) => layerSet.has(id));
    solveResult.order.forEach((id) => {
      if (!inferState.order.includes(id)) inferState.order.push(id);
    });
    inferState.picks = new Set([...inferState.picks].filter((id) => layerSet.has(id)));
  }
  renderInferControls();
  markInferStaleness();
}

function layerById(id) {
  return state.layers.find((l) => l.id === id);
}

function renderInferControls() {
  // ---- 顺序槽 ----
  elInferOrder.innerHTML = "";
  inferState.order.forEach((id, pos) => {
    const layer = layerById(id);
    const hex = (layer && normalizeHex(layer.color)) || "#000000";
    const op = layer && Number.isFinite(layer.opacity) ? layer.opacity : null;
    const slot = document.createElement("span");
    slot.className = "order-slot";
    slot.innerHTML = `
      <select data-act="infer-order" data-pos="${pos}" title="该位置（底 → 顶第 ${pos + 1} 层）的图层">
        ${state.layers
          .map(
            (l) =>
              `<option value="${escapeHtml(l.id)}"${l.id === id ? " selected" : ""}>${escapeHtml(
                l.id
              )}</option>`
          )
          .join("")}
      </select>
      <span class="mini-dot" style="background:${hexToRgba(hex, op == null ? 1 : op)}"></span>
      <span class="mini-op">${op == null ? "α 非法" : "α=" + Number(op.toFixed(2))}</span>
    `;
    elInferOrder.appendChild(slot);
    if (pos < inferState.order.length - 1) {
      const ar = document.createElement("span");
      ar.className = "infer-arrow";
      ar.textContent = "↑";
      elInferOrder.appendChild(ar);
    }
  });

  // ---- 待调勾选 ----
  elInferPick.innerHTML = "";
  state.layers.forEach((l) => {
    const hex = normalizeHex(l.color) || "#000000";
    const checked = inferState.picks.has(l.id);
    const disabled = !checked && inferState.picks.size >= 2;
    const label = document.createElement("label");
    label.className = "pick-item" + (disabled ? " disabled" : "");
    label.innerHTML = `
      <input type="checkbox" data-act="infer-pick" data-id="${escapeHtml(l.id)}"
             ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} />
      <span class="pick-dot" style="background:${hexToRgba(hex, l.opacity)}"></span>
      <span>${escapeHtml(l.id)}</span>
    `;
    elInferPick.appendChild(label);
  });

  updateInferRunHint();
  markInferStaleness();
}

function updateInferRunHint() {
  const btn = $("#inferRunBtn");
  const n = inferState.picks.size;
  btn.disabled = n < 1 || n > 2;
  elInferHint.textContent =
    n === 0 ? "请勾选 1～2 个待调图层" : `已选 ${n} 个，将在 0.00～1.00（步长 0.01）网格上联合反推`;
}

function markInferStaleness() {
  if (!inferState.result) return;
  const sig = inferSignature();
  // 结果产生时、或上次应用建议值之后的状态，都视为与当前结果一致
  const fresh = sig === inferState.resultKey || sig === inferState.appliedSig;
  inferState.applied = inferState.applied && fresh;
  const old = elInferResult.querySelector(".stale-note");
  if (!fresh && !old) {
    const note = document.createElement("div");
    note.className = "stale-note";
    note.textContent = "输入或选择已变化，以下结果可能过期，请重新反推。";
    elInferResult.prepend(note);
  } else if (fresh && old) {
    old.remove();
  }
}

// 结果是否仍代表当前输入；false 时「应用」按钮应可重新点击
function inferResultFresh() {
  if (!inferState.result) return false;
  const sig = inferSignature();
  return sig === inferState.resultKey || sig === inferState.appliedSig;
}

document.addEventListener("change", (e) => {
  const t = e.target;
  const act = t.dataset.act;
  if (act === "infer-order") {
    const pos = Number(t.dataset.pos);
    const prev = orderSlotBefore;
    // 与原占据新 ID 的槽位交换，保证顺序始终是全部图层的一个排列
    const other = inferState.order.findIndex((id, p) => p !== pos && id === t.value);
    inferState.order[pos] = t.value;
    if (other !== -1 && prev) inferState.order[other] = prev;
    renderInferControls();
  } else if (act === "transition-order") {
    const pos = Number(t.dataset.pos);
    const prev = orderSlotBefore;
    // 与原占据新 ID 的槽位交换，保证当前顺序始终是全部图层的一个排列
    const other = transitionState.order.findIndex((id, p) => p !== pos && id === t.value);
    transitionState.order[pos] = t.value;
    if (other !== -1 && prev) transitionState.order[other] = prev;
    renderTransitionControls(lastSolveResult);
    markTransitionStaleness();
  } else if (act === "infer-pick") {
    const id = t.dataset.id;
    if (t.checked) inferState.picks.add(id);
    else inferState.picks.delete(id);
    renderInferControls();
  } else if (act === "review-bg") {
    reviewState.selectedBackground = t.value;
    markReviewStaleness();
  }
});

// select change 前记录原值，供交换使用
document.addEventListener("focusin", (e) => {
  if (e.target.dataset && e.target.dataset.act === "infer-order") {
    const pos = Number(e.target.dataset.pos);
    orderSlotBefore = inferState.order[pos];
  }
  if (e.target.dataset && e.target.dataset.act === "transition-order") {
    const pos = Number(e.target.dataset.pos);
    orderSlotBefore = transitionState.order[pos];
  }
});

document.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  if (btn.dataset.act === "infer-run") runInfer();
  if (btn.dataset.act === "infer-apply") applyInferResult();
  if (btn.dataset.act === "suggest-run") runSuggest();
  if (btn.dataset.act === "review-run") runReview();
  if (btn.dataset.act === "review-append") appendReviewSample();
  if (btn.dataset.act === "transition-run") runTransition();
  if (btn.dataset.act === "transition-reset") resetTransitionOrder();
  if (btn.dataset.act === "cycle-confirm") confirmCyclePlan();
});

async function runInfer() {
  const payload = {
    layers: state.layers.map((l) => ({ id: l.id, color: l.color, opacity: l.opacity })),
    samples: state.samples.map((s) => ({ background: s.background, target: s.target })),
    relations: state.relations.map((r) => ({ lower: r.lower, upper: r.upper })),
    order: inferState.order,
    adjustIds: [...inferState.picks].sort(),
  };
  elInferStatus.textContent = "反推中…";
  elInferStatus.className = "status busy";
  elInferErrors.hidden = true;

  try {
    const resp = await fetch("/api/infer-opacity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    elInferStatus.textContent = "";
    elInferStatus.className = "status";
    if (!resp.ok) {
      showInferErrors(data.errors || [{ scope: "form", message: "反推失败" }]);
      return;
    }
    inferState.result = data;
    inferState.resultKey = inferSignature();
    inferState.applied = false;
    renderInferResult(data);
  } catch (err) {
    elInferStatus.textContent = "";
    elInferStatus.className = "status";
    showInferErrors([{ scope: "form", message: "无法连接计算服务：" + err.message }]);
  }
}

function showInferErrors(errors) {
  elInferErrors.innerHTML =
    '<ul>' + errors.map((er) => `<li>${escapeHtml(er.message)}</li>`).join("") + "</ul>";
  elInferErrors.hidden = false;
}

function renderInferResult(r) {
  const delta = r.afterTotalSse - r.beforeTotalSse;
  const deltaCls = delta < -1e-9 ? "sse-delta-down" : delta > 1e-9 ? "sse-delta-up" : "";
  const deltaTxt =
    Math.abs(delta) < 1e-9 ? "持平" : `${delta > 0 ? "+" : "−"}${fmtSse(Math.abs(delta))}`;

  const rows = r.adjustments
    .map((a) => {
      const changed =
        Math.abs(a.originalOpacity - a.suggestedOpacity) > 1e-9;
      return `
        <tr>
          <td>${escapeHtml(a.id)}</td>
          <td class="num">${fmtOpacity(a.originalOpacity)}</td>
          <td class="op-arrow">→</td>
          <td class="num ${changed ? "op-new" : "op-same"}">
            ${fmtOpacity(a.suggestedOpacity)}${changed ? "" : "（原值即最优）"}
          </td>
        </tr>`;
    })
    .join("");

  const samples = r.afterSamples
    .map((s, k) => renderInferSample(s, r.beforeSamples[k]))
    .join("");

  const applied = inferResultFresh() && inferState.applied;
  elInferResult.innerHTML = `
    <table class="adj-table">
      <thead><tr><th>待调图层</th><th>原不透明度</th><th></th><th>建议不透明度</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="sse-compare">
      <span>调整前总误差：<b>${fmtSse(r.beforeTotalSse)}</b></span>
      <span class="after">调整后总误差：<b>${fmtSse(r.afterTotalSse)}</b></span>
      <span class="${deltaCls}">变化：<b>${deltaTxt}</b></span>
      <span>评估组合：<b>${r.combosChecked}</b> 组（含原始参数组）</span>
    </div>
    ${samples}
    <div class="infer-apply-row">
      <button class="btn btn-small" data-act="infer-apply" type="button"
              ${applied ? "disabled" : ""}>应用建议值回图层并重新求解</button>
      ${applied ? '<span class="applied-note">已应用，左侧图层与上方校准结果已更新。</span>' : ""}
    </div>
  `;
}

function renderInferSample(after, before) {
  return `
    <div class="sample-result">
      <div class="sample-result-head">
        <span>样本 ${after.index + 1}</span>
        <span class="hint">背景 ${after.background}</span>
      </div>
      <div class="tri-compare">
        ${triCell("目标色", after.target, after.targetRgb, null)}
        <span class="tri-arrow">→</span>
        ${triCell("调整前预测", before.predictedHex, before.predictedRgb, before.sse)}
        <span class="tri-arrow">→</span>
        ${triCell("调整后预测", after.predictedHex, after.predictedRgb, after.sse)}
      </div>
    </div>
  `;
}

function triCell(tag, hex, rgb, sse) {
  const rgbTxt = rgb.map((v) => Math.round(v)).join(", ");
  return `
    <div class="tri-cell">
      <div class="cell-tag">
        <span>${tag}</span>
        ${sse == null ? "" : `<span class="tag-sse">SSE ${fmtSse(sse)}</span>`}
      </div>
      <div class="tri-swatch">
        <span class="swatch-big" style="background:${hex}"></span>
        <span>
          <div class="hexval">${hex}</div>
          <div class="name">rgb(${rgbTxt})</div>
        </span>
      </div>
    </div>
  `;
}

function applyInferResult() {
  const r = inferState.result;
  if (!r) return;
  r.adjustments.forEach((a) => {
    const layer = state.layers.find((l) => l.id === a.id);
    if (layer) layer.opacity = a.suggestedOpacity;
  });
  // 记录应用后的状态指纹：在再次改动输入前，结果始终代表当前图层
  inferState.applied = true;
  inferState.appliedSig = inferSignature();
  renderInferResult(inferState.result);
  render();
  markTransitionStaleness();
  runSolve();
}

// ============================================================ 过渡步骤规划 ==

const transitionState = {
  order: [],        // 当前实际底→顶顺序（ID 数组）
  limit: null,      // 过渡总误差上限（null 表示沿用最近一次求解的总误差）
  result: null,     // 最近一次成功返回
  resultKey: "",    // 结果产生时的输入指纹
  _idSig: "",
  _bestSse: null,   // 最近一次求解的最优总误差（用于默认上限与提示）
  inflightId: 0,        // 当前仍可落地的在途请求序号；0 表示无（已完成 / 被更新请求取代 / 因输入变化作废）
  inflightSig: "",      // 当前在途请求发出时的输入指纹
  reqSeq: 0,            // 单调递增的请求序号源，永不归零，避免请求序号在完成后被新请求复用
};

const elTransitionOrder = $("#transitionOrder");
const elTransitionTarget = $("#transitionTarget");
const elTransitionResult = $("#transitionResult");
const elTransitionErrors = $("#transitionErrors");
const elTransitionStatus = $("#transitionStatus");
const elTransitionLimit = $("#transitionLimit");
const elTransitionLimitHint = $("#transitionLimitHint");

function transitionSignature() {
  // 用于判断已有过渡步骤是否对应当前输入
  return JSON.stringify({
    layers: state.layers,
    samples: state.samples,
    relations: state.relations,
    currentOrder: transitionState.order,
    transitionLimit: transitionState.limit == null ? null : transitionState.limit,
  });
}

function effectiveTransitionLimit() {
  return transitionState.limit == null ? transitionState._bestSse : transitionState.limit;
}

function syncTransitionPanel(solveResult) {
  $("#transitionCard").hidden = false;
  const idSig = state.layers.map((l) => l.id).join("");
  const layerSet = new Set(state.layers.map((l) => l.id));

  transitionState._bestSse = solveResult.totalSse;
  if (transitionState._idSig !== idSig) {
    // 图层集合变化：当前顺序重置为最新最优叠序，上限默认取当前最优总误差
    transitionState._idSig = idSig;
    transitionState.order = [...solveResult.order];
    transitionState.limit = null;
    transitionState.result = null;
    transitionState.resultKey = "";
    elTransitionResult.innerHTML = "";
    elTransitionErrors.hidden = true;
  } else {
    // 集合未变：补齐 / 剔除，保持当前实际顺序始终是全部图层的一个排列
    transitionState.order = transitionState.order.filter((id) => layerSet.has(id));
    solveResult.order.forEach((id) => {
      if (!transitionState.order.includes(id)) transitionState.order.push(id);
    });
  }
  renderTransitionControls(solveResult);
  markTransitionStaleness();
}

function renderOrderSlots(container, ids) {
  container.innerHTML = "";
  ids.forEach((id, pos) => {
    const layer = layerById(id);
    const hex = (layer && normalizeHex(layer.color)) || "#000000";
    const op = layer && Number.isFinite(layer.opacity) ? layer.opacity : null;
    const slot = document.createElement("span");
    slot.className = "order-slot";
    slot.innerHTML = `
      <span class="mini-dot" style="background:${hexToRgba(hex, op == null ? 1 : op)}"></span>
      <span class="slot-id">${escapeHtml(id)}</span>
      <span class="mini-op">${op == null ? "α 非法" : "α=" + Number(op.toFixed(2))}</span>
    `;
    container.appendChild(slot);
    if (pos < ids.length - 1) {
      const ar = document.createElement("span");
      ar.className = "infer-arrow";
      ar.textContent = "↑";
      container.appendChild(ar);
    }
  });
}

function renderTransitionControls(solveResult) {
  // ---- 当前顺序：可改的下拉槽 ----
  elTransitionOrder.innerHTML = "";
  transitionState.order.forEach((id, pos) => {
    const layer = layerById(id);
    const hex = (layer && normalizeHex(layer.color)) || "#000000";
    const op = layer && Number.isFinite(layer.opacity) ? layer.opacity : null;
    const slot = document.createElement("span");
    slot.className = "order-slot";
    slot.innerHTML = `
      <select data-act="transition-order" data-pos="${pos}"
              title="该位置（底 → 顶第 ${pos + 1} 层）的图层；改动会与原占该 ID 的槽位交换">
        ${state.layers
          .map(
            (l) =>
              `<option value="${escapeHtml(l.id)}"${l.id === id ? " selected" : ""}>${escapeHtml(
                l.id
              )}</option>`
          )
          .join("")}
      </select>
      <span class="mini-dot" style="background:${hexToRgba(hex, op == null ? 1 : op)}"></span>
      <span class="mini-op">${op == null ? "α 非法" : "α=" + Number(op.toFixed(2))}</span>
    `;
    elTransitionOrder.appendChild(slot);
    if (pos < transitionState.order.length - 1) {
      const ar = document.createElement("span");
      ar.className = "infer-arrow";
      ar.textContent = "↑";
      elTransitionOrder.appendChild(ar);
    }
  });

  // ---- 目标顺序：只读展示 ----
  renderOrderSlots(elTransitionTarget, solveResult.order);

  // ---- 上限输入：空白时默认取最优总误差 ----
  if (transitionState.limit == null && document.activeElement !== elTransitionLimit) {
    elTransitionLimit.value = solveResult.totalSse == null ? "" : String(solveResult.totalSse);
  }
  elTransitionLimitHint.textContent =
    `留空默认取最优总误差 ${fmtSse(solveResult.totalSse)}；当前实际叠序的旧样本总误差也必须不超过该上限`;

  markTransitionStaleness();
}

function resetTransitionOrder() {
  const r = lastSolveResult;
  if (!r) return;
  transitionState.order = [...r.order];
  transitionState.limit = null;
  renderTransitionControls(r);
}

function markTransitionStaleness() {
  // 输入指纹变化时：在途请求（及其响应）立即失效，不能再改动结果 / 错误 / 加载状态。
  // 这里仅结束加载态并作废在途请求；旧响应返回后会在响应守卫处被丢弃。
  // 注意 reqSeq 不清零，请求序号始终单调递增，旧序号不会被后续请求复用。
  if (transitionState.inflightId !== 0 &&
      transitionSignature() !== transitionState.inflightSig) {
    transitionState.inflightId = 0;
    transitionState.inflightSig = "";
    elTransitionStatus.textContent = "";
    elTransitionStatus.className = "status";
  }
  if (!transitionState.result) return;
  const fresh = transitionSignature() === transitionState.resultKey;
  const old = elTransitionResult.querySelector(".stale-note");
  if (!fresh && !old) {
    const note = document.createElement("div");
    note.className = "stale-note";
    note.textContent = "参与规划的输入已变化，以下交换步骤已失效，请重新规划。";
    elTransitionResult.prepend(note);
  } else if (fresh && old) {
    old.remove();
  }
}

function transitionResultFresh() {
  if (!transitionState.result) return false;
  return transitionSignature() === transitionState.resultKey;
}

// 响应守卫：只有「当前在途请求」且「发出后参与输入未再变化」的响应可以落地。
// 请求序号取自永不归零的单调计数器，因此某请求完成（成功 / HTTP 错误 / 连接异常）
// 不会释放其序号：输入不变时连续规划，较早请求即便后返回也无法冒充成新请求，
// 其三种结局都只会被直接忽略，不触碰当前步骤、错误提示或加载状态。
function transitionResponseCurrent(reqId, reqSig) {
  return (
    transitionState.inflightId === reqId &&
    transitionState.inflightSig === reqSig &&
    transitionSignature() === reqSig
  );
}

async function runTransition() {
  const limit = effectiveTransitionLimit();
  const payload = {
    layers: state.layers.map((l) => ({ id: l.id, color: l.color, opacity: l.opacity })),
    samples: state.samples.map((s) => ({ background: s.background, target: s.target })),
    relations: state.relations.map((r) => ({ lower: r.lower, upper: r.upper })),
    currentOrder: transitionState.order,
    transitionLimit: limit,
  };
  // 从永不归零的单调计数器取得本次请求序号，并登记为当前在途请求；
  // 连续规划或输入变化时，旧请求即便后返回也不会覆盖较新结果（见 transitionResponseCurrent）。
  const reqId = ++transitionState.reqSeq;
  transitionState.inflightId = reqId;
  const reqSig = transitionSignature();
  transitionState.inflightSig = reqSig;

  elTransitionStatus.textContent = "规划中…";
  elTransitionStatus.className = "status busy";
  elTransitionErrors.hidden = true;

  try {
    const resp = await fetch("/api/plan-transition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!transitionResponseCurrent(reqId, reqSig)) return;
    transitionState.inflightId = 0;
    transitionState.inflightSig = "";
    elTransitionStatus.textContent = "";
    elTransitionStatus.className = "status";
    if (!resp.ok) {
      showTransitionErrors(data.errors || [{ scope: "form", message: "规划失败" }]);
      return;
    }
    transitionState.result = data;
    transitionState.resultKey = reqSig;
    renderTransitionResult(data);
  } catch (err) {
    if (!transitionResponseCurrent(reqId, reqSig)) return;
    transitionState.inflightId = 0;
    transitionState.inflightSig = "";
    elTransitionStatus.textContent = "";
    elTransitionStatus.className = "status";
    showTransitionErrors([{ scope: "form", message: "无法连接计算服务：" + err.message }]);
  }
}

function showTransitionErrors(errors) {
  elTransitionErrors.innerHTML =
    "<ul>" + errors.map((er) => `<li>${escapeHtml(er.message)}</li>`).join("") + "</ul>";
  elTransitionErrors.hidden = false;
}

function renderTransitionResult(r) {
  elTransitionErrors.hidden = true;
  let html = `
    <div class="metric-row">
      <span>当前总误差：<b>${fmtSse(r.currentTotalSse)}</b></span>
      <span>目标总误差：<b>${fmtSse(r.targetTotalSse)}</b></span>
      <span>过渡总误差上限：<b>${fmtSse(r.transitionLimit)}</b></span>
      <span>合规叠序：<b>${r.feasibleCount}</b> 条</span>
      <span>上限内可停留：<b>${r.allowedCount}</b> 条</span>
    </div>
  `;

  if (r.alreadyTarget) {
    html += `
      <div class="suggest-none">当前实际叠序就是目标最优叠序，无需交换（0 步）。</div>`;
    elTransitionResult.innerHTML = html;
    return;
  }

  if (!r.reachable) {
    html += `
      <div class="review-incompat">目标叠序不可到达：${escapeHtml(r.message)}</div>`;
    elTransitionResult.innerHTML = html;
    return;
  }

  html += `
    <div class="suggest-sec-title">
      最少交换 <b>${r.stepCount}</b> 步
      （并列时按每步交换前「下方 ID, 上方 ID」对的字典序决胜；访问状态 ${r.statesVisited} 个）
    </div>`;

  // 起点（第 0 步）
  html += `<div class="transition-steps">`;
  html += renderTransitionStateBlock("起点", null, r.currentOrder, r.currentTotalSse, r.currentSamples);

  r.steps.forEach((st) => {
    html += renderTransitionStateBlock(
      `第 ${st.step} 步`,
      st,
      st.order,
      st.totalSse,
      st.samples
    );
  });
  html += `</div>`;
  elTransitionResult.innerHTML = html;
}

function renderTransitionStateBlock(tag, step, order, totalSse, samples) {
  const chips = order
    .map((id) => {
      const layer = layerById(id);
      const hex = (layer && normalizeHex(layer.color)) || "#000000";
      const op = layer && Number.isFinite(layer.opacity) ? layer.opacity : 1;
      const swapped =
        step && (id === step.swappedLowerId || id === step.swappedUpperId) ? " swapped" : "";
      return `
        <span class="chip${swapped}">
          <span class="dot" style="background:${hexToRgba(hex, op)}" title="${escapeHtml(id)}"></span>
          <span class="cid">${escapeHtml(id)}</span>
        </span>`;
    })
    .join('<span class="order-sep">↑</span>');

  let head;
  if (step) {
    head = `
      <div class="trans-step-head">
        <span class="trans-step-tag">${tag}</span>
        <span>交换相邻两层
          <b class="hexval">${escapeHtml(step.swappedLowerId)}</b>
          <span class="hint">（下）⇅</span>
          <b class="hexval">${escapeHtml(step.swappedUpperId)}</b>
          <span class="hint">（上）</span>
        </span>
        <span class="spacer"></span>
        <span class="review-meas">总误差 <b>${fmtSse(totalSse)}</b></span>
      </div>`;
  } else {
    head = `
      <div class="trans-step-head">
        <span class="trans-step-tag start">${tag}</span>
        <span class="hint">调整前叠序</span>
        <span class="spacer"></span>
        <span class="review-meas">总误差 <b>${fmtSse(totalSse)}</b></span>
      </div>`;
  }

  const sampleHtml = samples.map(renderSample).join("");
  return `
    <div class="trans-step">
      ${head}
      <div class="checker"><div class="order-chips">
        <span class="order-ends">底</span>${chips}<span class="order-ends">↑ 顶</span>
      </div></div>
      ${sampleHtml}
    </div>`;
}

// ====================================================== 下一次背景测量建议 ==

const suggestState = {
  candidates: ["#ffffff", "#000000"], // 候选背景 HEX（按录入原样保存，提交时由后端规范化校验）
  tolerance: 0,                       // 误差容差（非负有限数字；非法输入保留原样交后端报错）
  result: null,                       // 最近一次成功返回
  resultKey: "",                      // 结果产生时的输入指纹
};

const elSuggestResult = $("#suggestResult");
const elSuggestErrors = $("#suggestErrors");
const elSuggestStatus = $("#suggestStatus");

function suggestSignature() {
  // 用于判断已有建议是否对应当前输入
  return JSON.stringify({
    layers: state.layers,
    samples: state.samples,
    relations: state.relations,
    candidates: suggestState.candidates,
    tolerance: suggestState.tolerance,
  });
}

function renderSuggestControls() {
  const box = $("#suggestCands");
  box.innerHTML = "";
  suggestState.candidates.forEach((cand, i) => {
    const hx = normalizeHex(cand);
    const row = document.createElement("div");
    row.className = "sample-row";
    row.innerHTML = `
      <span class="row-index">${i + 1}</span>
      <input type="color" data-act="suggest-picker" data-i="${i}"
             value="${hx || "#000000"}" title="选色" />
      <input class="hex-input" data-act="suggest-hex" data-i="${i}" type="text"
             value="${escapeHtml(cand)}" placeholder="#RRGGBB" />
      <span class="spacer"></span>
      <button class="btn btn-ghost btn-small" data-act="suggest-remove" data-i="${i}"
              type="button" ${suggestState.candidates.length <= MIN_CANDIDATES ? "disabled" : ""}>删除</button>
    `;
    box.appendChild(row);
  });
  $("#addSuggestCandBtn").disabled = suggestState.candidates.length >= MAX_CANDIDATES;
  refreshSuggestCandValidity();
}

// 不重绘行、就地切换非法/重复标记，避免打断输入焦点
function refreshSuggestCandValidity() {
  const inputs = [...document.querySelectorAll('input[data-act="suggest-hex"]')];
  const norms = inputs.map((el) => normalizeHex(el.value));
  const counts = {};
  norms.forEach((hx) => {
    if (hx) counts[hx] = (counts[hx] || 0) + 1;
  });
  inputs.forEach((el, k) => {
    const hx = norms[k];
    el.classList.toggle("invalid", !hx || counts[hx] > 1);
    el.title = hx && counts[hx] > 1 ? "候选背景规范化后重复" : "";
  });
}

function markSuggestStaleness() {
  if (!suggestState.result) return;
  const fresh = suggestSignature() === suggestState.resultKey;
  const old = elSuggestResult.querySelector(".stale-note");
  if (!fresh && !old) {
    const note = document.createElement("div");
    note.className = "stale-note";
    note.textContent = "输入已变化，以下建议可能过期，请重新计算。";
    elSuggestResult.prepend(note);
  } else if (fresh && old) {
    old.remove();
  }
}

async function runSuggest() {
  const payload = {
    layers: state.layers.map((l) => ({ id: l.id, color: l.color, opacity: l.opacity })),
    samples: state.samples.map((s) => ({ background: s.background, target: s.target })),
    relations: state.relations.map((r) => ({ lower: r.lower, upper: r.upper })),
    candidateBackgrounds: [...suggestState.candidates],
    tolerance: suggestState.tolerance,
  };
  elSuggestStatus.textContent = "计算中…";
  elSuggestStatus.className = "status busy";
  elSuggestErrors.hidden = true;

  try {
    const resp = await fetch("/api/suggest-background", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    elSuggestStatus.textContent = "";
    elSuggestStatus.className = "status";
    if (!resp.ok) {
      showSuggestErrors(data.errors || [{ scope: "form", message: "建议计算失败" }]);
      return;
    }
    suggestState.result = data;
    suggestState.resultKey = suggestSignature();
    renderSuggestResult(data);
  } catch (err) {
    elSuggestStatus.textContent = "";
    elSuggestStatus.className = "status";
    showSuggestErrors([{ scope: "form", message: "无法连接计算服务：" + err.message }]);
  }
}

function showSuggestErrors(errors) {
  elSuggestErrors.innerHTML =
    "<ul>" + errors.map((er) => `<li>${escapeHtml(er.message)}</li>`).join("") + "</ul>";
  elSuggestErrors.hidden = false;
}

function renderSuggestResult(r) {
  const orderRows = r.orders
    .map(
      (o, k) => `
        <div class="suggest-order-row">
          <span class="row-index">${k + 1}</span>
          <span class="suggest-order-ids">${o.order.map(escapeHtml).join(" ↑ ")}</span>
          <span class="hint">总误差 ${fmtSse(o.totalSse)}</span>
        </div>`
    )
    .join("");

  let html = `
    <div class="metric-row">
      <span>最优总误差：<b>${fmtSse(r.bestSse)}</b></span>
      <span>容差：<b>${fmtSse(r.tolerance)}</b></span>
      <span>符合容差的叠序总数：<b>${r.withinCount}</b>（可行共 ${r.feasibleCount} 条）</span>
      <span>按总误差、ID 序列排序，展示前 <b>${r.orders.length}</b> 条</span>
    </div>
    <div class="suggest-orders">${orderRows}</div>
  `;

  if (!r.needsMeasurement) {
    html += `
      <div class="suggest-none">容差内不足两条叠序，当前样本已能唯一区分叠放顺序，无需追加背景测量。</div>`;
    elSuggestResult.innerHTML = html;
    return;
  }

  const rec = r.recommended;
  const candRows = r.candidates
    .map((c) => {
      const isRec = rec && c.hex === rec.hex;
      return `
        <div class="suggest-cand-row ${isRec ? "rec" : ""}">
          <span class="mini" style="background:${c.hex}"></span>
          <span class="hexval">${c.hex}</span>
          <span class="suggest-score">最小平方距离得分 <b>${fmtSse(c.score)}</b></span>
          ${isRec ? '<span class="rec-badge">推荐</span>' : ""}
        </div>`;
    })
    .join("");

  html += `
    <div class="suggest-sec-title">各候选背景得分（任意两条预测色未取整 RGB 平方距离的最小值，越大越易区分）</div>
    <div class="suggest-cand-list">${candRows}</div>
    <div class="suggest-sec-title">
      推荐下一次测量背景
      <span class="mini" style="background:${rec.hex}"></span>
      <b class="hexval">${rec.hex}</b>
      ，其最难区分的一对叠序：
    </div>
    <div class="compare suggest-pair">
      ${suggestPairCell(rec.pair.a)}
      <div class="compare-arrow">⇄</div>
      ${suggestPairCell(rec.pair.b)}
    </div>
    <div class="hint suggest-pair-note">
      两者在 ${rec.hex} 上的未取整 RGB 平方距离为 ${fmtSse(rec.score)}；
      在该背景下补测一次，可最大程度拉开这对顺序的预测色差距。
    </div>
  `;
  elSuggestResult.innerHTML = html;
}

function suggestPairCell(side) {
  const rgbTxt = side.predictedRgb.map((v) => Math.round(v)).join(", ");
  return `
    <div class="swatch-box">
      <span class="swatch-big" style="background:${side.predictedHex}"></span>
      <span class="swatch-meta">
        <div class="name">${side.order.map(escapeHtml).join(" ↑ ")}</div>
        <div class="hexval">${side.predictedHex}</div>
        <div class="name">rgb(${rgbTxt})</div>
      </span>
    </div>`;
}

// ====================================================== 实测颜色复核 ==

const reviewState = {
  selectedBackground: "",   // 选定的候选背景规范化 HEX
  measuredColor: "#808080", // 实测目标色（按录入原样保存，提交时由后端校验）
  measurementLimit: 1,      // 新测量误差上限（非负有限；非法原样交后端报错）
  result: null,             // 最近一次成功返回
  resultKey: "",            // 结果产生时的输入指纹
};

const elReviewResult = $("#reviewResult");
const elReviewErrors = $("#reviewErrors");
const elReviewStatus = $("#reviewStatus");
const elReviewBgSelect = $("#reviewBgSelect");

function reviewSignature() {
  // 用于判断已有复核结果是否对应当前输入
  return JSON.stringify({
    layers: state.layers,
    samples: state.samples,
    relations: state.relations,
    candidates: suggestState.candidates,
    tolerance: suggestState.tolerance,
    selectedBackground: reviewState.selectedBackground,
    measuredColor: reviewState.measuredColor,
    measurementLimit: reviewState.measurementLimit,
  });
}

// 复核下拉只列候选背景中规范化后合法且不重复的 HEX
function validReviewCandidates() {
  const seen = new Set();
  const out = [];
  suggestState.candidates.forEach((raw) => {
    const hx = normalizeHex(raw);
    if (hx && !seen.has(hx)) {
      seen.add(hx);
      out.push(hx);
    }
  });
  return out;
}

function renderReviewBgOptions() {
  const options = validReviewCandidates();
  if (!options.includes(reviewState.selectedBackground)) {
    reviewState.selectedBackground = options[0] || "";
  }
  elReviewBgSelect.innerHTML = options.length
    ? options.map((hx) => `<option value="${hx}">${hx}</option>`).join("")
    : '<option value="">（候选背景均非法，请先修正上方候选）</option>';
  elReviewBgSelect.value = reviewState.selectedBackground;
}

function markReviewStaleness() {
  if (!reviewState.result) return;
  const fresh = reviewSignature() === reviewState.resultKey;
  const old = elReviewResult.querySelector(".stale-note");
  if (!fresh && !old) {
    const note = document.createElement("div");
    note.className = "stale-note";
    note.textContent = "参与复核的输入已变化，以下复核结果已失效，请重新复核（旧结果不能再用于追加样本）。";
    elReviewResult.prepend(note);
  } else if (fresh && old) {
    old.remove();
  }
  // 追加按钮的可用状态随失效状态同步
  const appendBtn = elReviewResult.querySelector('button[data-act="review-append"]');
  if (appendBtn) {
    const canAppend = fresh && reviewState.result.canAppendSample;
    appendBtn.disabled = !canAppend;
  }
}

function reviewResultFresh() {
  if (!reviewState.result) return false;
  return reviewSignature() === reviewState.resultKey;
}

async function runReview() {
  const payload = {
    layers: state.layers.map((l) => ({ id: l.id, color: l.color, opacity: l.opacity })),
    samples: state.samples.map((s) => ({ background: s.background, target: s.target })),
    relations: state.relations.map((r) => ({ lower: r.lower, upper: r.upper })),
    candidateBackgrounds: [...suggestState.candidates],
    tolerance: suggestState.tolerance,
    selectedBackground: reviewState.selectedBackground,
    measuredColor: reviewState.measuredColor,
    measurementLimit: reviewState.measurementLimit,
  };
  elReviewStatus.textContent = "复核中…";
  elReviewStatus.className = "status busy";
  elReviewErrors.hidden = true;

  try {
    const resp = await fetch("/api/review-measurement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    elReviewStatus.textContent = "";
    elReviewStatus.className = "status";
    if (!resp.ok) {
      showReviewErrors(data.errors || [{ scope: "form", message: "复核失败" }]);
      return;
    }
    reviewState.result = data;
    reviewState.resultKey = reviewSignature();
    renderReviewResult(data);
  } catch (err) {
    elReviewStatus.textContent = "";
    elReviewStatus.className = "status";
    showReviewErrors([{ scope: "form", message: "无法连接计算服务：" + err.message }]);
  }
}

function showReviewErrors(errors) {
  elReviewErrors.innerHTML =
    "<ul>" + errors.map((er) => `<li>${escapeHtml(er.message)}</li>`).join("") + "</ul>";
  elReviewErrors.hidden = false;
}

function renderReviewResult(r) {
  const fresh = reviewResultFresh();
  let html = `
    <div class="metric-row">
      <span>复核背景：<b>${r.selectedBackground}</b></span>
      <span>实测目标色：<b class="hexval">${r.measuredColor}</b></span>
      <span>新测量误差上限：<b>${fmtSse(r.measurementLimit)}</b></span>
      <span>建议容差：<b>${fmtSse(r.tolerance)}</b></span>
    </div>
    <div class="metric-row">
      <span>合规叠序：<b>${r.feasibleCount}</b> 条</span>
      <span>容差内（筛选前）：<b>${r.withinCount}</b> 条</span>
      <span>新测量上限内（筛选后）：<b>${r.matchedCount}</b> 条</span>
      <span>按新测量误差、旧总误差、ID 序列排序，展示前 <b>${r.shownCount}</b> 条
        （筛选覆盖全部 ${r.withinCount} 条，未因展示截断而漏检）</span>
    </div>
  `;

  if (!r.compatible) {
    html += `
      <div class="review-incompat">
        实测色 ${r.measuredColor} 在背景 ${r.selectedBackground} 上与现有候选不相容：
        容差内的 ${r.withinCount} 条叠序在该背景上的预测色，新测量误差均超过上限
        ${fmtSse(r.measurementLimit)}。请检查实测颜色 / 误差上限 / 候选背景，或调整图层与旧样本。
      </div>`;
    elReviewResult.innerHTML = html;
    return;
  }

  const orderRows = r.orders
    .map((o, k) => {
      const rgbTxt = o.predictedRgb.map((v) => Math.round(v)).join(", ");
      return `
        <div class="review-order-row">
          <span class="row-index">${k + 1}</span>
          <span class="mini" style="background:${o.predictedHex}"></span>
          <span class="review-order-ids">${o.order.map(escapeHtml).join(" ↑ ")}</span>
          <span class="hint">旧总误差 ${fmtSse(o.oldTotalSse)}</span>
          <span class="review-meas">新测量误差 <b>${fmtSse(o.measurementSse)}</b></span>
          <span class="spacer"></span>
          <span class="hexval">${o.predictedHex}</span>
          <span class="hint">rgb(${rgbTxt})</span>
        </div>`;
    })
    .join("");
  html += `<div class="review-orders">${orderRows}</div>`;

  if (r.canAppendSample) {
    html += `
      <div class="review-append-row">
        <button class="btn btn-small" data-act="review-append" type="button"
                ${fresh ? "" : "disabled"}>把本次测量追加为第 ${r.sampleCount + 1} 组样本并重新求解</button>
        <span class="hint">当前 ${r.sampleCount} 组旧样本（少于 4 组）；追加后旧复核结果即失效</span>
      </div>`;
  } else {
    html += `
      <div class="hint review-append-row">
        旧样本已有 ${r.sampleCount} 组（上限 4 组），不能再追加；如需纳入本次测量，请先在左侧样本区替换或删除一组。
      </div>`;
  }

  elReviewResult.innerHTML = html;
  if (!fresh) markReviewStaleness();
}

function appendReviewSample() {
  const r = reviewState.result;
  if (!r || !reviewResultFresh() || !r.canAppendSample) return;
  // 以「选定候选背景 + 实测目标色」追加为一组新样本，随后触发原求解；
  // 追加即输入变化，复核与建议结果一并失效，不能再用于下一次追加。
  state.samples.push({ background: r.selectedBackground, target: r.measuredColor });
  render();
  markSuggestStaleness();
  renderSuggestControls();
  markReviewStaleness();
  markTransitionStaleness();
  runSolve();
}

// ======================================================== 成环解除方案 ==

const cycleState = {
  plan: null,          // 最近一次成功获取的待确认方案（含冲突链与待删对）
  planKey: "",         // 方案产生时的输入指纹（图层 / 样本 / 关系）
  invalidated: false,  // 方案展示后输入是否曾变化过：一旦置位，改回原值也不复活
  planReqId: 0,        // 当前仍可落地的在途「方案」请求序号；0 表示无
  planReqSig: "",      // 在途方案请求发出时的输入指纹
  confirmReqId: 0,     // 当前仍可落地的在途「确认」请求序号；0 表示无
  confirmReqSig: "",   // 在途确认请求发出时的输入指纹
  reqSeq: 0,           // 单调递增的请求序号源（方案/确认共用），永不归零
};

// 是否有在途的方案或确认请求
function cycleBusy() {
  return cycleState.planReqId !== 0 || cycleState.confirmReqId !== 0;
}

const elCycleCard = $("#cycleCard");
const elCycleResult = $("#cycleResult");
const elCycleErrors = $("#cycleErrors");
const elCycleStatus = $("#cycleStatus");

function cycleSignature(payload) {
  // 方案仅取决于当前图层、样本与关系
  return JSON.stringify({
    layers: payload.layers,
    samples: payload.samples,
    relations: payload.relations,
  });
}

function clearCyclePlan() {
  cycleState.plan = null;
  cycleState.planKey = "";
  cycleState.invalidated = false;
  cycleState.planReqId = 0;
  cycleState.planReqSig = "";
  cycleState.confirmReqId = 0;
  cycleState.confirmReqSig = "";
  elCycleCard.hidden = true;
  elCycleResult.innerHTML = "";
  elCycleErrors.hidden = true;
  elCycleStatus.textContent = "";
  elCycleStatus.className = "status";
}

// 输入（图层 / 样本 / 关系）变化时：在途的方案 / 确认请求若指纹与当前不一致则
// 立即作废（加载态随之结束，旧响应在守卫处丢弃）；已展示方案一旦在获取后
// 发生过任何变化即永久作废——改回原值也不能恢复确认资格。reqSeq 永不归零。
function markCycleStaleness() {
  const sig = cycleSignature(buildSolvePayload());
  if (cycleState.planReqId !== 0 && sig !== cycleState.planReqSig) {
    cycleState.planReqId = 0;
    cycleState.planReqSig = "";
  }
  if (cycleState.confirmReqId !== 0 && sig !== cycleState.confirmReqSig) {
    cycleState.confirmReqId = 0;
    cycleState.confirmReqSig = "";
  }
  if (!cycleBusy()) {
    elCycleStatus.textContent = "";
    elCycleStatus.className = "status";
  }
  if (!cycleState.plan) return;
  if (sig !== cycleState.planKey) cycleState.invalidated = true;
  const dead = cycleState.invalidated;
  const old = elCycleResult.querySelector(".stale-note");
  const btn = elCycleResult.querySelector('button[data-act="cycle-confirm"]');
  if (dead) {
    if (!old) {
      const note = document.createElement("div");
      note.className = "stale-note";
      note.textContent = "图层、样本或关系已变化，以下解除方案已作废（即使改回原值也不能再确认），请等待新方案。";
      elCycleResult.prepend(note);
    }
    if (btn) btn.disabled = true;
  } else if (old) {
    old.remove();
    if (btn) btn.disabled = false;
  }
}

function cyclePlanFresh() {
  return !!cycleState.plan &&
    !cycleState.invalidated &&
    cycleSignature(buildSolvePayload()) === cycleState.planKey;
}

// 响应守卫：只有「当前在途的该类请求」且「发出后输入始终未变」的响应可以
// 更新方案 / 错误 / 加载状态；旧请求无论成功、HTTP 错误还是连接异常都丢弃。
function cycleResponseCurrent(kind, reqId, reqSig) {
  const id = kind === "confirm" ? cycleState.confirmReqId : cycleState.planReqId;
  return (
    id === reqId &&
    cycleSignature(buildSolvePayload()) === reqSig
  );
}

async function runCyclePlan(payload, opts = {}) {
  // silentOnError：作为自动求解的伴随请求时，业务 400（其他非法输入）不单独
  // 在卡片内报错——同样的错误已由顶部错误横幅展示；这里只需隐藏方案卡片。
  const silentOnError = !!opts.silentOnError;
  const reqId = ++cycleState.reqSeq;
  cycleState.planReqId = reqId;
  const reqSig = cycleSignature(payload);
  cycleState.planReqSig = reqSig;

  elCycleCard.hidden = false;
  elCycleErrors.hidden = true;
  elCycleStatus.textContent = "分析解除方案中…";
  elCycleStatus.className = "status busy";
  elCycleResult.innerHTML = `<div class="result-empty">正在从至多 ${MAX_RELATIONS} 条关系中寻找删去条数最少的一组…</div>`;

  try {
    const resp = await fetch("/api/resolve-cycle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!cycleResponseCurrent("plan", reqId, reqSig)) return;
    const data = await resp.json();
    cycleState.planReqId = 0;
    cycleState.planReqSig = "";
    elCycleStatus.textContent = "";
    elCycleStatus.className = "status";
    if (!resp.ok) {
      // 其他非法输入仍按现有规则报错：自动伴随模式下交给顶部横幅，这里仅隐藏卡片
      if (!silentOnError) {
        showCycleErrors(data.errors || [{ scope: "form", message: "解除方案分析失败" }]);
        elCycleResult.innerHTML =
          '<div class="result-empty">请先按顶部错误提示修正输入，再获取解除方案。</div>';
      }
      cycleState.plan = null;
      cycleState.planKey = "";
      cycleState.invalidated = false;
      elCycleCard.hidden = true;
      elCycleResult.innerHTML = "";
      return;
    }
    if (!data.cyclic) {
      // 无环：空方案，不展示卡片
      clearCyclePlan();
      return;
    }
    cycleState.plan = data;
    cycleState.planKey = reqSig;
    cycleState.invalidated = false;
    renderCyclePlan(data, true);
  } catch (err) {
    if (!cycleResponseCurrent("plan", reqId, reqSig)) return;
    cycleState.planReqId = 0;
    cycleState.planReqSig = "";
    elCycleStatus.textContent = "";
    elCycleStatus.className = "status";
    showCycleErrors([{ scope: "form", message: "无法连接计算服务：" + err.message }]);
  }
}

function showCycleErrors(errors) {
  elCycleErrors.innerHTML =
    "<ul>" + errors.map((er) => `<li>${escapeHtml(er.message)}</li>`).join("") + "</ul>";
  elCycleErrors.hidden = false;
}

function renderCyclePlan(plan, fresh) {
  elCycleErrors.hidden = true;
  const rows = plan.removePairs
    .map((p, k) => `
      <div class="cycle-pair-row${p.selfLoop ? " self-loop" : ""}">
        <span class="row-index">${k + 1}</span>
        <b class="hexval">${escapeHtml(p.lower)}</b>
        <span class="relation-arrow">${p.selfLoop ? "↺ 自环（下方与上方是同一图层）" : "在更下方 ▲ 叠在"}</span>
        ${p.selfLoop ? "" : `<b class="hexval">${escapeHtml(p.upper)}</b><span class="relation-arrow">之上</span>`}
        <span class="spacer"></span>
        <span class="hint">同向重复 ${p.occurrences} 条将一并移除</span>
      </div>`)
    .join("");

  elCycleResult.innerHTML = `
    <div class="cycle-conflict">
      当前冲突链（底 → 顶）：<b class="hexval">${escapeHtml(plan.conflictChain)}</b>
    </div>
    <div class="suggest-sec-title">
      待确认解除方案：删除 <b>${plan.removeCount}</b> 种关系
      （覆盖 ${plan.removedOccurrences} 条同向重复输入；去重后共 ${plan.relationCount} 条关系）——
      已保证删去种数最少且剩余关系无环，并列时取关系对列表字典序最小者
    </div>
    <div class="rows cycle-pairs">${rows}</div>
    <div class="infer-actions">
      <button class="btn btn-small" data-act="cycle-confirm" type="button"
              ${fresh ? "" : "disabled"}>确认并移除这些关系后重新求解</button>
      <span class="hint">不会自动修改；确认前其他输入保持原样，确认后一次性移除上述各对的全部重复项并触发原求解</span>
    </div>
  `;
  if (!fresh) markCycleStaleness();
}

async function confirmCyclePlan() {
  const plan = cycleState.plan;
  if (!plan || !cyclePlanFresh()) return;
  if (cycleState.confirmReqId !== 0) return; // 确认已在途，防重复点击

  const payload = buildSolvePayload();
  const reqId = ++cycleState.reqSeq;
  cycleState.confirmReqId = reqId;
  const reqSig = cycleSignature(payload);
  cycleState.confirmReqSig = reqSig;

  const body = {
    ...payload,
    removePairs: plan.removePairs.map((p) => ({ lower: p.lower, upper: p.upper })),
  };

  // 确认在途期间禁用按钮，待其成功（卡片随结果清除）或失败 / 作废后再处理
  const confirmBtnEl = elCycleResult.querySelector('button[data-act="cycle-confirm"]');
  if (confirmBtnEl) confirmBtnEl.disabled = true;
  elCycleStatus.textContent = "确认移除并重新求解中…";
  elCycleStatus.className = "status busy";
  elCycleErrors.hidden = true;

  try {
    const resp = await fetch("/api/confirm-cycle-resolution", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!cycleResponseCurrent("confirm", reqId, reqSig)) return;
    const data = await resp.json();
    cycleState.confirmReqId = 0;
    cycleState.confirmReqSig = "";
    elCycleStatus.textContent = "";
    elCycleStatus.className = "status";
    if (!resp.ok) {
      showCycleErrors(data.errors || [{ scope: "form", message: "确认解除失败" }]);
      // 服务端认定方案已不匹配当前输入：本地同步作废，须重新获取方案
      cycleState.plan = null;
      cycleState.planKey = "";
      cycleState.invalidated = false;
      elCycleResult.innerHTML =
        '<div class="result-empty">解除方案已失效，请在当前输入下重新获取方案。</div>';
      return;
    }
    // 一次性移除这些对的全部重复项（按规范化 ID 匹配），保留其他输入
    const removeSet = new Set(plan.removePairs.map((p) => `${p.lower.trim()} ${p.upper.trim()}`));
    state.relations = state.relations.filter(
      (r) => !removeSet.has(`${String(r.lower).trim()} ${String(r.upper).trim()}`)
    );
    render();
    markInferStaleness();
    markSuggestStaleness();
    markReviewStaleness();
    markTransitionStaleness();
    clearCyclePlan();
    showErrors([]);
    lastSolveResult = data;
    renderResult(data);
  } catch (err) {
    if (!cycleResponseCurrent("confirm", reqId, reqSig)) return;
    cycleState.confirmReqId = 0;
    cycleState.confirmReqSig = "";
    elCycleStatus.textContent = "";
    elCycleStatus.className = "status";
    showCycleErrors([{ scope: "form", message: "无法连接计算服务：" + err.message }]);
  }
}

// ------------------------------------------------------------ 启动 --
render();
renderSuggestControls();
renderReviewBgOptions();
runSolve();
