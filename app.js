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
