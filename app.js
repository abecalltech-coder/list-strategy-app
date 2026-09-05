// ============================================================
// リスト戦略システム — メインロジック
// 列名・列数・行数がシートごとに変わっても動くよう、
// ヘッダー行(1行目)を都度読み取って動的にUIを組み立てます。
// ============================================================
"use strict";

const CONFIG = window.APP_CONFIG;

// 「有効結果」の定義: リストデータシートのF列〜AC列(0始まりの列インデックスで5〜28)の
// 合計値を「有効結果」とする(列名ではなく列の位置で判定)。
// トスアップ率・アポ率・追加列の％はすべてこの「有効結果」に対する割合(対有効)として計算する。
// 有効率 = 有効結果 ÷ (不在 + 有効結果)。
const VALID_RESULT_COL_START = 5; // F列(0始まり: A=0, B=1, C=2, D=3, E=4, F=5)
const VALID_RESULT_COL_END = 28; // AC列(0始まり: ... Z=25, AA=26, AB=27, AC=28)

// リスト名+都道府県のキー結合に使う区切り文字(データ中に出現しない制御文字)
const SEP = "\u0000";

const state = {
  sheets: {}, // title -> { headers: string[], rows: any[][] }
  sheetOrder: [],
  filters: {}, // title -> { [colIndex]: filterObj }
  sort: {}, // title -> { colIndex, dir }
  globalPrefectures: new Set(), // 空 = 全都道府県
  includedSheets: new Set(),
  activeDetailSheet: null,
  activeTab: "summary",
  loaded: false,
  detailTableSize: { height: null }, // 詳細データ表の手動リサイズ後の高さ(null=既定)
  detailColumnWidths: {}, // title -> { [colIndex]: px } 詳細データ表の列幅(シートごとに記憶)
  reportMode: "list", // "list" = リスト毎表示 / "industry" = 業種毎表示
  report: {
    area: null,
    expandedLists: new Set(), // 都道府県の内訳を開いているリスト名(ベースはALL行のみ表示)
    remainingColumn: null, // 残量シートの中で「残量」として使う列名(自動判定)
    absentColumn: "不在", // リストデータシートの中で「不在」として使う列名
    notCalledColumn: "未コール", // リストデータシートの中で「未コール」として使う列名(値をそのまま使用)
    tossupColumn: null, // トスアップ率の分子として使う列名(自動判定)
    appoColumn: null, // アポ率の分子として使う列名(自動判定)
    extraColumns: new Set(), // (現在は未使用。常に空)
    sort: { key: "remaining", dir: "desc" },
    tableSize: { height: null }, // リスト毎表示の表の手動リサイズ後の高さ(null=既定)
    columnWidths: {}, // key -> px 列ごとの幅(ドラッグで変更した分を記憶)
    industrySort: { key: "remaining", dir: "desc" }, // 業種毎表示のソート
    industryTableSize: { height: null }, // 業種毎表示の表の手動リサイズ後の高さ
    industryColumnWidths: {}, // 業種毎表示の列幅
  },
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
    if (!state.report.area || !groupSheetsByArea().has(state.report.area)) {
      const firstArea = Array.from(groupSheetsByArea().keys())[0] || null;
      state.report.area = firstArea;
    }
    renderAreaSwitcher();
    renderSheetSelector();
    renderGlobalPrefectureFilter();
    refreshReportControls();
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
  allBtn.className = "area-btn" + (state.includedSheets.size === state.sheetOrder.length ? " active" : "");
  allBtn.textContent = "すべて";
  allBtn.addEventListener("click", () => {
    state.includedSheets = new Set(state.sheetOrder);
    afterIncludedSheetsChanged();
  });
  container.appendChild(allBtn);

  areaMap.forEach((titles, area) => {
    const btn = document.createElement("button");
    const isActive = state.report.area === area;
    btn.className = "area-btn" + (isActive ? " active" : "");
    btn.textContent = area;
    btn.addEventListener("click", () => {
      state.includedSheets = new Set(titles);
      if (!titles.includes(state.activeDetailSheet)) {
        state.activeDetailSheet = titles[0];
      }
      state.report.area = area;
      state.report.remainingColumn = null;
      state.report.tossupColumn = null;
      state.report.appoColumn = null;
      state.report.extraColumns = new Set();
      state.report.expandedLists = new Set();
      afterIncludedSheetsChanged();
    });
    container.appendChild(btn);
  });
}

function afterIncludedSheetsChanged() {
  renderAreaSwitcher();
  renderSheetSelector();
  refreshReportControls();
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
        renderDetailSheetTabs();
        renderDetailTable();
      });
      group.appendChild(label);
    });

    container.appendChild(group);
  });
}

// ------------------------------------------------------------
// エリアレポート(残量・未コール・不在)の対象シート・列の特定
// ------------------------------------------------------------

// エリア内から「残量」を含むシート名、「リスト」を含む(残量ではない)シート名を探す
function getAreaSheetPair(area) {
  const areaMap = groupSheetsByArea();
  const titles = areaMap.get(area) || [];
  const remainingSheet = titles.find((t) => t.includes("残量")) || null;
  const listSheet = titles.find((t) => t !== remainingSheet && t.includes("リスト")) || null;
  return { listSheet, remainingSheet };
}

// 指定シートの中から、リスト名・都道府県以外の列名一覧を返す
function getOtherColumnNames(title, { numericOnly } = {}) {
  if (!title || !state.sheets[title]) return [];
  const { headers } = state.sheets[title];
  const names = [];
  headers.forEach((h, idx) => {
    if (idx === CONFIG.listNameColumnIndex || idx === CONFIG.prefectureColumnIndex) return;
    if (numericOnly && detectColumnType(title, idx).type !== "numeric") return;
    names.push(h);
  });
  return names;
}

// 候補名を順に探し、なければ「含む」で探す(除外語を含むものは除く)。見つからなければnull。
function pickDefaultColumn(options, exactCandidates, containsCandidates, excludeSubstrings) {
  for (const name of exactCandidates) {
    if (options.includes(name)) return name;
  }
  for (const opt of options) {
    if (excludeSubstrings && excludeSubstrings.some((ex) => opt.includes(ex))) continue;
    if (containsCandidates.some((c) => opt.includes(c))) return opt;
  }
  return null;
}

// 残量として使う列・トスアップ率/アポ率の分子として使う列を自動判定して state.report に反映する
// (手動での列選択UIは廃止し、常に自動判定のみを行う)
function refreshReportControls() {
  const area = state.report.area;
  const { listSheet, remainingSheet } = getAreaSheetPair(area);

  // 残量として使う列(「残量」という名前の列があればそれを、無ければ最初の数値列を使う)
  const remainingOptions = getOtherColumnNames(remainingSheet, { numericOnly: true });
  state.report.remainingColumn =
    remainingOptions.length === 0 ? null : remainingOptions.includes("残量") ? "残量" : remainingOptions[0];

  // トスアップ率・アポ率の分子として使う列(リストデータ側、自動判定。見つからなければ「—」表示になる)
  const listNumericOptions = getOtherColumnNames(listSheet, { numericOnly: true });
  state.report.tossupColumn = pickDefaultColumn(listNumericOptions, ["トスアップ"], ["トスアップ"], []) || "";
  state.report.appoColumn =
    pickDefaultColumn(listNumericOptions, ["アポ", "アポイント", "アポ数", "獲得アポ"], ["アポ"], ["禁"]) || "";
  state.report.extraColumns = new Set();
}

$("#report-expand-all").addEventListener("click", () => {
  const report = computeAreaReport();
  if (!report.error) {
    state.report.expandedLists = new Set(report.listRows.map((lr) => lr.listName));
  }
  renderSummary();
});
$("#report-collapse-all").addEventListener("click", () => {
  state.report.expandedLists = new Set();
  renderSummary();
});

// 「リスト毎表示」「業種毎表示」の切り替え
function setAggMode(mode) {
  state.reportMode = mode;
  $("#agg-mode-list").classList.toggle("active", mode === "list");
  $("#agg-mode-industry").classList.toggle("active", mode === "industry");
  const showListControls = mode === "list";
  $("#report-expand-all").style.display = showListControls ? "" : "none";
  $("#report-collapse-all").style.display = showListControls ? "" : "none";
  renderSummary();
}
$("#agg-mode-list").addEventListener("click", () => setAggMode("list"));
$("#agg-mode-industry").addEventListener("click", () => setAggMode("industry"));

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

  if (!state.detailColumnWidths[title]) state.detailColumnWidths[title] = {};
  setupResizableColumns(
    table,
    headRow,
    headers.map((headerName, colIndex) => ({ key: String(colIndex), label: headerName })),
    state.detailColumnWidths[title]
  );

  panel.appendChild(wrapTableForResize(tableWrap, state.detailTableSize));

  if (rowObjs.length > MAX_RENDER) {
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = `※ 表示は先頭${MAX_RENDER}件までです。フィルタを絞り込むとより見やすくなります。`;
    panel.appendChild(note);
  }
}

// ------------------------------------------------------------
// 描画: サマリー(エリアレポート — 残量・未コール・不在)
// ------------------------------------------------------------

// null(分母0など計算不可)は「—」、それ以外は小数点1桁の%表示にする
function formatPct(value) {
  if (value === null || value === undefined || isNaN(value)) return "—";
  return `${value.toFixed(1)}%`;
}

// 追加列セルのHTML(件数の下に対有効%を小さく添える)
function extraCellHtml(count, pct) {
  return `<td class="count-cell">${count || 0} <span class="muted-inline">(${formatPct(pct)})</span></td>`;
}

// 評価の良し悪しに応じたグラデーション色(赤→オレンジ→黄緑→緑)を返す。
// badMax以下=悪い、badMax〜goodMinの間=普通、goodMin以上=良い、の3段階を滑らかにつなぐ。
// 値がnull/未計算の場合はnullを返す(色を付けない)。
function gradeColor(value, badMax, goodMin) {
  if (value === null || value === undefined || isNaN(value)) return null;
  const v = Math.max(0, Math.min(100, value));
  const anchors = [
    { v: 0, h: 0 }, // 赤(最も悪い)
    { v: badMax, h: 28 }, // オレンジ(悪いの上限)
    { v: goodMin, h: 90 }, // 黄緑(良いの下限)
    { v: 100, h: 140 }, // 緑(最も良い)
  ];
  let lo = anchors[0];
  let hi = anchors[anchors.length - 1];
  for (let i = 0; i < anchors.length - 1; i++) {
    if (v >= anchors[i].v && v <= anchors[i + 1].v) {
      lo = anchors[i];
      hi = anchors[i + 1];
      break;
    }
  }
  const span = hi.v - lo.v;
  const t = span === 0 ? 0 : (v - lo.v) / span;
  const hue = lo.h + (hi.h - lo.h) * t;
  return `hsl(${hue.toFixed(0)}, 72%, 38%)`;
}

// 有効率・トスアップ率など、評価基準(良い/普通/悪い)が決まっている割合セルのHTML。
// 文字色を評価に応じたグラデーションで表示する(値がない場合は通常表示)。
function gradedPctHtml(value, badMax, goodMin) {
  const text = formatPct(value);
  const color = gradeColor(value, badMax, goodMin);
  if (!color) return `<td class="count-cell">${text}</td>`;
  return `<td class="count-cell"><span style="color:${color}; font-weight:700;">${text}</span></td>`;
}

// 有効率の評価基準: 良い=50%以上, 普通=30%〜50%, 悪い=30%以下
const VALID_RATE_THRESHOLDS = { badMax: 30, goodMin: 50 };
// トスアップ率の評価基準: 良い=5%以上, 普通=4%〜5%, 悪い=4%以下
const TOSSUP_RATE_THRESHOLDS = { badMax: 4, goodMin: 5 };

// エリア全体ALLバー用(<b>タグに評価色を付ける)
function gradedBoldHtml(value, badMax, goodMin) {
  const text = formatPct(value);
  const color = gradeColor(value, badMax, goodMin);
  return color ? `<b style="color:${color};">${text}</b>` : `<b>${text}</b>`;
}

// 残量セルのHTML(ALL行は残量に応じたヒートマップ背景付き、都道府県内訳行は背景なし)
function remainingCellHtml(obj, maxRemaining) {
  const bg = maxRemaining === undefined ? "" : ` style="background:${heatColor(obj.remaining, maxRemaining)}"`;
  return `<td class="count-cell"${bg}>${obj.remaining}</td>`;
}

function heatColor(value, max) {
  if (!value) return "transparent";
  const ratio = Math.min(1, value / max);
  const lightness = 92 - ratio * 47; // 92% (薄い) -> 45% (濃い)
  return `hsl(6, 85%, ${lightness}%)`;
}

// 指定シートの中から、(リスト名, 都道府県)をキーに指定列の値を合算したMapを作る
function buildValueMap(title, columnNames) {
  const map = new Map();
  if (!title || !state.sheets[title] || columnNames.length === 0) return map;
  const { headers, rows } = state.sheets[title];
  const colIndexes = columnNames.map((name) => headers.indexOf(name));
  rows.forEach((cells) => {
    const listName = String(cells[CONFIG.listNameColumnIndex] ?? "");
    const pref = String(cells[CONFIG.prefectureColumnIndex] ?? "");
    if (!listName || !pref) return;
    const key = listName + SEP + pref;
    if (!map.has(key)) {
      const obj = {};
      columnNames.forEach((n) => (obj[n] = 0));
      map.set(key, obj);
    }
    const obj = map.get(key);
    columnNames.forEach((name, i) => {
      const idx = colIndexes[i];
      if (idx === -1) return;
      const v = parseFloat(cells[idx]);
      obj[name] += isNaN(v) ? 0 : v;
    });
  });
  return map;
}

// listSheetのF列〜AC列(有効結果の対象範囲)の値を、(リスト名, 都道府県)キーで合算したMapを作る
function buildValidResultMap(title, startIdx, endIdx) {
  const map = new Map();
  if (!title || !state.sheets[title]) return map;
  const { rows } = state.sheets[title];
  rows.forEach((cells) => {
    const listName = String(cells[CONFIG.listNameColumnIndex] ?? "");
    const pref = String(cells[CONFIG.prefectureColumnIndex] ?? "");
    if (!listName || !pref) return;
    const key = listName + SEP + pref;
    let sum = 0;
    for (let idx = startIdx; idx <= endIdx && idx < cells.length; idx++) {
      const v = parseFloat(cells[idx]);
      sum += isNaN(v) ? 0 : v;
    }
    map.set(key, (map.get(key) || 0) + sum);
  });
  return map;
}

// 分母が0(または無効)なら null を返す(%表示は「—」にする)
function ratioOrNull(numerator, denominator) {
  if (!denominator) return null;
  return (numerator / denominator) * 100;
}

// remaining/absent/notCalled/tossup/appo/validCount/extra が入ったオブジェクトに
// 有効率・トスアップ率・アポ率・追加列の対有効%を計算して追加する。
function computeDerived(obj, extraCols) {
  // 有効率 = 有効結果 ÷ (不在 + 有効結果)
  obj.validRate = ratioOrNull(obj.validCount, obj.absent + obj.validCount);
  obj.tossupRate = ratioOrNull(obj.tossup, obj.validCount);
  obj.appoRate = ratioOrNull(obj.appo, obj.validCount);
  obj.extraPct = {};
  extraCols.forEach((c) => {
    obj.extraPct[c] = ratioOrNull(obj.extra[c], obj.validCount);
  });
  // 不在2 = 不在 − 残量
  obj.absent2 = obj.absent - obj.remaining;
  return obj;
}

function computeAreaReport() {
  const area = state.report.area;
  if (!area) return { error: "エリアがありません" };

  const { listSheet, remainingSheet } = getAreaSheetPair(area);
  if (!listSheet && !remainingSheet) {
    return { error: `エリア「${area}」に「リストデータ」または「残量」という名前のシートが見つかりません` };
  }

  const remainingCol = state.report.remainingColumn;
  const absentCol = state.report.absentColumn;
  const notCalledCol = state.report.notCalledColumn;
  const tossupCol = state.report.tossupColumn || null;
  const appoCol = state.report.appoColumn || null;
  const extraCols = Array.from(state.report.extraColumns);

  const listColumnsNeeded = new Set([absentCol, notCalledCol, ...extraCols]);
  if (tossupCol) listColumnsNeeded.add(tossupCol);
  if (appoCol) listColumnsNeeded.add(appoCol);

  const remainingMap = remainingCol ? buildValueMap(remainingSheet, [remainingCol]) : new Map();
  const listMap = buildValueMap(listSheet, Array.from(listColumnsNeeded));
  const validResultMap = buildValidResultMap(listSheet, VALID_RESULT_COL_START, VALID_RESULT_COL_END);

  const allKeys = new Set([...remainingMap.keys(), ...listMap.keys(), ...validResultMap.keys()]);
  const byList = new Map(); // listName -> Map(pref -> {remaining, absent, notCalled, tossup, appo, validCount, extra})

  allKeys.forEach((key) => {
    const [listName, pref] = key.split(SEP);
    if (!byList.has(listName)) byList.set(listName, new Map());
    const remaining = remainingMap.get(key)?.[remainingCol] || 0;
    const absent = listMap.get(key)?.[absentCol] || 0;
    const notCalled = listMap.get(key)?.[notCalledCol] || 0;
    const tossup = tossupCol ? listMap.get(key)?.[tossupCol] || 0 : 0;
    const appo = appoCol ? listMap.get(key)?.[appoCol] || 0 : 0;
    const validCount = validResultMap.get(key) || 0;
    const extra = {};
    extraCols.forEach((c) => (extra[c] = listMap.get(key)?.[c] || 0));
    byList.get(listName).set(pref, { remaining, absent, notCalled, tossup, appo, validCount, extra });
  });

  const listRows = [];
  byList.forEach((prefMap, listName) => {
    const all = { remaining: 0, absent: 0, notCalled: 0, tossup: 0, appo: 0, validCount: 0, extra: {} };
    extraCols.forEach((c) => (all.extra[c] = 0));
    prefMap.forEach((v) => {
      computeDerived(v, extraCols);
      all.remaining += v.remaining;
      all.absent += v.absent;
      all.notCalled += v.notCalled;
      all.tossup += v.tossup;
      all.appo += v.appo;
      all.validCount += v.validCount;
      extraCols.forEach((c) => (all.extra[c] += v.extra[c]));
    });
    computeDerived(all, extraCols);
    const prefRows = Array.from(prefMap.entries())
      .map(([pref, v]) => ({ pref, ...v }))
      .sort((a, b) => a.pref.localeCompare(b.pref, "ja"));
    listRows.push({ listName, all, prefRows });
  });

  const grand = { remaining: 0, absent: 0, notCalled: 0, tossup: 0, appo: 0, validCount: 0, extra: {} };
  extraCols.forEach((c) => (grand.extra[c] = 0));
  listRows.forEach((lr) => {
    grand.remaining += lr.all.remaining;
    grand.absent += lr.all.absent;
    grand.notCalled += lr.all.notCalled;
    grand.tossup += lr.all.tossup;
    grand.appo += lr.all.appo;
    grand.validCount += lr.all.validCount;
    extraCols.forEach((c) => (grand.extra[c] += lr.all.extra[c]));
  });
  computeDerived(grand, extraCols);

  const sortKey = state.report.sort.key;
  const dirMul = state.report.sort.dir === "asc" ? 1 : -1;
  const simpleKeys = ["remaining", "notCalled", "absent", "absent2", "validRate", "tossupRate", "appoRate"];
  // 残量が同数の場合の自動タイブレーク順(残量でソートしている時だけ適用)
  const TIE_BREAK_KEYS = ["validRate", "tossupRate", "appoRate"];
  const compareBy = (key, a, b) => {
    let av, bv;
    if (simpleKeys.includes(key)) {
      av = a.all[key];
      bv = b.all[key];
    } else {
      av = a.all.extra[key] || 0;
      bv = b.all.extra[key] || 0;
    }
    av = av === null || av === undefined ? -Infinity : av;
    bv = bv === null || bv === undefined ? -Infinity : bv;
    return (av - bv) * dirMul;
  };
  listRows.sort((a, b) => {
    if (sortKey === "listName") return a.listName.localeCompare(b.listName, "ja") * dirMul;
    let diff = compareBy(sortKey, a, b);
    if (diff !== 0) return diff;
    // 「残量」でソートしている場合、残量が同数の行は有効率→トスアップ率→アポ率の順で自動的に並び替える
    if (sortKey === "remaining") {
      for (const key of TIE_BREAK_KEYS) {
        diff = compareBy(key, a, b);
        if (diff !== 0) return diff;
      }
    }
    return 0;
  });

  return { area, listSheet, remainingSheet, listRows, grand, extraCols };
}

function toggleReportSort(key) {
  const s = state.report.sort;
  if (s.key !== key) {
    state.report.sort = { key, dir: "desc" };
  } else {
    // 同じ項目を再クリックした場合は昇順・降順を交互に切り替える(どの項目でも上限なく切替可能)
    state.report.sort = { key, dir: s.dir === "desc" ? "asc" : "desc" };
  }
  renderSummary();
}

function reportSortArrow(key) {
  if (state.report.sort.key !== key) return "";
  return state.report.sort.dir === "asc" ? " ▲" : " ▼";
}

// ------------------------------------------------------------
// 業種毎表示(残量シートのE列以降=業種ごとの残量内訳を集計)
// ------------------------------------------------------------

// 残量シートの中で「業種」として扱う列(E列(0始まりで4)〜最後から2番目の列。
// 一番後ろの列は業種横断の合計値のため業種としては扱わない)
function getIndustryColumnRange(headers) {
  const start = 4;
  const end = headers.length - 2;
  return { start, end };
}

function computeIndustryReport() {
  const area = state.report.area;
  if (!area) return { error: "エリアがありません" };
  const { remainingSheet } = getAreaSheetPair(area);
  if (!remainingSheet || !state.sheets[remainingSheet]) {
    return { error: `エリア「${area}」に「残量」という名前のシートが見つかりません` };
  }
  const { headers, rows } = state.sheets[remainingSheet];
  const { start, end } = getIndustryColumnRange(headers);
  if (end < start) {
    return { error: `「${remainingSheet}」に業種ごとの内訳列(E列以降)が見つかりません` };
  }

  const industryNames = [];
  for (let i = start; i <= end; i++) {
    if (headers[i]) industryNames.push(headers[i]);
  }
  const totals = new Map(industryNames.map((n) => [n, 0]));

  rows.forEach((cells) => {
    const listName = String(cells[CONFIG.listNameColumnIndex] ?? "");
    const pref = String(cells[CONFIG.prefectureColumnIndex] ?? "");
    if (!listName || !pref) return;
    for (let i = start; i <= end; i++) {
      const name = headers[i];
      if (!name) continue;
      const v = parseFloat(cells[i]);
      if (isNaN(v)) continue;
      totals.set(name, (totals.get(name) || 0) + v);
    }
  });

  const sortKey = state.report.industrySort.key;
  const dirMul = state.report.industrySort.dir === "asc" ? 1 : -1;
  const industryRows = industryNames.map((name) => ({ name, remaining: totals.get(name) || 0 }));
  industryRows.sort((a, b) => {
    if (sortKey === "name") return a.name.localeCompare(b.name, "ja") * dirMul;
    return (a.remaining - b.remaining) * dirMul;
  });

  const grandTotal = industryRows.reduce((sum, r) => sum + r.remaining, 0);
  return { area, remainingSheet, rows: industryRows, grandTotal };
}

function toggleIndustrySort(key) {
  const s = state.report.industrySort;
  if (s.key !== key) {
    state.report.industrySort = { key, dir: "desc" };
  } else {
    state.report.industrySort = { key, dir: s.dir === "desc" ? "asc" : "desc" };
  }
  renderSummary();
}

function industrySortArrow(key) {
  if (state.report.industrySort.key !== key) return "";
  return state.report.industrySort.dir === "asc" ? " ▲" : " ▼";
}

function renderIndustryReport(panel) {
  const report = computeIndustryReport();
  if (report.error) {
    panel.innerHTML = `<p class="muted">${escapeHtml(report.error)}</p>`;
    return;
  }
  const { rows, grandTotal } = report;
  if (rows.length === 0) {
    panel.innerHTML = `<p class="muted">業種ごとの内訳データが見つかりませんでした(残量シートのE列以降を確認してください)</p>`;
    return;
  }

  const grandBar = document.createElement("div");
  grandBar.className = "grand-total-bar";
  grandBar.innerHTML =
    `<span class="grand-label">${escapeHtml(state.report.area)} 業種別 残量合計</span>` +
    `<span>残量 <b>${grandTotal}</b></span>`;
  panel.appendChild(grandBar);

  const maxRemaining = Math.max(1, ...rows.map((r) => r.remaining));

  const tableWrap = document.createElement("div");
  tableWrap.className = "table-scroll";
  const table = document.createElement("table");
  table.className = "pivot-table report-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const columns = [
    { key: "name", label: "業種" },
    { key: "remaining", label: "残量" },
  ];
  columns.forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h.label + industrySortArrow(h.key);
    th.className = "sortable";
    th.addEventListener("click", () => toggleIndustrySort(h.key));
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="pref-cell">${escapeHtml(r.name)}</td>` +
      `<td class="count-cell" style="background:${heatColor(r.remaining, maxRemaining)}">${r.remaining}</td>`;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  tableWrap.appendChild(table);

  setupResizableColumns(table, headRow, columns, state.report.industryColumnWidths);
  panel.appendChild(wrapTableForResize(tableWrap, state.report.industryTableSize));
}

function renderSummary() {
  const panel = $("#summary-panel");
  panel.innerHTML = "";
  if (!state.loaded) return;

  if (state.reportMode === "industry") {
    renderIndustryReport(panel);
    return;
  }

  const report = computeAreaReport();
  if (report.error) {
    panel.innerHTML = `<p class="muted">${escapeHtml(report.error)}</p>`;
    return;
  }
  const { listRows, grand, extraCols } = report;

  if (!state.report.remainingColumn) {
    panel.innerHTML = `<p class="muted">残量シートに数値列が見つかりませんでした</p>`;
    return;
  }

  // --- エリア全体のALL ---
  const grandBar = document.createElement("div");
  grandBar.className = "grand-total-bar";
  grandBar.innerHTML =
    `<span class="grand-label">${escapeHtml(state.report.area)} ALL</span>` +
    `<span>残量 <b>${grand.remaining}</b></span>` +
    `<span>未コール <b>${grand.notCalled}</b></span>` +
    `<span>不在 <b>${grand.absent}</b></span>` +
    `<span>不在2 <b>${grand.absent2}</b></span>` +
    `<span>有効結果 <b>${grand.validCount}</b></span>` +
    `<span>有効率 ${gradedBoldHtml(grand.validRate, VALID_RATE_THRESHOLDS.badMax, VALID_RATE_THRESHOLDS.goodMin)}</span>` +
    `<span>トスアップ率 ${gradedBoldHtml(grand.tossupRate, TOSSUP_RATE_THRESHOLDS.badMax, TOSSUP_RATE_THRESHOLDS.goodMin)}</span>` +
    `<span>アポ率 <b>${formatPct(grand.appoRate)}</b></span>`;
  panel.appendChild(grandBar);

  if (listRows.length === 0) {
    panel.innerHTML += `<p class="muted">データがありません</p>`;
    return;
  }

  const maxRemaining = Math.max(1, ...listRows.map((r) => r.all.remaining));

  const tableWrap = document.createElement("div");
  tableWrap.className = "table-scroll";
  const table = document.createElement("table");
  table.className = "pivot-table report-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const headers = [
    { key: "listName", label: "リスト名" },
    { key: "pref", label: "都道府県" },
    { key: "remaining", label: "残量" },
    { key: "notCalled", label: "未コール" },
    { key: "absent", label: "不在" },
    { key: "absent2", label: "不在2" },
    { key: "validRate", label: "有効率" },
    { key: "tossupRate", label: "トスアップ率" },
    { key: "appoRate", label: "アポ率" },
    ...extraCols.map((c) => ({ key: c, label: c })),
  ];
  headers.forEach((h) => {
    const th = document.createElement("th");
    if (h.key === "pref") {
      th.textContent = h.label;
    } else {
      th.textContent = h.label + reportSortArrow(h.key);
      th.className = "sortable";
      th.addEventListener("click", () => toggleReportSort(h.key));
    }
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  listRows.forEach((lr) => {
    const expanded = state.report.expandedLists.has(lr.listName);
    const tr = document.createElement("tr");
    tr.className = "report-all-row";
    tr.innerHTML =
      `<td class="pref-cell"><span class="row-toggle">${expanded ? "▼" : "▶"}</span>${escapeHtml(lr.listName)}</td>` +
      `<td class="pref-cell">ALL</td>` +
      remainingCellHtml(lr.all, maxRemaining) +
      `<td class="count-cell">${lr.all.notCalled}</td>` +
      `<td class="count-cell">${lr.all.absent}</td>` +
      `<td class="count-cell">${lr.all.absent2}</td>` +
      gradedPctHtml(lr.all.validRate, VALID_RATE_THRESHOLDS.badMax, VALID_RATE_THRESHOLDS.goodMin) +
      gradedPctHtml(lr.all.tossupRate, TOSSUP_RATE_THRESHOLDS.badMax, TOSSUP_RATE_THRESHOLDS.goodMin) +
      `<td class="count-cell">${formatPct(lr.all.appoRate)}</td>` +
      extraCols.map((c) => extraCellHtml(lr.all.extra[c], lr.all.extraPct[c])).join("");
    tr.addEventListener("click", () => {
      if (expanded) state.report.expandedLists.delete(lr.listName);
      else state.report.expandedLists.add(lr.listName);
      renderSummary();
    });
    tbody.appendChild(tr);

    if (expanded) {
      lr.prefRows.forEach((pr) => {
        const subTr = document.createElement("tr");
        subTr.className = "report-pref-row";
        subTr.innerHTML =
          `<td class="pref-cell"></td>` +
          `<td class="pref-cell">${escapeHtml(pr.pref)}</td>` +
          remainingCellHtml(pr) +
          `<td class="count-cell">${pr.notCalled}</td>` +
          `<td class="count-cell">${pr.absent}</td>` +
          `<td class="count-cell">${pr.absent2}</td>` +
          gradedPctHtml(pr.validRate, VALID_RATE_THRESHOLDS.badMax, VALID_RATE_THRESHOLDS.goodMin) +
          gradedPctHtml(pr.tossupRate, TOSSUP_RATE_THRESHOLDS.badMax, TOSSUP_RATE_THRESHOLDS.goodMin) +
          `<td class="count-cell">${formatPct(pr.appoRate)}</td>` +
          extraCols.map((c) => extraCellHtml(pr.extra[c], pr.extraPct[c])).join("");
        tbody.appendChild(subTr);
      });
    }
  });
  table.appendChild(tbody);
  tableWrap.appendChild(table);

  setupResizableColumns(table, headRow, headers, state.report.columnWidths);

  panel.appendChild(wrapTableForResize(tableWrap, state.report.tableSize));

  const note = document.createElement("p");
  note.className = "muted";
  note.textContent =
    "行はリスト名単位(ALL=そのエリア内の全都道府県合計)。行をクリックすると都道府県別の内訳を開閉できます。未コール = リストデータの「未コール」列の値。不在2 = 不在 − 残量。" +
    "有効結果 = リストデータのF列〜AC列(繋がった結果)の合計。有効率 = 有効結果 ÷ (不在 + 有効結果)。" +
    "トスアップ率・アポ率・追加列の(%)はすべて対有効(÷有効結果)。" +
    "列見出しクリックで昇順・降順に並び替えできます(どの項目でも切替可能)。既定(残量順)の並びでは、残量が同数の行を有効率→トスアップ率→アポ率の順で自動的に並び替えます。" +
    "有効率(良い:50%以上/普通:30〜50%/悪い:30%以下)・トスアップ率(良い:5%以上/普通:4〜5%/悪い:4%以下)は評価に応じて文字色を赤〜緑のグラデーションで表示します。";
  panel.appendChild(note);
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

// ------------------------------------------------------------
// 表のリサイズ
// 1) 表全体の「高さ」だけを下端のバーをドラッグして変更(マウス/タッチ両対応)
// 2) 各列の「幅」を列見出しの右端をドラッグして個別に変更(マウス/タッチ両対応)
// ------------------------------------------------------------

// wrapEl: 高さリサイズ用のバーを置く外側の要素(スクロールしない)
// sizedEl: 実際にheightを変更する要素(.table-scroll。スクロール自体はこちらが担当)
// sizeState: { height } を保持するオブジェクト(再描画をまたいでサイズを覚えておくため)
function attachHeightResizeHandle(wrapEl, sizedEl, sizeState) {
  const handle = document.createElement("div");
  handle.className = "table-resize-handle";
  handle.title = "ドラッグして表の高さを変更";
  wrapEl.appendChild(handle);

  let startY = 0;
  let startH = 0;

  function onPointerMove(e) {
    const dy = e.clientY - startY;
    const minH = 160;
    const maxH = Math.round(window.innerHeight * 0.85);
    const newH = Math.max(minH, Math.min(maxH, Math.round(startH + dy)));
    sizeState.height = newH;
    sizedEl.style.height = `${newH}px`;
    sizedEl.style.maxHeight = "none";
    if (e.cancelable) e.preventDefault();
  }
  function onPointerUp() {
    wrapEl.classList.remove("resizing");
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  }
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    startY = e.clientY;
    startH = sizedEl.getBoundingClientRect().height;
    wrapEl.classList.add("resizing");
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  });
}

// 保存済みの高さ(sizeState.height)を要素に適用する(再描画のたびに呼び出して復元する)
function applyStoredHeight(sizedEl, sizeState) {
  if (sizeState.height) {
    sizedEl.style.height = `${sizeState.height}px`;
    sizedEl.style.maxHeight = "none";
  }
}

// table-scroll(スクロール領域)を、高さリサイズ用の外枠で包んで返す
function wrapTableForResize(tableWrap, sizeState) {
  applyStoredHeight(tableWrap, sizeState);
  const resizeWrap = document.createElement("div");
  resizeWrap.className = "table-resize-wrap";
  resizeWrap.appendChild(tableWrap);
  attachHeightResizeHandle(resizeWrap, tableWrap, sizeState);
  return resizeWrap;
}

// 列名の文字数から初期の列幅(px)を概算する(あくまで初期値。ドラッグでいつでも調整可能)
function defaultColWidth(label) {
  const len = String(label).length;
  return Math.max(70, Math.min(220, len * 9 + 40));
}

// 表をtable-layout:fixedにして、各列(<col>)に幅を設定し、列見出しの右端に
// ドラッグ用ハンドルを取り付けて列幅を個別に変更できるようにする。
// columns: [{ key, label }] の配列(表示順、theadの<th>の並びと対応させること)
// widthsState: { [key]: px } 変更後の幅を保存しておくオブジェクト(再描画をまたいで記憶する)
// theadRow: 見出し行の<tr>要素(子として<th>がcolumnsと同じ順番で並んでいること)
function setupResizableColumns(table, theadRow, columns, widthsState) {
  const colgroup = document.createElement("colgroup");
  const colEls = columns.map((col) => {
    const c = document.createElement("col");
    const w = widthsState[col.key] || defaultColWidth(col.label);
    widthsState[col.key] = w;
    c.style.width = `${w}px`;
    colgroup.appendChild(c);
    return c;
  });
  table.insertBefore(colgroup, table.firstChild);

  function updateTableWidth() {
    const total = columns.reduce((sum, col) => sum + (widthsState[col.key] || 0), 0);
    table.style.width = `${total}px`;
  }
  updateTableWidth();

  const ths = Array.from(theadRow.children);
  columns.forEach((col, i) => {
    const th = ths[i];
    if (!th) return;
    const grip = document.createElement("span");
    grip.className = "col-resize-handle";
    grip.title = "ドラッグして列幅を変更";
    grip.addEventListener("click", (e) => e.stopPropagation());
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = widthsState[col.key] || defaultColWidth(col.label);
      grip.classList.add("resizing");

      function onMove(ev) {
        const dx = ev.clientX - startX;
        const newW = Math.max(50, Math.round(startW + dx));
        widthsState[col.key] = newW;
        colEls[i].style.width = `${newW}px`;
        updateTableWidth();
      }
      function onUp() {
        grip.classList.remove("resizing");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
    th.appendChild(grip);
  });
}

$("#refresh-btn").addEventListener("click", loadAll);

initTabs();
loadAll();
