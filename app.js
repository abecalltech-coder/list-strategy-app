// ============================================================
// リスト戦略システム — メインロジック
// 列名・列数・行数がシートごとに変わっても動くよう、
// ヘッダー行(1行目)を都度読み取って動的にUIを組み立てます。
// ============================================================
"use strict";

const CONFIG = window.APP_CONFIG;

const state = {
  sheets: {}, // title -> { headers: string[], rows: any[][] }
  sheetOrder: [],
  filters: {}, // title -> { [colIndex]: filterObj }
  sort: {}, // title -> { colIndex, dir }
  globalPrefectures: new Set(), // 空 = 全都道府県
  includedSheets: new Set(),
  activeDetailSheet: null,
  activeTab: "summary",
  pivotSort: { key: "total", dir: "desc" },
  pivotAgg: { mode: "count", column: null },
  loaded: false,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ------------------------------------------------------------
// データ取得
// ------------------------------------------------------------

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.error?.message || "";
    } catch (_) {}
    throw new Error(`HTTP ${res.status} ${res.statusText} ${detail}`.trim());
  }
  return res.json();
}

async function fetchSheetTitles() {
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(CONFIG.spreadsheetId)}` +
    `?key=${encodeURIComponent(CONFIG.apiKey)}&fields=sheets.properties.title`;
  const data = await fetchJson(url);
  const titles = (data.sheets || []).map((s) => s.properties.title);
  return titles.filter((t) => !CONFIG.excludeSheets.includes(t));
}

async function fetchSheetValues(title) {
  const range = `${title}`;
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(CONFIG.spreadsheetId)}/values/${encodeURIComponent(range)}` +
    `?key=${encodeURIComponent(CONFIG.apiKey)}&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`;
  const data = await fetchJson(url);
  const values = data.values || [];
  const headers = (values[0] || []).map((h, i) => (h === undefined || h === "" ? `(列${i + 1})` : String(h)));
  let rows = values.slice(1).filter((r) => r.some((c) => c !== "" && c !== undefined && c !== null));
  rows = cleanupRows(rows);
  return { headers, rows };
}

// ピボットテーブル由来のシートは、グループ化列(A列=リスト名)が
// 「先頭行だけ値があり、以降は空欄」の形で出力されることがあるため、
// 直前の値を引き継ぐ(フォワードフィル)。
// また "○○, unchecked, ドリルダウンするために行を選択します。\n\n○○" のような
// UIのラベルが値に混入することがあるため、本来の名前だけを取り出す。
function cleanGroupLabel(raw) {
  if (raw === undefined || raw === null) return "";
  const s = String(raw);
  const marker = ", unchecked,";
  const idx = s.indexOf(marker);
  return (idx !== -1 ? s.slice(0, idx) : s).trim();
}

function cleanupRows(rows) {
  const nameCol = CONFIG.listNameColumnIndex;
  const prefCol = CONFIG.prefectureColumnIndex;
  let lastName = "";
  const out = [];
  for (const r of rows) {
    const row = [...r];
    const cleaned = cleanGroupLabel(row[nameCol]);
    if (cleaned) {
      lastName = cleaned;
    }
    row[nameCol] = lastName;

    const prefEmpty = row[prefCol] === undefined || row[prefCol] === null || row[prefCol] === "";
    if (CONFIG.dropRowsWithEmptyPrefecture && prefEmpty) {
      // 都道府県が空の行は、ピボットテーブルの「総計」等の集計行とみなして除外する
      continue;
    }
    out.push(row);
  }
  return out;
}

async function loadAll() {
  setStatus("読み込み中...", false);
  try {
    const titles = await fetchSheetTitles();
    const results = await Promise.all(
      titles.map(async (title) => {
        const { headers, rows } = await fetchSheetValues(title);
        return [title, { headers, rows }];
      })
    );

    state.sheets = Object.fromEntries(results);
    state.sheetOrder = titles;
    state.includedSheets = new Set(titles);
    state.filters = {};
    state.sort = {};
    titles.forEach((t) => {
      state.filters[t] = buildDefaultFilters(t);
      state.sort[t] = { colIndex: null, dir: null };
    });
    if (!state.activeDetailSheet || !titles.includes(state.activeDetailSheet)) {
      state.activeDetailSheet = titles[0] || null;
    }
    state.loaded = true;
    setStatus(`最終更新: ${new Date().toLocaleString("ja-JP")} (${titles.length}シート)`, false);
    renderAreaSwitcher();
    renderSheetSelector();
    renderGlobalPrefectureFilter();
    refreshAggControls();
    renderDetailSheetTabs();
    renderDetailTable();
    renderSummary();
  } catch (err) {
    console.error(err);
    setStatus(`エラー: ${err.message}`, true);
  }
}

function setStatus(text, isError) {
  const el = $("#status");
  el.textContent = text;
  el.classList.toggle("error", !!isError);
}

// ------------------------------------------------------------
// 列タイプの自動判定
// ------------------------------------------------------------

function getColumnValues(title, colIndex) {
  const { rows } = state.sheets[title];
  return rows.map((r) => r[colIndex]).map((v) => (v === undefined || v === null ? "" : v));
}

function detectColumnType(title, colIndex) {
  const values = getColumnValues(title, colIndex);
  const nonEmpty = values.filter((v) => v !== "");
  if (nonEmpty.length === 0) return { type: "text" };

  const allNumeric = nonEmpty.every((v) => typeof v === "number" || (v !== "" && !isNaN(parseFloat(v)) && isFinite(v)));
  if (allNumeric) return { type: "numeric" };

  const unique = Array.from(new Set(nonEmpty.map((v) => String(v))));
  if (unique.length <= CONFIG.categoricalThreshold) {
    return { type: "categorical", options: unique.sort((a, b) => a.localeCompare(b, "ja")) };
  }
  return { type: "text" };
}

function buildDefaultFilters(title) {
  const { headers } = state.sheets[title];
  const filters = {};
  headers.forEach((_, colIndex) => {
    const det = detectColumnType(title, colIndex);
    if (det.type === "categorical") {
      filters[colIndex] = { type: "categorical", options: det.options, selected: new Set(det.options) };
    } else if (det.type === "numeric") {
      const values = getColumnValues(title, colIndex).filter((v) => v !== "").map(Number);
      filters[colIndex] = {
        type: "numeric",
        dataMin: values.length ? Math.min(...values) : null,
        dataMax: values.length ? Math.max(...values) : null,
        min: null,
        max: null,
      };
    } else {
      filters[colIndex] = { type: "text", query: "" };
    }
  });
  return filters;
}

// ------------------------------------------------------------
// フィルタ適用・ソート
// ------------------------------------------------------------

function rowMatchesFilters(cells, filters, { skipGlobalPrefecture } = {}) {
  if (!skipGlobalPrefecture && state.globalPrefectures.size > 0) {
    const pref = String(cells[CONFIG.prefectureColumnIndex] ?? "");
    if (!state.globalPrefectures.has(pref)) return false;
  }
  for (const [colIndexStr, f] of Object.entries(filters)) {
    const colIndex = Number(colIndexStr);
    const val = cells[colIndex];
    if (f.type === "categorical") {
      const v = String(val === undefined || val === null ? "" : val);
      if (v === "" && f.selected.size === f.options.length) continue; // 空欄は許容
      if (!f.selected.has(v)) return false;
    } else if (f.type === "numeric") {
      if (f.min !== null || f.max !== null) {
        const num = parseFloat(val);
        if (isNaN(num)) return false;
        if (f.min !== null && num < f.min) return false;
        if (f.max !== null && num > f.max) return false;
      }
    } else if (f.type === "text") {
      if (f.query) {
        const v = String(val === undefined || val === null ? "" : val).toLowerCase();
        if (!v.includes(f.query.toLowerCase())) return false;
      }
    }
  }
  return true;
}

function getFilteredRows(title, opts) {
  const { rows } = state.sheets[title];
  const filters = state.filters[title];
  return rows
    .map((cells, idx) => ({ idx, cells }))
    .filter(({ cells }) => rowMatchesFilters(cells, filters, opts));
}

function sortRowObjs(title, rowObjs) {
  const s = state.sort[title];
  if (!s || s.colIndex === null || !s.dir) return rowObjs;
  const colIndex = s.colIndex;
  const dirMul = s.dir === "asc" ? 1 : -1;
  return [...rowObjs].sort((a, b) => {
    const av = a.cells[colIndex];
    const bv = b.cells[colIndex];
    const an = parseFloat(av);
    const bn = parseFloat(bv);
    const bothNumeric = av !== "" && av !== undefined && bv !== "" && bv !== undefined && !isNaN(an) && !isNaN(bn);
    if (bothNumeric) return (an - bn) * dirMul;
    return String(av ?? "").localeCompare(String(bv ?? ""), "ja") * dirMul;
  });
}

// ------------------------------------------------------------
// エリア(シート名の【】部分)ごとのグループ化
// シート名が「【関東】リストデータ」のような形式であれば、
// 【】内をエリア名として扱い、エリア単位での表示切替に使う。
// 該当しないシート名は「その他」エリアとして扱う。
// ------------------------------------------------------------

function getSheetArea(title) {
  const m = title.match(/^【([^】]+)】/);
  return m ? m[1] : "その他";
}

function groupSheetsByArea() {
  const map = new Map(); // area -> titles[]
  state.sheetOrder.forEach((title) => {
    const area = getSheetArea(title);
    if (!map.has(area)) map.set(area, []);
    map.get(area).push(title);
  });
  return map;
}

// ------------------------------------------------------------
// 都道府県一覧(全シート横断)
// ------------------------------------------------------------

function getAllPrefectures() {
  const set = new Set();
  for (const title of state.sheetOrder) {
    for (const v of getColumnValues(title, CONFIG.prefectureColumnIndex)) {
      if (v !== "") set.add(String(v));
    }
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, "ja"));
}

// ------------------------------------------------------------
// 描画: グローバルコントロール
// ------------------------------------------------------------

function renderAreaSwitcher() {
  const container = $("#area-switcher");
  container.innerHTML = "";
  const areaMap = groupSheetsByArea();

  const allBtn = document.createElement("button");
  allBtn.className = "area-btn";
  allBtn.textContent = "すべて";
  allBtn.addEventListener("click", () => {
    state.includedSheets = new Set(state.sheetOrder);
    afterIncludedSheetsChanged();
  });
  container.appendChild(allBtn);

  areaMap.forEach((titles, area) => {
    const btn = document.createElement("button");
    btn.className = "area-btn";
    btn.textContent = area;
    btn.addEventListener("click", () => {
      state.includedSheets = new Set(titles);
      if (!titles.includes(state.activeDetailSheet)) {
        state.activeDetailSheet = titles[0];
      }
      afterIncludedSheetsChanged();
    });
    container.appendChild(btn);
  });
}

function afterIncludedSheetsChanged() {
  renderSheetSelector();
  refreshAggControls();
  renderDetailSheetTabs();
  renderDetailTable();
  renderSummary();
}

function renderSheetSelector() {
  const container = $("#sheet-selector");
  container.innerHTML = "";
  const areaMap = groupSheetsByArea();

  areaMap.forEach((titles, area) => {
    const group = document.createElement("div");
    group.className = "sheet-group";

    const groupLabel = document.createElement("span");
    groupLabel.className = "sheet-group-label";
    groupLabel.textContent = area;
    group.appendChild(groupLabel);

    titles.forEach((title) => {
      const id = `sheet-chk-${title}`;
      const label = document.createElement("label");
      label.className = "chip";
      label.innerHTML = `<input type="checkbox" id="${id}" ${state.includedSheets.has(title) ? "checked" : ""}/> ${escapeHtml(title)}`;
      label.querySelector("input").addEventListener("change", (e) => {
        if (e.target.checked) state.includedSheets.add(title);
        else state.includedSheets.delete(title);
        if (!state.includedSheets.has(state.activeDetailSheet)) {
          state.activeDetailSheet = state.sheetOrder.find((t) => state.includedSheets.has(t)) || state.activeDetailSheet;
        }
        refreshAggControls();
        renderDetailSheetTabs();
        renderDetailTable();
        renderSummary();
      });
      group.appendChild(label);
    });

    container.appendChild(group);
  });
}

// ------------------------------------------------------------
// サマリーの集計方法(件数 / 数値列の合計)
// ------------------------------------------------------------

function getNumericColumnUnion() {
  const names = new Set();
  state.sheetOrder
    .filter((t) => state.includedSheets.has(t))
    .forEach((title) => {
      const { headers } = state.sheets[title];
      headers.forEach((h, idx) => {
        if (detectColumnType(title, idx).type === "numeric") names.add(h);
      });
    });
  const arr = Array.from(names);
  arr.sort((a, b) => {
    if (a === "合計") return -1;
    if (b === "合計") return 1;
    return a.localeCompare(b, "ja");
  });
  return arr;
}

function refreshAggControls() {
  const options = getNumericColumnUnion();
  const columnSelect = $("#agg-column");
  const modeSelect = $("#agg-mode");
  const prevColumn = state.pivotAgg.column;

  if (options.length === 0) {
    state.pivotAgg.mode = "count";
    state.pivotAgg.column = null;
    modeSelect.value = "count";
    columnSelect.innerHTML = `<option value="">(数値列なし)</option>`;
    columnSelect.disabled = true;
    return;
  }

  columnSelect.disabled = false;
  columnSelect.innerHTML = options.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("");
  const keep = options.includes(prevColumn) ? prevColumn : options[0];
  columnSelect.value = keep;
  state.pivotAgg.column = keep;
  if (!prevColumn) {
    state.pivotAgg.mode = "sum";
  }
  modeSelect.value = state.pivotAgg.mode;
}

$("#agg-mode").addEventListener("change", (e) => {
  state.pivotAgg.mode = e.target.value;
  renderSummary();
});
$("#agg-column").addEventListener("change", (e) => {
  state.pivotAgg.column = e.target.value;
  renderSummary();
});

function renderGlobalPrefectureFilter() {
  const container = $("#pref-filter");
  container.innerHTML = "";
  const all = getAllPrefectures();
  all.forEach((pref) => {
    const label = document.createElement("label");
    label.className = "chip";
    label.innerHTML = `<input type="checkbox" data-pref="${escapeHtml(pref)}" checked/> ${escapeHtml(pref)}`;
    label.querySelector("input").addEventListener("change", updateGlobalPrefectureSelection);
    container.appendChild(label);
  });
  state.globalPrefectures = new Set(); // 空 = 全件
}

function updateGlobalPrefectureSelection() {
  const boxes = $$("#pref-filter input[type=checkbox]");
  const checked = boxes.filter((b) => b.checked).map((b) => b.dataset.pref);
  if (checked.length === boxes.length) {
    state.globalPrefectures = new Set(); // 全選択 = フィルタなし扱い
  } else {
    state.globalPrefectures = new Set(checked);
  }
  renderDetailTable();
  renderSummary();
}

$("#pref-select-all").addEventListener("click", () => {
  $$("#pref-filter input[type=checkbox]").forEach((b) => (b.checked = true));
  updateGlobalPrefectureSelection();
});
$("#pref-select-none").addEventListener("click", () => {
  $$("#pref-filter input[type=checkbox]").forEach((b) => (b.checked = false));
  updateGlobalPrefectureSelection();
});

// ------------------------------------------------------------
// 描画: 詳細データタブ
// ------------------------------------------------------------

function renderDetailSheetTabs() {
  const container = $("#detail-sheet-tabs");
  container.innerHTML = "";
  const areaMap = groupSheetsByArea();
  const visibleTitles = state.sheetOrder.filter((t) => state.includedSheets.has(t));

  areaMap.forEach((titles, area) => {
    const shown = titles.filter((t) => visibleTitles.includes(t));
    if (shown.length === 0) return;

    const areaLabel = document.createElement("span");
    areaLabel.className = "tab-area-label";
    areaLabel.textContent = area;
    container.appendChild(areaLabel);

    shown.forEach((title) => {
      const btn = document.createElement("button");
      btn.className = "tab-btn" + (state.activeDetailSheet === title ? " active" : "");
      btn.textContent = title.replace(/^【[^】]+】/, "");
      btn.addEventListener("click", () => {
        state.activeDetailSheet = title;
        renderDetailSheetTabs();
        renderDetailTable();
      });
      container.appendChild(btn);
    });
  });
}

function renderDetailTable() {
  const title = state.activeDetailSheet;
  const panel = $("#detail-panel");
  panel.innerHTML = "";
  if (!title || !state.sheets[title]) {
    panel.innerHTML = `<p class="muted">シートがありません</p>`;
    return;
  }
  const { headers } = state.sheets[title];
  const filters = state.filters[title];

  // --- フィルタカード ---
  const filterWrap = document.createElement("div");
  filterWrap.className = "filter-cards";
  headers.forEach((headerName, colIndex) => {
    const f = filters[colIndex];
    const card = document.createElement("div");
    card.className = "filter-card";
    const titleEl = document.createElement("div");
    titleEl.className = "filter-card-title";
    titleEl.textContent = headerName;
    card.appendChild(titleEl);

    if (f.type === "categorical") {
      const box = document.createElement("div");
      box.className = "cat-options";
      f.options.forEach((opt) => {
        const lbl = document.createElement("label");
        lbl.className = "cat-option";
        const checked = f.selected.has(opt);
        lbl.innerHTML = `<input type="checkbox" ${checked ? "checked" : ""}/> <span>${escapeHtml(opt)}</span>`;
        lbl.querySelector("input").addEventListener("change", (e) => {
          if (e.target.checked) f.selected.add(opt);
          else f.selected.delete(opt);
          renderDetailTable();
        });
        box.appendChild(lbl);
      });
      card.appendChild(box);
    } else if (f.type === "numeric") {
      const row = document.createElement("div");
      row.className = "numeric-row";
      row.innerHTML = `
        <input type="number" placeholder="最小(${f.dataMin ?? "-"})" value="${f.min ?? ""}"/>
        <span>〜</span>
        <input type="number" placeholder="最大(${f.dataMax ?? "-"})" value="${f.max ?? ""}"/>
      `;
      const [minInput, , maxInput] = row.children;
      minInput.addEventListener("input", (e) => {
        f.min = e.target.value === "" ? null : Number(e.target.value);
        renderDetailTable();
      });
      maxInput.addEventListener("input", (e) => {
        f.max = e.target.value === "" ? null : Number(e.target.value);
        renderDetailTable();
      });
      card.appendChild(row);
    } else {
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "検索...";
      input.value = f.query;
      input.addEventListener("input", (e) => {
        f.query = e.target.value;
        renderDetailTable();
      });
      card.appendChild(input);
    }
    filterWrap.appendChild(card);
  });

  const resetBtn = document.createElement("button");
  resetBtn.className = "btn-secondary";
  resetBtn.textContent = "この表のフィルタをリセット";
  resetBtn.addEventListener("click", () => {
    state.filters[title] = buildDefaultFilters(title);
    renderDetailTable();
  });

  panel.appendChild(filterWrap);
  panel.appendChild(resetBtn);

  // --- テーブル ---
  let rowObjs = getFilteredRows(title);
  const totalCount = state.sheets[title].rows.length;
  rowObjs = sortRowObjs(title, rowObjs);

  const countEl = document.createElement("div");
  countEl.className = "row-count";
  countEl.textContent = `${rowObjs.length} / ${totalCount} 件`;
  panel.appendChild(countEl);

  const tableWrap = document.createElement("div");
  tableWrap.className = "table-scroll";
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headers.forEach((headerName, colIndex) => {
    const th = document.createElement("th");
    const sort = state.sort[title];
    let arrow = "";
    if (sort.colIndex === colIndex) arrow = sort.dir === "asc" ? " ▲" : " ▼";
    th.textContent = headerName + arrow;
    th.classList.add("sortable");
    th.addEventListener("click", () => {
      const cur = state.sort[title];
      if (cur.colIndex !== colIndex) {
        state.sort[title] = { colIndex, dir: "asc" };
      } else if (cur.dir === "asc") {
        state.sort[title] = { colIndex, dir: "desc" };
      } else {
        state.sort[title] = { colIndex: null, dir: null };
      }
      renderDetailTable();
    });
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const MAX_RENDER = 1000;
  rowObjs.slice(0, MAX_RENDER).forEach(({ cells }) => {
    const tr = document.createElement("tr");
    headers.forEach((_, colIndex) => {
      const td = document.createElement("td");
      const v = cells[colIndex];
      td.textContent = v === undefined || v === null ? "" : String(v);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  panel.appendChild(tableWrap);

  if (rowObjs.length > MAX_RENDER) {
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = `※ 表示は先頭${MAX_RENDER}件までです。フィルタを絞り込むとより見やすくなります。`;
    panel.appendChild(note);
  }
}

// ------------------------------------------------------------
// 描画: サマリー(都道府県×シート ヒートマップ)
// ------------------------------------------------------------

function computePivot() {
  const sheets = state.sheetOrder.filter((t) => state.includedSheets.has(t));
  const prefSet = new Set();
  const matrix = {}; // pref -> sheet -> count/sum
  const mode = state.pivotAgg.mode;
  const aggColumn = state.pivotAgg.column;

  sheets.forEach((title) => {
    const rowObjs = getFilteredRows(title, { skipGlobalPrefecture: true });
    const headers = state.sheets[title].headers;
    const aggColIdx = mode === "sum" && aggColumn ? headers.indexOf(aggColumn) : -1;
    rowObjs.forEach(({ cells }) => {
      const pref = String(cells[CONFIG.prefectureColumnIndex] ?? "");
      if (!pref) return;
      if (state.globalPrefectures.size > 0 && !state.globalPrefectures.has(pref)) return;
      prefSet.add(pref);
      matrix[pref] = matrix[pref] || {};
      let inc = 1;
      if (mode === "sum") {
        if (aggColIdx === -1) {
          inc = 0; // このシートには集計対象の列が無い
        } else {
          const v = parseFloat(cells[aggColIdx]);
          inc = isNaN(v) ? 0 : v;
        }
      }
      matrix[pref][title] = (matrix[pref][title] || 0) + inc;
    });
  });

  const prefs = Array.from(prefSet);
  const rows = prefs.map((pref) => {
    const counts = sheets.map((t) => matrix[pref]?.[t] || 0);
    const total = counts.reduce((a, b) => a + b, 0);
    return { pref, counts, total };
  });

  const sortKey = state.pivotSort.key;
  const dirMul = state.pivotSort.dir === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    let av, bv;
    if (sortKey === "total") {
      av = a.total;
      bv = b.total;
    } else if (sortKey === "pref") {
      return a.pref.localeCompare(b.pref, "ja") * dirMul;
    } else {
      const i = sheets.indexOf(sortKey);
      av = a.counts[i] || 0;
      bv = b.counts[i] || 0;
    }
    return (av - bv) * dirMul;
  });

  const maxCell = Math.max(1, ...rows.flatMap((r) => r.counts));
  const maxTotal = Math.max(1, ...rows.map((r) => r.total));

  return { sheets, rows, maxCell, maxTotal };
}

function heatColor(value, max) {
  if (value === 0) return "transparent";
  const ratio = Math.min(1, value / max);
  const lightness = 92 - ratio * 47; // 92% (薄い) -> 45% (濃い)
  return `hsl(6, 85%, ${lightness}%)`;
}

function renderSummary() {
  const panel = $("#summary-panel");
  panel.innerHTML = "";
  if (!state.loaded) return;

  const { sheets, rows, maxCell, maxTotal } = computePivot();

  if (sheets.length === 0) {
    panel.innerHTML = `<p class="muted">上部でシートを選択してください</p>`;
    return;
  }
  if (rows.length === 0) {
    panel.innerHTML = `<p class="muted">条件に合うデータがありません</p>`;
    return;
  }

  const tableWrap = document.createElement("div");
  tableWrap.className = "table-scroll";
  const table = document.createElement("table");
  table.className = "pivot-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const prefTh = document.createElement("th");
  prefTh.textContent = "都道府県";
  prefTh.className = "sortable";
  prefTh.addEventListener("click", () => togglePivotSort("pref"));
  headRow.appendChild(prefTh);

  sheets.forEach((title) => {
    const th = document.createElement("th");
    th.textContent = title + sortArrow(title);
    th.className = "sortable";
    th.addEventListener("click", () => togglePivotSort(title));
    headRow.appendChild(th);
  });
  const totalTh = document.createElement("th");
  totalTh.textContent = "合計" + sortArrow("total");
  totalTh.className = "sortable";
  totalTh.addEventListener("click", () => togglePivotSort("total"));
  headRow.appendChild(totalTh);
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    const prefTd = document.createElement("td");
    prefTd.textContent = r.pref;
    prefTd.className = "pref-cell";
    tr.appendChild(prefTd);
    r.counts.forEach((c) => {
      const td = document.createElement("td");
      td.textContent = c || "";
      td.style.background = heatColor(c, maxCell);
      td.className = "count-cell";
      tr.appendChild(td);
    });
    const totalTd = document.createElement("td");
    totalTd.textContent = r.total;
    totalTd.style.background = heatColor(r.total, maxTotal);
    totalTd.className = "count-cell total-cell";
    tr.appendChild(totalTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  panel.appendChild(tableWrap);

  const note = document.createElement("p");
  note.className = "muted";
  const aggDesc =
    state.pivotAgg.mode === "sum" && state.pivotAgg.column
      ? `「${state.pivotAgg.column}」列の合計値`
      : "現在のフィルタ条件に一致した件数";
  note.textContent =
    `セルの数値は、各シートの現在のフィルタ条件に一致した行についての${aggDesc}です。` +
    "詳細データタブでシートごとに条件(ステータス等)を絞ると、この表がその条件での都道府県別の熱さに変わります。列見出しをクリックすると並び替えできます。";
  panel.appendChild(note);
}

function sortArrow(key) {
  if (state.pivotSort.key !== key) return "";
  return state.pivotSort.dir === "asc" ? " ▲" : " ▼";
}

function togglePivotSort(key) {
  if (state.pivotSort.key !== key) {
    state.pivotSort = { key, dir: "desc" };
  } else if (state.pivotSort.dir === "desc") {
    state.pivotSort = { key, dir: "asc" };
  } else {
    state.pivotSort = { key: "total", dir: "desc" };
  }
  renderSummary();
}

// ------------------------------------------------------------
// タブ切り替え・初期化
// ------------------------------------------------------------

function initTabs() {
  $$(".main-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activeTab = btn.dataset.tab;
      $$(".main-tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
      $$(".main-tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${btn.dataset.tab}`));
    });
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

$("#refresh-btn").addEventListener("click", loadAll);

initTabs();
loadAll();
