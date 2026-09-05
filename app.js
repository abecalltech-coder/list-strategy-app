// ============================================================
// リスト戦略システム — メインロジック
// 列名・列数・行数がシートごとに変わっても動くよう、
// ヘッダー行(1行目)を都度読み取って動的にUIを組み立てます。
// ============================================================
"use strict";

const CONFIG = window.APP_CONFIG;

// 「有効」の定義: リストデータシートの中で、以下の項目名の合計数を「有効数」とする。
// トスアップ率・アポ率・追加列の％はすべてこの「有効数」に対する割合(対有効)として計算する。
const VALID_COLUMNS = [
  "現アナ", "決裁者不在", "アプローチNG", "主旨NG", "クロージングNG", "電気NG", "SMSNG",
  "見込みC", "見込みC(不在)", "見込みB", "見込みB(不在)", "見込みA", "見込みA(不在)",
  "19時以降対応案件", "土日架電希望案件",
  "対象外(既契約)", "対象外(建物管理)", "対象外(本社管理)", "対象外(オール電化・太陽光等)", "対象外(高圧)", "対象外(その他)",
  "アポ禁",
];

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
  report: {
    area: null,
    splitByPrefecture: true,
    remainingColumn: null, // 残量シートの中で「残量」として使う列名
    absentColumn: "不在", // リストデータシートの中で「不在」として使う列名
    totalColumn: null, // 有効率の分母(リスト累計数)として使う列名。null=未初期化, ""=未選択, 文字列=列名
    tossupColumn: null, // トスアップ率の分子として使う列名
    appoColumn: null, // アポ率の分子として使う列名
    extraColumns: new Set(), // リストデータから追加表示する列名
    sort: { key: "remaining", dir: "desc" },
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
      state.report.totalColumn = null;
      state.report.tossupColumn = null;
      state.report.appoColumn = null;
      state.report.extraColumns = new Set();
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

// 「(未選択)」を選べる任意項目用のセレックスを描画する。
// currentValue: null=未初期化(自動推定する) / ""=ユーザーが明示的に未選択にした / 文字列=列名
function populateOptionalColumnSelect(selectEl, options, currentValue, defaultValue) {
  const opts = ['<option value="">(未選択)</option>'].concat(
    options.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`)
  );
  selectEl.innerHTML = opts.join("");
  let keep = currentValue;
  if (keep && !options.includes(keep)) keep = null; // 選んでいた列が無くなった -> 再推定
  if (keep === null) keep = defaultValue || "";
  selectEl.value = keep;
  return keep;
}

function refreshReportControls() {
  const area = state.report.area;
  const { listSheet, remainingSheet } = getAreaSheetPair(area);

  // 残量として使う列
  const remainingSelect = $("#report-remaining-column");
  const remainingOptions = getOtherColumnNames(remainingSheet, { numericOnly: true });
  if (remainingOptions.length === 0) {
    remainingSelect.innerHTML = `<option value="">(数値列なし)</option>`;
    remainingSelect.disabled = true;
    state.report.remainingColumn = null;
  } else {
    remainingSelect.disabled = false;
    remainingSelect.innerHTML = remainingOptions.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("");
    let keep = state.report.remainingColumn;
    if (!remainingOptions.includes(keep)) {
      keep = remainingOptions.includes("残量") ? "残量" : remainingOptions[0];
    }
    remainingSelect.value = keep;
    state.report.remainingColumn = keep;
  }

  // 有効率の分母(リスト累計数)・トスアップ率の分子・アポ率の分子として使う列(リストデータ側)
  const listNumericOptions = getOtherColumnNames(listSheet, { numericOnly: true });

  const totalDefault = pickDefaultColumn(listNumericOptions, ["累計数", "累計", "合計"], ["累計", "合計"], []);
  state.report.totalColumn = populateOptionalColumnSelect(
    $("#report-total-column"), listNumericOptions, state.report.totalColumn, totalDefault
  );

  const tossupDefault = pickDefaultColumn(listNumericOptions, ["トスアップ"], ["トスアップ"], []);
  state.report.tossupColumn = populateOptionalColumnSelect(
    $("#report-tossup-column"), listNumericOptions, state.report.tossupColumn, tossupDefault
  );

  const appoDefault = pickDefaultColumn(listNumericOptions, ["アポ", "アポイント", "アポ数", "獲得アポ"], ["アポ"], ["禁"]);
  state.report.appoColumn = populateOptionalColumnSelect(
    $("#report-appo-column"), listNumericOptions, state.report.appoColumn, appoDefault
  );

  // 表示する追加列(リストデータの列。「不在」は固定表示のため除外)
  const extraContainer = $("#report-extra-columns");
  const extraOptions = listNumericOptions.filter((n) => n !== state.report.absentColumn);
  extraContainer.innerHTML = "";
  extraOptions.forEach((name) => {
    const label = document.createElement("label");
    label.className = "cat-option";
    const checked = state.report.extraColumns.has(name);
    label.innerHTML = `<input type="checkbox" ${checked ? "checked" : ""}/> <span>${escapeHtml(name)}</span>`;
    label.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) state.report.extraColumns.add(name);
      else state.report.extraColumns.delete(name);
      renderSummary();
    });
    extraContainer.appendChild(label);
  });
}

$("#report-split-pref").addEventListener("change", (e) => {
  state.report.splitByPrefecture = e.target.checked;
  renderSummary();
});
$("#report-remaining-column").addEventListener("change", (e) => {
  state.report.remainingColumn = e.target.value;
  renderSummary();
});
$("#report-total-column").addEventListener("change", (e) => {
  state.report.totalColumn = e.target.value;
  renderSummary();
});
$("#report-tossup-column").addEventListener("change", (e) => {
  state.report.tossupColumn = e.target.value;
  renderSummary();
});
$("#report-appo-column").addEventListener("change", (e) => {
  state.report.appoColumn = e.target.value;
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

// 分母が0(または無効)なら null を返す(%表示は「—」にする)
function ratioOrNull(numerator, denominator) {
  if (!denominator) return null;
  return (numerator / denominator) * 100;
}

// remaining/absent/notCalled/total/tossup/appo/validCount/extra が入ったオブジェクトに
// 有効率・トスアップ率・アポ率・追加列の対有効%を計算して追加する。
function computeDerived(obj, extraCols) {
  obj.validRate = ratioOrNull(obj.remaining, obj.total);
  obj.tossupRate = ratioOrNull(obj.tossup, obj.validCount);
  obj.appoRate = ratioOrNull(obj.appo, obj.validCount);
  obj.extraPct = {};
  extraCols.forEach((c) => {
    obj.extraPct[c] = ratioOrNull(obj.extra[c], obj.validCount);
  });
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
  const totalCol = state.report.totalColumn || null;
  const tossupCol = state.report.tossupColumn || null;
  const appoCol = state.report.appoColumn || null;
  const extraCols = Array.from(state.report.extraColumns);

  const listHeaders = listSheet && state.sheets[listSheet] ? state.sheets[listSheet].headers : [];
  const validColsPresent = VALID_COLUMNS.filter((name) => listHeaders.includes(name));

  const listColumnsNeeded = new Set([absentCol, ...validColsPresent, ...extraCols]);
  if (totalCol) listColumnsNeeded.add(totalCol);
  if (tossupCol) listColumnsNeeded.add(tossupCol);
  if (appoCol) listColumnsNeeded.add(appoCol);

  const remainingMap = remainingCol ? buildValueMap(remainingSheet, [remainingCol]) : new Map();
  const listMap = buildValueMap(listSheet, Array.from(listColumnsNeeded));

  const allKeys = new Set([...remainingMap.keys(), ...listMap.keys()]);
  const byList = new Map(); // listName -> Map(pref -> {remaining, absent, notCalled, total, tossup, appo, validCount, extra})

  allKeys.forEach((key) => {
    const [listName, pref] = key.split(SEP);
    if (!byList.has(listName)) byList.set(listName, new Map());
    const remaining = remainingMap.get(key)?.[remainingCol] || 0;
    const absent = listMap.get(key)?.[absentCol] || 0;
    const notCalled = remaining - absent;
    const total = totalCol ? listMap.get(key)?.[totalCol] || 0 : 0;
    const tossup = tossupCol ? listMap.get(key)?.[tossupCol] || 0 : 0;
    const appo = appoCol ? listMap.get(key)?.[appoCol] || 0 : 0;
    let validCount = 0;
    validColsPresent.forEach((c) => {
      validCount += listMap.get(key)?.[c] || 0;
    });
    const extra = {};
    extraCols.forEach((c) => (extra[c] = listMap.get(key)?.[c] || 0));
    byList.get(listName).set(pref, { remaining, absent, notCalled, total, tossup, appo, validCount, extra });
  });

  const listRows = [];
  byList.forEach((prefMap, listName) => {
    const all = { remaining: 0, absent: 0, notCalled: 0, total: 0, tossup: 0, appo: 0, validCount: 0, extra: {} };
    extraCols.forEach((c) => (all.extra[c] = 0));
    prefMap.forEach((v) => {
      computeDerived(v, extraCols);
      all.remaining += v.remaining;
      all.absent += v.absent;
      all.notCalled += v.notCalled;
      all.total += v.total;
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

  const grand = { remaining: 0, absent: 0, notCalled: 0, total: 0, tossup: 0, appo: 0, validCount: 0, extra: {} };
  extraCols.forEach((c) => (grand.extra[c] = 0));
  listRows.forEach((lr) => {
    grand.remaining += lr.all.remaining;
    grand.absent += lr.all.absent;
    grand.notCalled += lr.all.notCalled;
    grand.total += lr.all.total;
    grand.tossup += lr.all.tossup;
    grand.appo += lr.all.appo;
    grand.validCount += lr.all.validCount;
    extraCols.forEach((c) => (grand.extra[c] += lr.all.extra[c]));
  });
  computeDerived(grand, extraCols);

  const sortKey = state.report.sort.key;
  const dirMul = state.report.sort.dir === "asc" ? 1 : -1;
  const simpleKeys = ["remaining", "notCalled", "absent", "validRate", "tossupRate", "appoRate"];
  listRows.sort((a, b) => {
    if (sortKey === "listName") return a.listName.localeCompare(b.listName, "ja") * dirMul;
    let av, bv;
    if (simpleKeys.includes(sortKey)) {
      av = a.all[sortKey];
      bv = b.all[sortKey];
      av = av === null || av === undefined ? -Infinity : av;
      bv = bv === null || bv === undefined ? -Infinity : bv;
    } else {
      av = a.all.extra[sortKey] || 0;
      bv = b.all.extra[sortKey] || 0;
    }
    return (av - bv) * dirMul;
  });

  return { area, listSheet, remainingSheet, listRows, grand, extraCols };
}

function toggleReportSort(key) {
  const s = state.report.sort;
  if (s.key !== key) {
    state.report.sort = { key, dir: "desc" };
  } else if (s.dir === "desc") {
    state.report.sort = { key, dir: "asc" };
  } else {
    state.report.sort = { key: "remaining", dir: "desc" };
  }
  renderSummary();
}

function reportSortArrow(key) {
  if (state.report.sort.key !== key) return "";
  return state.report.sort.dir === "asc" ? " ▲" : " ▼";
}

function renderSummary() {
  const panel = $("#summary-panel");
  panel.innerHTML = "";
  if (!state.loaded) return;

  const report = computeAreaReport();
  if (report.error) {
    panel.innerHTML = `<p class="muted">${escapeHtml(report.error)}</p>`;
    return;
  }
  const { listRows, grand, extraCols } = report;

  if (!state.report.remainingColumn) {
    panel.innerHTML = `<p class="muted">上の「残量として使う列」を選択してください(残量シートに数値列が見つかりませんでした)</p>`;
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
    `<span>有効数 <b>${grand.validCount}</b></span>` +
    `<span>有効率 <b>${formatPct(grand.validRate)}</b></span>` +
    `<span>トスアップ率 <b>${formatPct(grand.tossupRate)}</b></span>` +
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
    const tr = document.createElement("tr");
    tr.className = "report-all-row";
    tr.innerHTML =
      `<td class="pref-cell">${escapeHtml(lr.listName)}</td>` +
      `<td class="pref-cell">ALL</td>` +
      `<td class="count-cell" style="background:${heatColor(lr.all.remaining, maxRemaining)}">${lr.all.remaining}</td>` +
      `<td class="count-cell">${lr.all.notCalled}</td>` +
      `<td class="count-cell">${lr.all.absent}</td>` +
      `<td class="count-cell">${formatPct(lr.all.validRate)}</td>` +
      `<td class="count-cell">${formatPct(lr.all.tossupRate)}</td>` +
      `<td class="count-cell">${formatPct(lr.all.appoRate)}</td>` +
      extraCols.map((c) => extraCellHtml(lr.all.extra[c], lr.all.extraPct[c])).join("");
    tbody.appendChild(tr);

    if (state.report.splitByPrefecture) {
      lr.prefRows.forEach((pr) => {
        const subTr = document.createElement("tr");
        subTr.className = "report-pref-row";
        subTr.innerHTML =
          `<td class="pref-cell"></td>` +
          `<td class="pref-cell">${escapeHtml(pr.pref)}</td>` +
          `<td class="count-cell">${pr.remaining}</td>` +
          `<td class="count-cell">${pr.notCalled}</td>` +
          `<td class="count-cell">${pr.absent}</td>` +
          `<td class="count-cell">${formatPct(pr.validRate)}</td>` +
          `<td class="count-cell">${formatPct(pr.tossupRate)}</td>` +
          `<td class="count-cell">${formatPct(pr.appoRate)}</td>` +
          extraCols.map((c) => extraCellHtml(pr.extra[c], pr.extraPct[c])).join("");
        tbody.appendChild(subTr);
      });
    }
  });
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  panel.appendChild(tableWrap);

  const note = document.createElement("p");
  note.className = "muted";
  note.textContent =
    "行はリスト名(ALL=そのエリア内の全都道府県合計)。未コール = 残量 − 不在。有効率 = 残量 ÷ リスト累計数(上の「リスト累計数として使う列」)。" +
    "有効数 = 現アナ・決裁者不在・各種NG・見込みA/B/C・対象外各種・アポ禁など21項目の合計。トスアップ率・アポ率・追加列の(%)はすべて対有効(÷有効数)。" +
    "列見出しクリックでALL行を並び替えできます。";
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

$("#refresh-btn").addEventListener("click", loadAll);

initTabs();
loadAll();
