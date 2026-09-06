// ============================================================
// リスト戦略システム — メインロジック
// 列名・列数・行数がシートごとに変わっても動くよう、
// ヘッダー行(1行目)を都度読み取って動的にUIを組み立てます。
// ============================================================
"use strict";

const CONFIG = window.APP_CONFIG;

// 「有効結果」は現在、項目の定義設定(列名ベース、ユーザーが変更可能)で計算される。
// 以下の2つは、初回起動時にまだ設定が無い場合だけ使う初期値の目安(リストデータシートの
// F列〜AC列、0始まりの列インデックスで5〜28)。一度でも設定を保存すると使われなくなる。
// トスアップ率・アポ率・アプローチNG率・主旨NG率・クロージングNG率は
// すべてこの「有効結果」に対する割合(対有効)として計算する。
// 有効率 = 有効結果 ÷ (不在 + 有効結果)。
const VALID_RESULT_COL_START = 5; // F列(0始まり: A=0, B=1, C=2, D=3, E=4, F=5)
const VALID_RESULT_COL_END = 28; // AC列(0始まり: ... Z=25, AA=26, AB=27, AC=28)

// 残量系の内訳は「【エリア】業種未コール」「【エリア】業種不在1」「【エリア】業種不在2」
// 「【エリア】業種不在3以上」という4枚のシートに分かれている。各シートは従来の業種別残量シートと
// 同じ構造(業種の内訳列 + 一番後ろの「合計」列)で、その合計列がそのカテゴリの残量数になる。
// シート名に「業種」の文字を含むかどうかで判定するため、業種の内訳の列名や並び順が変わっても動く。
const CATEGORY_SHEET_DEFS = [
  { key: "notCalled", label: "未コール", match: (t) => t.includes("業種未コール") },
  { key: "absent1", label: "不在1", match: (t) => t.includes("業種不在1") || t.includes("業種不在１") },
  { key: "absent2", label: "不在2", match: (t) => t.includes("業種不在2") || t.includes("業種不在２") },
  {
    key: "absent3plus",
    label: "不在3以上",
    match: (t) => t.includes("業種不在3以上") || t.includes("業種不在３以上"),
  },
];
const CATEGORY_KEYS = CATEGORY_SHEET_DEFS.map((c) => c.key);

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
  report: {
    area: null,
    rowMode: "list", // "list"(行=リスト名) | "industry"(行=業種)
    visibleColumns: null, // 集計タブに表示する項目のキー一覧(Set)。読み込み時にlocalStorageから復元/初期化する
    sort: { key: "dialable", dir: "desc" },
    tableSize: { height: null }, // 表の手動リサイズ後の高さ(null=既定)
    columnWidths: {}, // key -> px 列ごとの幅(ドラッグで変更した分を記憶)
    rangeFilters: {}, // key -> { min, max } 表示条件(上限/下限。どちらか片方だけの指定も可)
  },
  analysis: {
    mode: "week", // "week"(週次) | "weekday"(曜日別)
    expandedLists: new Set(), // 都道府県の内訳を開いているリスト名
    sort: { key: null, dir: "desc" }, // null=既定(現在の累計が多い順)
    tableSize: { height: null },
    columnWidths: {},
  },
  strategy: {
    mode: "validRate", // "validRate"(有効率ベース) | "honshi"(主旨ベース・決裁者有効)
    cool: 1, // 選択中のクール番号(CONFIG.coolsのid)
    onlyRecommended: false, // 選択中クールにおすすめの業種のリストのみ表示するか
    tableSize: { height: null },
    columnWidths: {},
    rangeFilters: {}, // key -> { min, max } 表示条件(集計タブと同様。上限/下限どちらか片方だけの指定も可)
  },
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ------------------------------------------------------------
// 項目の数値定義(どのシートのどの列から数値を拾うか)
// ここで設定した内容は、この端末のブラウザ(localStorage)にのみ保存され、
// 他の人や他の端末とは共有されません(画面ごとに個別に設定・運用する想定)。
// ------------------------------------------------------------

// シート構成(残量シート1枚→業種別4シート)を変更したため、保存済みの設定は引き継がずv2として再度既定値から作り直す
const COLUMN_DEFS_STORAGE_KEY = "listgram.columnDefs.v2";
const CUSTOM_METRICS_STORAGE_KEY = "listgram.customMetrics.v2";
const VISIBLE_COLUMNS_STORAGE_KEY = "listgram.visibleColumns.v2";

// システム組み込みの基本項目一覧。
// source: "list"(リストデータシート) | "notCalled"/"absent1"/"absent2"/"absent3plus"(業種別の4シート)
const BASE_METRIC_KEYS = [
  { key: "notCalled", label: "未コール", source: "notCalled" },
  { key: "absent1", label: "不在1", source: "absent1" },
  { key: "absent2", label: "不在2", source: "absent2" },
  { key: "absent3plus", label: "不在3以上", source: "absent3plus" },
  { key: "validCount", label: "有効結果", source: "list" },
  { key: "tossup", label: "トスアップ", source: "list" },
  { key: "appo", label: "アポ", source: "list" },
  { key: "approachNg", label: "アプローチNG", source: "list" },
  { key: "honshiNg", label: "主旨NG", source: "list" },
  { key: "closingNg", label: "クロージングNG", source: "list" },
];

// 集計タブの表に表示できる項目(表示/非表示を選べる項目)の一覧。既定でONの項目。
// (架電可能数=未コール〜不在3以上のうち表示中の項目の合計)
const DEFAULT_VISIBLE_COLUMNS = [
  "dialable",
  "notCalled",
  "absent1",
  "absent2",
  "absent3plus",
  "validRate",
  "honshiNgRate",
  "closingNgRate",
  "tossupRate",
  "appoRate",
];

function loadFromStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}
function saveToStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    // 保存できなくても致命的ではないため無視する(プライベートブラウジング等でlocalStorageが使えない場合)
  }
}

let _columnDefsCache = null;
function getColumnDefs() {
  if (!_columnDefsCache) {
    _columnDefsCache = loadFromStorage(COLUMN_DEFS_STORAGE_KEY, null) || {};
  }
  return _columnDefsCache;
}
function saveColumnDefs(defs) {
  _columnDefsCache = defs;
  saveToStorage(COLUMN_DEFS_STORAGE_KEY, defs);
}

let _customMetricsCache = null;
function getCustomMetricDefs() {
  if (!_customMetricsCache) {
    _customMetricsCache = loadFromStorage(CUSTOM_METRICS_STORAGE_KEY, null) || [];
  }
  return _customMetricsCache;
}
function saveCustomMetricDefs(list) {
  _customMetricsCache = list;
  saveToStorage(CUSTOM_METRICS_STORAGE_KEY, list);
}

// 業種別4シート(未コール/不在1/不在2/不在3以上)それぞれの「合計」列(一番後ろの列)を、
// そのカテゴリの既定の拾い先として選ぶ(無ければ最後の数値列)
function pickCategoryDefaultColumn(title) {
  const options = getOtherColumnNames(title, { numericOnly: true });
  if (options.length === 0) return null;
  return options.includes("合計") ? "合計" : options[options.length - 1];
}

// 初回のみ、旧来の自動判定と同じロジックで初期値を作り、以降はユーザーの設定を尊重する
function ensureColumnDefsSeeded() {
  const existing = loadFromStorage(COLUMN_DEFS_STORAGE_KEY, null);
  if (existing) {
    _columnDefsCache = existing;
    return;
  }
  const listTitles = getAllSheetTitlesByType("list");
  const listSheet = listTitles[0] || null;
  const listNumericOptions = getOtherColumnNames(listSheet, { numericOnly: true });

  const tossupDefault = pickDefaultColumn(listNumericOptions, ["トスアップ"], ["トスアップ"], []);
  const appoDefault = pickDefaultColumn(listNumericOptions, ["アポ", "アポイント", "アポ数", "獲得アポ"], ["アポ"], ["禁"]);
  const approachNgDefault = pickDefaultColumn(listNumericOptions, ["アプローチNG"], ["アプローチNG", "アプローチ"], []);
  const honshiNgDefault = pickDefaultColumn(listNumericOptions, ["主旨NG"], ["主旨NG", "主旨"], []);
  const closingNgDefault = pickDefaultColumn(listNumericOptions, ["クロージングNG"], ["クロージングNG", "クロージング"], []);

  // 有効結果: 従来の「リストデータのF列〜AC列を機械的に合計」という定義を、
  // 今読み込まれている列名に変換して初期値とする(以降は列名ベースの設定として編集可能)
  let validCountColumns = [];
  if (listSheet && state.sheets[listSheet]) {
    const headers = state.sheets[listSheet].headers;
    for (let idx = VALID_RESULT_COL_START; idx <= VALID_RESULT_COL_END && idx < headers.length; idx++) {
      validCountColumns.push(headers[idx]);
    }
  }

  const defs = {};
  CATEGORY_SHEET_DEFS.forEach((c) => {
    const sheetTitle = getAllSheetTitlesByType(c.key)[0] || null;
    const col = pickCategoryDefaultColumn(sheetTitle);
    defs[c.key] = { source: c.key, op: "sum", columns: col ? [col] : [] };
  });
  defs.validCount = { source: "list", op: "sum", columns: validCountColumns };
  defs.tossup = { source: "list", op: "sum", columns: tossupDefault ? [tossupDefault] : [] };
  defs.appo = { source: "list", op: "sum", columns: appoDefault ? [appoDefault] : [] };
  defs.approachNg = { source: "list", op: "sum", columns: approachNgDefault ? [approachNgDefault] : [] };
  defs.honshiNg = { source: "list", op: "sum", columns: honshiNgDefault ? [honshiNgDefault] : [] };
  defs.closingNg = { source: "list", op: "sum", columns: closingNgDefault ? [closingNgDefault] : [] };
  saveColumnDefs(defs);
}

function ensureVisibleColumnsSeeded() {
  const saved = loadFromStorage(VISIBLE_COLUMNS_STORAGE_KEY, null);
  if (saved) {
    state.report.visibleColumns = new Set(saved);
  } else {
    state.report.visibleColumns = new Set(DEFAULT_VISIBLE_COLUMNS);
    saveToStorage(VISIBLE_COLUMNS_STORAGE_KEY, Array.from(state.report.visibleColumns));
  }
}
function saveVisibleColumns() {
  saveToStorage(VISIBLE_COLUMNS_STORAGE_KEY, Array.from(state.report.visibleColumns));
}

// source値("list"またはCATEGORY_KEYSのいずれか)から画面表示用の日本語ラベルを返す
function sourceLabel(source) {
  const cat = CATEGORY_SHEET_DEFS.find((c) => c.key === source);
  return cat ? `業種${cat.label}シート` : "リストデータシート";
}

// 演算(合計/差/割合)を適用する。values は columns の並び順に対応する数値の配列。
// 「差」「割合」はチェックした先頭2つ(1列目→2列目)を使う。
function applyMetricOp(op, values) {
  if (op === "diff") {
    return (values[0] || 0) - (values[1] || 0);
  }
  if (op === "ratio") {
    const denom = values[1] || 0;
    if (!denom) return 0;
    return (values[0] / denom) * 100;
  }
  return values.reduce((sum, v) => sum + (v || 0), 0);
}

// 指定の定義(source/op/columns)を、ソース別に集計済みの列値オブジェクトのマップ
// (valuesBySource: { list, notCalled, absent1, absent2, absent3plus } -> { 列名: 数値 })から計算する
function computeDefValue(def, valuesBySource) {
  if (!def || !def.columns || def.columns.length === 0) return 0;
  const src = (valuesBySource && valuesBySource[def.source]) || {};
  const values = def.columns.map((c) => src[c] || 0);
  return applyMetricOp(def.op, values);
}

// エリアの中から、業種別4シート(のいずれか)ではない「リスト」を含むシート名を1枚選ぶ
function pickListSheetFromTitles(titles) {
  const categoryTitles = new Set();
  CATEGORY_SHEET_DEFS.forEach((c) => {
    titles.filter((t) => c.match(t)).forEach((t) => categoryTitles.add(t));
  });
  return titles.find((t) => !categoryTitles.has(t) && t.includes("リスト")) || null;
}

// エリアをまたいで、指定タイプ("list" | CATEGORY_KEYSのいずれか)に該当する全シート名を返す
// (項目の定義設定画面で、選択できる列名の一覧を作るために使う。エリアが増えても自動的に対象になる)
function getAllSheetTitlesByType(type) {
  const areaMap = groupSheetsByArea();
  const set = new Set();
  const categoryDef = CATEGORY_SHEET_DEFS.find((c) => c.key === type);
  areaMap.forEach((titles) => {
    if (categoryDef) {
      const sheet = titles.find((t) => categoryDef.match(t)) || null;
      if (sheet) set.add(sheet);
    } else {
      const listSheet = pickListSheetFromTitles(titles);
      if (listSheet) set.add(listSheet);
    }
  });
  return Array.from(set);
}

// 指定のシート種別("list"またはCATEGORY_KEYSのいずれか)で選択可能な列名一覧(全エリア横断・重複除去)を返す
function getAvailableColumnsForSource(source) {
  const titles = getAllSheetTitlesByType(source);
  const set = new Set();
  titles.forEach((t) => {
    getOtherColumnNames(t, { numericOnly: true }).forEach((n) => set.add(n));
  });
  return Array.from(set);
}

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
    ensureColumnDefsSeeded();
    if (!state.report.visibleColumns) ensureVisibleColumnsSeeded();
    renderAreaSwitcher();
    renderSheetSelector();
    renderGlobalPrefectureFilter();
    renderColumnDefsPanel();
    renderVisibleColumnsPanel();
    renderReportRangeFilters();
    renderDetailSheetTabs();
    renderDetailTable();
    renderSummary();
    renderAnalysis();
    renderStrategyCoolSwitcher();
    renderStrategyRangeFilters();
    renderStrategy();
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

// 「トスアップログ」「要望ログ」など、リストデータではない(=B列が都道府県ではない)
// メモ・記録用シートの名前一覧。都道府県フィルターの集計対象から除外するために使う。
function getNonListSheetNames() {
  const names = new Set();
  names.add((CONFIG && CONFIG.logSheetName) || "トスアップログ");
  names.add((CONFIG && CONFIG.feedbackSheetName) || "要望ログ");
  return names;
}

function getAllPrefectures() {
  const set = new Set();
  const excluded = getNonListSheetNames();
  for (const title of state.sheetOrder) {
    if (excluded.has(title)) continue;
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
      state.report.rangeFilters = {};
      state.analysis.expandedLists = new Set();
      state.strategy.rangeFilters = {};
      afterIncludedSheetsChanged();
    });
    container.appendChild(btn);
  });
}

function afterIncludedSheetsChanged() {
  renderAreaSwitcher();
  renderSheetSelector();
  renderReportRangeFilters();
  renderDetailSheetTabs();
  renderDetailTable();
  renderSummary();
  renderAnalysis();
  renderStrategyRangeFilters();
  renderStrategy();
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

// エリア内から「リスト」を含むシートと、業種別4シート(未コール/不在1/不在2/不在3以上)を探す
function getAreaSheetSetFromTitles(titles) {
  const categorySheets = {};
  CATEGORY_SHEET_DEFS.forEach((c) => {
    categorySheets[c.key] = titles.find((t) => c.match(t)) || null;
  });
  const listSheet = pickListSheetFromTitles(titles);
  return { listSheet, categorySheets };
}

function getAreaSheetSet(area) {
  const areaMap = groupSheetsByArea();
  return getAreaSheetSetFromTitles(areaMap.get(area) || []);
}

// 業種別4シートのうち、実際に存在する最初のシート名を返す(業種名一覧の取得に使う)
function getPrimaryIndustrySheet(categorySheets) {
  for (const key of CATEGORY_KEYS) {
    if (categorySheets && categorySheets[key]) return categorySheets[key];
  }
  return null;
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

function setReportRowMode(mode) {
  if (state.report.rowMode === mode) return;
  state.report.rowMode = mode;
  state.report.rangeFilters = {}; // 行(リスト名/業種)によって選べる項目が変わるため、表示条件はリセットする
  $("#report-row-list").classList.toggle("active", mode === "list");
  $("#report-row-industry").classList.toggle("active", mode === "industry");
  renderReportRangeFilters();
  renderVisibleColumnsPanel();
  renderSummary();
}
$("#report-row-list").addEventListener("click", () => setReportRowMode("list"));
$("#report-row-industry").addEventListener("click", () => setReportRowMode("industry"));

$("#analysis-mode-week").addEventListener("click", () => {
  state.analysis.mode = "week";
  $("#analysis-mode-week").classList.add("active");
  $("#analysis-mode-weekday").classList.remove("active");
  renderAnalysis();
});
$("#analysis-mode-weekday").addEventListener("click", () => {
  state.analysis.mode = "weekday";
  $("#analysis-mode-weekday").classList.add("active");
  $("#analysis-mode-week").classList.remove("active");
  renderAnalysis();
});
$("#analysis-expand-all").addEventListener("click", () => {
  const report = computeAnalysisReport();
  if (!report.error) {
    state.analysis.expandedLists = new Set(report.listRows.map((lr) => lr.listName));
  }
  renderAnalysis();
});
$("#analysis-collapse-all").addEventListener("click", () => {
  state.analysis.expandedLists = new Set();
  renderAnalysis();
});
$("#analysis-manual-snapshot").addEventListener("click", triggerManualSnapshot);

$("#strategy-mode-valid").addEventListener("click", () => {
  state.strategy.mode = "validRate";
  $("#strategy-mode-valid").classList.add("active");
  $("#strategy-mode-honshi").classList.remove("active");
  renderStrategy();
});
$("#strategy-mode-honshi").addEventListener("click", () => {
  state.strategy.mode = "honshi";
  $("#strategy-mode-honshi").classList.add("active");
  $("#strategy-mode-valid").classList.remove("active");
  renderStrategy();
});
$("#strategy-only-recommended").addEventListener("change", (e) => {
  state.strategy.onlyRecommended = e.target.checked;
  renderStrategy();
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
  renderAnalysis();
  renderStrategy();
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

// 残量・業種内訳・分析タブの集計値など「列内での相対的な多い/少ない」を示す文字色。
// 有効率・トスアップ率の評価色(gradeColor)と同じ、アンカー間をなめらかに補間する仕組みを使い、
// その列の最大値に対する割合(0=最も低い 〜 1=最も高い)に応じて
// 低い=赤(hue 0) → 普通(列内の中間)=緑(hue 120) → 高い=青(hue 240) の文字色にする。
// 値が0/無い場合はnullを返す(通常の文字色のまま、背景は一切付けない)。
function heatTextColor(value, max) {
  if (!value || max === undefined) return null;
  const ratio = Math.max(0, Math.min(1, value / max));
  const anchors = [
    { r: 0, h: 0 }, // 赤(低い)
    { r: 0.5, h: 120 }, // 緑(普通)
    { r: 1, h: 240 }, // 青(高い)
  ];
  let lo = anchors[0];
  let hi = anchors[anchors.length - 1];
  for (let i = 0; i < anchors.length - 1; i++) {
    if (ratio >= anchors[i].r && ratio <= anchors[i + 1].r) {
      lo = anchors[i];
      hi = anchors[i + 1];
      break;
    }
  }
  const span = hi.r - lo.r;
  const t = span === 0 ? 0 : (ratio - lo.r) / span;
  const hue = lo.h + (hi.h - lo.h) * t;
  return `hsl(${hue.toFixed(0)}, 72%, 38%)`;
}

// 残量・業種内訳・分析タブの集計値セルの共通HTML(背景は付けず、文字色のみで相対的な高さを示す)。
// max未指定(都道府県内訳行など基準が無い場合)は通常表示にする。
function heatCellHtml(value, max) {
  const v = value || 0;
  const color = heatTextColor(v, max);
  return color
    ? `<td class="count-cell"><span style="color:${color}; font-weight:700;">${v}</span></td>`
    : `<td class="count-cell">${v}</td>`;
}

// 集計タブ「行=リスト名」モードで表示できる組み込み項目の一覧(表示順)。カスタム項目はこの後ろに追加される。
const ROW_LIST_BUILTIN_COLUMNS = [
  { key: "dialable", label: "架電可能数" },
  { key: "notCalled", label: "未コール" },
  { key: "absent1", label: "不在1" },
  { key: "absent2", label: "不在2" },
  { key: "absent3plus", label: "不在3以上" },
  { key: "validCount", label: "有効結果" },
  { key: "validRate", label: "有効率" },
  { key: "tossupRate", label: "トスアップ率" },
  { key: "appoRate", label: "アポイント率" },
  { key: "approachNgRate", label: "アプローチNG率" },
  { key: "honshiNgRate", label: "決裁者接触率" },
  { key: "closingNgRate", label: "クロージングNG率" },
];

// 集計タブ「行=業種」モードで表示できる組み込み項目の一覧。リストデータシートに業種別の内訳が無いため、
// 残量系(未コール・不在1〜3以上・架電可能数)のみが対象。
const ROW_INDUSTRY_BUILTIN_COLUMNS = [
  { key: "dialable", label: "架電可能数" },
  { key: "notCalled", label: "未コール" },
  { key: "absent1", label: "不在1" },
  { key: "absent2", label: "不在2" },
  { key: "absent3plus", label: "不在3以上" },
];

// この項目のキーが「業種別4シートから拾う残量系の件数」かどうか(架電可能数の内訳・%表示の対象)
const CATEGORY_COUNT_KEYS = new Set(CATEGORY_KEYS);

// リストデータシートのF列以降で、既存の項目(有効結果・トスアップ・アポ・各NG率)がまだ使っていない
// 数値列を「その他の項目」として自動検出する(合計等の列名は除く)
function getLeftoverListColumns() {
  const listSheet = getAllSheetTitlesByType("list")[0] || null;
  if (!listSheet || !state.sheets[listSheet]) return [];
  const headers = state.sheets[listSheet].headers;
  const defs = getColumnDefs();
  const claimed = new Set();
  ["validCount", "tossup", "appo", "approachNg", "honshiNg", "closingNg"].forEach((k) => {
    ((defs[k] && defs[k].columns) || []).forEach((c) => claimed.add(c));
  });
  getCustomMetricDefs().forEach((c) => {
    if (c.source === "list") (c.columns || []).forEach((col) => claimed.add(col));
  });
  const leftover = [];
  for (let idx = VALID_RESULT_COL_START; idx < headers.length; idx++) {
    const name = headers[idx];
    if (!name || name === "合計" || claimed.has(name) || leftover.includes(name)) continue;
    if (detectColumnType(listSheet, idx).type !== "numeric") continue;
    leftover.push(name);
  }
  return leftover;
}

// 集計タブで表示/非表示を選べる項目の一覧(行モードに応じた組み込み項目 + カスタム項目)を返す。
// 「行=リスト名」モードのみ、その他リストデータ列(leftover:接頭辞)・業種別の列(indcol:接頭辞)も追加する。
function getDisplayableColumnList(customDefs, opts = {}) {
  const rowMode = opts.rowMode || state.report.rowMode;
  if (rowMode === "industry") {
    return [...ROW_INDUSTRY_BUILTIN_COLUMNS];
  }
  const leftoverCols = (opts.leftoverCols || getLeftoverListColumns()).map((name) => ({
    key: `leftover:${name}`,
    label: name,
  }));
  const industryNames = (opts.industryNames || []).map((name) => ({
    key: `indcol:${name}`,
    label: `業種:${name}`,
  }));
  return [
    ...ROW_LIST_BUILTIN_COLUMNS,
    ...(customDefs || []).map((c) => ({ key: c.key, label: c.label })),
    ...leftoverCols,
    ...industryNames,
  ];
}

// 件数の横に添える%表示。denominatorが無い/0の場合は%を省略する。
function countWithPctHtml(count, denominator, colorMax) {
  const v = count || 0;
  const pct = denominator ? formatPct((v / denominator) * 100) : null;
  const color = colorMax !== undefined ? heatTextColor(v, colorMax) : null;
  const countHtml = color ? `<span style="color:${color}; font-weight:700;">${v}</span>` : `${v}`;
  return `<td class="count-cell">${countHtml}${pct !== null ? `<div class="sub-pct">(${pct})</div>` : ""}</td>`;
}

// 集計タブの表の1セル分のHTMLを、項目キーに応じて生成する
function renderReportCell(key, obj, ctx) {
  switch (key) {
    case "dialable":
      return heatCellHtml(obj.dialable, ctx.maxDialable);
    case "notCalled":
    case "absent1":
    case "absent2":
    case "absent3plus":
      // 未コール・不在1〜3以上は、架電可能数(表示中の残量系項目の合計)に対する割合もあわせて表示する
      return countWithPctHtml(obj[key], obj.dialable, ctx.maxCategory ? ctx.maxCategory[key] : undefined);
    case "validCount":
      return countWithPctHtml(obj.validCount, undefined);
    case "validRate":
      return gradedPctHtml(obj.validRate, VALID_RATE_THRESHOLDS.badMax, VALID_RATE_THRESHOLDS.goodMin);
    case "tossupRate":
      return gradedPctHtml(obj.tossupRate, TOSSUP_RATE_THRESHOLDS.badMax, TOSSUP_RATE_THRESHOLDS.goodMin);
    case "appoRate":
      return `<td class="count-cell">${formatPct(obj.appoRate)}</td>`;
    case "approachNgRate":
      return `<td class="count-cell">${formatPct(obj.approachNgRate)}</td>`;
    case "honshiNgRate":
      return `<td class="count-cell">${formatPct(obj.honshiNgRate)}</td>`;
    case "closingNgRate":
      return `<td class="count-cell">${formatPct(obj.closingNgRate)}</td>`;
    default: {
      if (key.startsWith("indcol:")) {
        const name = key.slice("indcol:".length);
        const val = obj.industry ? obj.industry[name] : 0;
        return countWithPctHtml(val, obj.dialable, ctx.maxIndustry ? ctx.maxIndustry[name] : undefined);
      }
      if (key.startsWith("leftover:")) {
        const name = key.slice("leftover:".length);
        const val = obj.leftover ? obj.leftover[name] : 0;
        return countWithPctHtml(val, obj.validCount, ctx.maxLeftover ? ctx.maxLeftover[name] : undefined);
      }
      const def = ctx.customDefMap && ctx.customDefMap[key];
      const val = obj.extra ? obj.extra[key] : undefined;
      if (def && def.op === "ratio") {
        return `<td class="count-cell">${formatPct(val)}</td>`;
      }
      return countWithPctHtml(val, obj.validCount);
    }
  }
}

// 指定シートの中から、リスト名をキーに指定列の値を合算したMapを作る(都道府県は合算済み)
function buildListValueMap(title, columnNames) {
  const map = new Map();
  if (!title || !state.sheets[title] || columnNames.length === 0) return map;
  const { headers, rows } = state.sheets[title];
  const colIndexes = columnNames.map((name) => headers.indexOf(name));
  rows.forEach((cells) => {
    const listName = String(cells[CONFIG.listNameColumnIndex] ?? "");
    const pref = String(cells[CONFIG.prefectureColumnIndex] ?? "");
    if (!listName || !pref) return;
    if (!map.has(listName)) {
      const obj = {};
      columnNames.forEach((n) => (obj[n] = 0));
      map.set(listName, obj);
    }
    const obj = map.get(listName);
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

// notCalled/absent1/absent2/absent3plus/tossup/appo/approachNg/honshiNg/closingNg/validCount/extra が
// 入ったオブジェクトに、架電可能数・有効率・トスアップ率・アポイント率・各種NG率・追加列の%を計算して追加する。
// visibleCategoryKeys: 「架電可能数」に合算する残量系項目(未コール/不在1/不在2/不在3以上)のうち、
// 現在表示対象になっているキーの配列(集計タブでは表示項目の選択に応じて変わり、クール戦略タブでは常に全4項目)。
function computeDerived(obj, extraCols, visibleCategoryKeys) {
  const catKeys = visibleCategoryKeys || CATEGORY_KEYS;
  obj.dialable = catKeys.reduce((sum, k) => sum + (obj[k] || 0), 0);
  const totalAbsent = (obj.absent1 || 0) + (obj.absent2 || 0) + (obj.absent3plus || 0);
  // 有効率 = 有効結果 ÷ (不在(1〜3以上の合計) + 有効結果)
  obj.validRate = ratioOrNull(obj.validCount, totalAbsent + obj.validCount);
  obj.tossupRate = ratioOrNull(obj.tossup, obj.validCount);
  obj.appoRate = ratioOrNull(obj.appo, obj.validCount);
  // アプローチNG率・決裁者接触率(旧:主旨NG率)・クロージングNG率(いずれも対有効 = ÷有効結果)
  obj.approachNgRate = ratioOrNull(obj.approachNg, obj.validCount);
  obj.honshiNgRate = ratioOrNull(obj.honshiNg, obj.validCount);
  obj.closingNgRate = ratioOrNull(obj.closingNg, obj.validCount);
  obj.extraPct = {};
  extraCols.forEach((c) => {
    obj.extraPct[c] = ratioOrNull(obj.extra[c], obj.validCount);
  });
  return obj;
}

// 残量シートの中で「業種」として扱う列(E列(0始まりで4)〜最後から2番目の列。
// 一番後ろの列は業種横断の合計値のため業種としては扱わない)
function getIndustryColumnRange(headers) {
  const start = 4;
  const end = headers.length - 2;
  return { start, end };
}

// 残量シートのヘッダーから業種名の一覧を返す(E列以降、末尾の合計列は除く)
function getIndustryNames(title) {
  if (!title || !state.sheets[title]) return [];
  const { headers } = state.sheets[title];
  const { start, end } = getIndustryColumnRange(headers);
  if (end < start) return [];
  const names = [];
  for (let i = start; i <= end; i++) {
    if (headers[i]) names.push(headers[i]);
  }
  return names;
}

// 集計タブ「行=リスト名」モードの「表示条件」で絞り込み可能な組み込み項目の一覧
// (その他リストデータ列・業種列・カスタム項目は呼び出し側で追加する)
const REPORT_RANGE_FILTER_BASE_COLUMNS = [
  { key: "dialable", label: "架電可能数" },
  { key: "notCalled", label: "未コール" },
  { key: "absent1", label: "不在1" },
  { key: "absent2", label: "不在2" },
  { key: "absent3plus", label: "不在3以上" },
  { key: "validCount", label: "有効結果" },
  { key: "validRate", label: "有効率" },
  { key: "tossupRate", label: "トスアップ率" },
  { key: "appoRate", label: "アポイント率" },
  { key: "approachNgRate", label: "アプローチNG率" },
  { key: "honshiNgRate", label: "決裁者接触率" },
  { key: "closingNgRate", label: "クロージングNG率" },
];
// 集計タブ「行=業種」モードの「表示条件」で絞り込み可能な項目の一覧
const REPORT_RANGE_FILTER_INDUSTRY_COLUMNS = [
  { key: "dialable", label: "架電可能数" },
  { key: "notCalled", label: "未コール" },
  { key: "absent1", label: "不在1" },
  { key: "absent2", label: "不在2" },
  { key: "absent3plus", label: "不在3以上" },
];
// このうち%表示の項目(表示条件のラベルに「(%)」を添えるため)
const REPORT_RANGE_FILTER_PERCENT_KEYS = new Set([
  "validRate",
  "tossupRate",
  "appoRate",
  "approachNgRate",
  "honshiNgRate",
  "closingNgRate",
]);

// 現在の行モードで表示条件の対象になる項目一覧(基本項目 + カスタム項目 + その他リスト列 + 業種列)を返す
function getReportRangeFilterColumns(industryNames, leftoverCols, customDefs) {
  if (state.report.rowMode === "industry") {
    return [...REPORT_RANGE_FILTER_INDUSTRY_COLUMNS];
  }
  const customCols = (customDefs || []).map((c) => ({ key: c.key, label: c.label }));
  const leftoverColDefs = (leftoverCols || []).map((n) => ({ key: `leftover:${n}`, label: n }));
  const industryColDefs = (industryNames || []).map((n) => ({ key: `indcol:${n}`, label: `業種:${n}` }));
  return [...REPORT_RANGE_FILTER_BASE_COLUMNS, ...customCols, ...leftoverColDefs, ...industryColDefs];
}

// 値オブジェクト(行=リスト名なら lr.all、行=業種なら industryRow.all)から、
// 表示条件のキーに対応する値を取り出す(leftover:/indcol:接頭辞・カスタム項目にも対応)。
function getReportFilterValue(allObj, key, customKeys) {
  if (key.startsWith("indcol:")) return allObj.industry ? allObj.industry[key.slice("indcol:".length)] : undefined;
  if (key.startsWith("leftover:")) return allObj.leftover ? allObj.leftover[key.slice("leftover:".length)] : undefined;
  if (customKeys && customKeys.includes(key)) return allObj.extra ? allObj.extra[key] : undefined;
  return allObj[key];
}

// 行(リストのALL/業種の合計)の値が、state.report.rangeFiltersで指定した
// すべての上限/下限条件を満たしているかどうかを判定する(上限・下限はどちらか片方だけでもよい)。
function rowPassesRangeFilters(allObj, customKeys) {
  for (const [key, f] of Object.entries(state.report.rangeFilters)) {
    if (!f || (f.min === null && f.max === null)) continue;
    const value = getReportFilterValue(allObj, key, customKeys);
    if (value === null || value === undefined || isNaN(value)) return false;
    if (f.min !== null && value < f.min) return false;
    if (f.max !== null && value > f.max) return false;
  }
  return true;
}

// 「表示条件を設定」パネルの中身を描画する(業種列の一覧が変わりうるエリア切替・シート変更のタイミングでのみ再構築し、
// 並び替えなど頻繁な再描画のたびには再構築しない = 入力中の値がリセットされないようにするため)
function renderReportRangeFilters() {
  const container = $("#report-range-filters");
  if (!container) return;
  container.innerHTML = "";
  const { categorySheets } = getAreaSheetSet(state.report.area);
  const industryNames = getIndustryNames(getPrimaryIndustrySheet(categorySheets));
  const leftoverCols = getLeftoverListColumns();
  const customDefs = getCustomMetricDefs();
  const columns = getReportRangeFilterColumns(industryNames, leftoverCols, customDefs);
  const customDefMap = Object.fromEntries(customDefs.map((c) => [c.key, c]));

  columns.forEach((col) => {
    if (!state.report.rangeFilters[col.key]) {
      state.report.rangeFilters[col.key] = { min: null, max: null };
    }
    const f = state.report.rangeFilters[col.key];
    const isPercent = REPORT_RANGE_FILTER_PERCENT_KEYS.has(col.key) || (customDefMap[col.key] && customDefMap[col.key].op === "ratio");
    const label = isPercent ? `${col.label}(%)` : col.label;

    const row = document.createElement("div");
    row.className = "range-filter-row";
    row.innerHTML =
      `<span class="range-filter-label">${escapeHtml(label)}</span>` +
      `<span class="numeric-row">` +
      `<input type="number" placeholder="下限" value="${f.min ?? ""}" />` +
      `<span>〜</span>` +
      `<input type="number" placeholder="上限" value="${f.max ?? ""}" />` +
      `</span>`;
    const [minInput, , maxInput] = row.querySelector(".numeric-row").children;
    minInput.addEventListener("change", (e) => {
      f.min = e.target.value === "" ? null : Number(e.target.value);
      renderSummary();
    });
    maxInput.addEventListener("change", (e) => {
      f.max = e.target.value === "" ? null : Number(e.target.value);
      renderSummary();
    });
    container.appendChild(row);
  });
}

$("#report-range-reset").addEventListener("click", () => {
  Object.keys(state.report.rangeFilters).forEach((key) => {
    state.report.rangeFilters[key] = { min: null, max: null };
  });
  renderReportRangeFilters();
  renderSummary();
});

// ------------------------------------------------------------
// 描画: 項目の定義・表示する項目を設定するパネル(集計タブ)
// ------------------------------------------------------------

// 列の定義変更・表示項目変更のたびに、関係する画面をまとめて再描画する
function afterColumnDefsChanged() {
  renderReportRangeFilters();
  renderVisibleColumnsPanel();
  renderSummary();
  renderStrategy(); // 残量・有効率などはクール戦略タブでも同じ定義を使っているため
}

// 1項目分の「対象シート・計算方法・使う列」を設定する行を作る
// opts.editableLabel: 項目名を編集できるか(カスタム項目のみtrue)
// opts.editableSource: 対象シート(リストデータ/残量)を変更できるか(カスタム項目のみtrue)
// opts.removable: 削除ボタンを出すか(カスタム項目のみtrue)
function buildMetricDefRow(key, label, fixedSource, def, onChange, opts = {}) {
  const wrap = document.createElement("div");
  wrap.className = "metric-def-row";

  const title = document.createElement("div");
  title.className = "metric-def-title";
  if (opts.editableLabel) {
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = label;
    nameInput.className = "metric-def-name-input";
    nameInput.addEventListener("change", (e) => {
      def.label = e.target.value.trim() || label;
      onChange(def, { rerender: false });
    });
    title.appendChild(nameInput);
  } else {
    const span = document.createElement("span");
    span.textContent = label;
    title.appendChild(span);
  }
  if (opts.removable) {
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn-link";
    removeBtn.textContent = "削除";
    removeBtn.addEventListener("click", opts.onRemove);
    title.appendChild(removeBtn);
  }
  wrap.appendChild(title);

  const sourceRow = document.createElement("div");
  sourceRow.className = "metric-def-source-row";
  if (opts.editableSource) {
    const label2 = document.createElement("span");
    label2.textContent = "対象: ";
    sourceRow.appendChild(label2);
    const sel = document.createElement("select");
    [
      ["list", "リストデータシート"],
      ...CATEGORY_SHEET_DEFS.map((c) => [c.key, `業種${c.label}シート`]),
    ].forEach(([val, txt]) => {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = txt;
      if ((def.source || fixedSource) === val) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", (e) => {
      def.source = e.target.value;
      def.columns = [];
      onChange(def, { rerender: true });
    });
    sourceRow.appendChild(sel);
  } else {
    sourceRow.textContent = `対象: ${sourceLabel(fixedSource)}`;
  }
  wrap.appendChild(sourceRow);

  const opRow = document.createElement("div");
  opRow.className = "metric-def-op-row";
  const opLabel = document.createElement("span");
  opLabel.textContent = "計算方法: ";
  opRow.appendChild(opLabel);
  const opSel = document.createElement("select");
  [
    ["sum", "合計(選んだ列の合計)"],
    ["diff", "差(1列目 − 2列目)"],
    ["ratio", "割合(1列目 ÷ 2列目 × 100)"],
  ].forEach(([val, txt]) => {
    const o = document.createElement("option");
    o.value = val;
    o.textContent = txt;
    if ((def.op || "sum") === val) o.selected = true;
    opSel.appendChild(o);
  });
  opSel.addEventListener("change", (e) => {
    def.op = e.target.value;
    onChange(def, { rerender: false });
  });
  opRow.appendChild(opSel);
  wrap.appendChild(opRow);

  const colsRow = document.createElement("div");
  colsRow.className = "metric-def-columns";
  const source = def.source || fixedSource;
  const options = getAvailableColumnsForSource(source);
  const selected = new Set(def.columns || []);
  if (options.length === 0) {
    const span = document.createElement("span");
    span.className = "muted-inline";
    span.textContent = "対象シートに数値列が見つかりません";
    colsRow.appendChild(span);
  }
  options.forEach((name) => {
    const idSafe = `coldef-${key}-${name}`.replace(/[^a-zA-Z0-9_-]/g, "_");
    const lbl = document.createElement("label");
    lbl.className = "chip";
    lbl.innerHTML = `<input type="checkbox" id="${idSafe}" ${selected.has(name) ? "checked" : ""}/> ${escapeHtml(name)}`;
    lbl.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) selected.add(name);
      else selected.delete(name);
      def.columns = Array.from(selected);
      onChange(def, { rerender: false });
    });
    colsRow.appendChild(lbl);
  });
  wrap.appendChild(colsRow);

  const hint = document.createElement("p");
  hint.className = "muted-inline";
  hint.textContent = "「差」「割合」の場合は、チェックした先頭2つの列(1列目→2列目の順)が使われます。";
  wrap.appendChild(hint);

  return wrap;
}

function buildAddCustomMetricForm(onAdd) {
  const wrap = document.createElement("div");
  wrap.className = "add-custom-metric-form";

  const title = document.createElement("div");
  title.className = "control-label";
  title.textContent = "新しい項目を追加";
  wrap.appendChild(title);

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "項目名(例: 回収率)";
  wrap.appendChild(nameInput);

  const status = document.createElement("span");
  status.className = "muted-inline";
  wrap.appendChild(status);

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "btn-secondary";
  addBtn.textContent = "追加";
  addBtn.addEventListener("click", () => {
    const label = nameInput.value.trim();
    if (!label) {
      status.textContent = "項目名を入力してください";
      return;
    }
    const key = `custom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    onAdd({ key, label, source: "list", op: "sum", columns: [] });
    nameInput.value = "";
    status.textContent = "";
  });
  wrap.appendChild(addBtn);
  return wrap;
}

function renderColumnDefsPanel() {
  const container = $("#column-defs-panel");
  if (!container) return;
  if (!state.loaded) {
    container.innerHTML = `<p class="muted-inline">データ読み込み後に設定できます</p>`;
    return;
  }
  container.innerHTML = "";
  const defs = getColumnDefs();
  const customDefs = getCustomMetricDefs();

  BASE_METRIC_KEYS.forEach((meta) => {
    if (!defs[meta.key]) defs[meta.key] = { source: meta.source, op: "sum", columns: [] };
    const row = buildMetricDefRow(meta.key, meta.label, meta.source, defs[meta.key], (def, opts) => {
      saveColumnDefs(defs);
      if (opts && opts.rerender) renderColumnDefsPanel();
      afterColumnDefsChanged();
    });
    container.appendChild(row);
  });

  if (customDefs.length > 0) {
    const customWrap = document.createElement("div");
    customWrap.className = "custom-metric-list";
    customDefs.forEach((c) => {
      const row = buildMetricDefRow(c.key, c.label, c.source, c, (def, opts) => {
        saveCustomMetricDefs(customDefs);
        if (opts && opts.rerender) renderColumnDefsPanel();
        afterColumnDefsChanged();
      }, {
        removable: true,
        editableLabel: true,
        editableSource: true,
        onRemove: () => {
          const idx = customDefs.findIndex((x) => x.key === c.key);
          if (idx >= 0) customDefs.splice(idx, 1);
          if (state.report.visibleColumns) state.report.visibleColumns.delete(c.key);
          saveCustomMetricDefs(customDefs);
          saveVisibleColumns();
          renderColumnDefsPanel();
          afterColumnDefsChanged();
        },
      });
      customWrap.appendChild(row);
    });
    container.appendChild(customWrap);
  }

  const addForm = buildAddCustomMetricForm((newMetric) => {
    customDefs.push(newMetric);
    if (state.report.visibleColumns) state.report.visibleColumns.add(newMetric.key);
    saveCustomMetricDefs(customDefs);
    saveVisibleColumns();
    renderColumnDefsPanel();
    afterColumnDefsChanged();
  });
  container.appendChild(addForm);
}

$("#column-defs-reset").addEventListener("click", () => {
  try {
    localStorage.removeItem(COLUMN_DEFS_STORAGE_KEY);
  } catch (e) {
    // 無視(プライベートブラウジング等)
  }
  _columnDefsCache = null;
  ensureColumnDefsSeeded();
  renderColumnDefsPanel();
  afterColumnDefsChanged();
});

function renderVisibleColumnsPanel() {
  const container = $("#visible-columns-panel");
  if (!container) return;
  if (!state.loaded) {
    container.innerHTML = `<p class="muted-inline">データ読み込み後に設定できます</p>`;
    return;
  }
  container.innerHTML = "";
  if (!state.report.visibleColumns) ensureVisibleColumnsSeeded();
  const customDefs = getCustomMetricDefs();
  const { categorySheets } = getAreaSheetSet(state.report.area);
  const industryNames = getIndustryNames(getPrimaryIndustrySheet(categorySheets));
  const leftoverCols = getLeftoverListColumns();
  const list = getDisplayableColumnList(customDefs, { industryNames, leftoverCols });
  if (state.report.rowMode === "industry") {
    const note = document.createElement("p");
    note.className = "muted-inline";
    note.textContent = "行=業種のときは、業種別の内訳データが無いため残量系(未コール・不在1〜3以上・架電可能数)のみ選択できます。";
    container.appendChild(note);
  }
  list.forEach((col) => {
    const id = `viscol-${col.key}`.replace(/[^a-zA-Z0-9_-]/g, "_");
    const label = document.createElement("label");
    label.className = "chip";
    const checked = state.report.visibleColumns.has(col.key);
    label.innerHTML = `<input type="checkbox" id="${id}" ${checked ? "checked" : ""}/> ${escapeHtml(col.label)}`;
    label.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) state.report.visibleColumns.add(col.key);
      else state.report.visibleColumns.delete(col.key);
      saveVisibleColumns();
      renderSummary();
    });
    container.appendChild(label);
  });
}

// 現在の「表示する項目」設定のうち、残量系(未コール/不在1/不在2/不在3以上)で表示ONになっているキー一覧。
// 集計タブの「架電可能数」は、この表示中の項目だけを合計した値になる(1つも表示していなければ全4項目扱い)。
function getVisibleCategoryKeys() {
  const visible = state.report.visibleColumns || new Set(DEFAULT_VISIBLE_COLUMNS);
  const keys = CATEGORY_KEYS.filter((k) => visible.has(k));
  return keys.length > 0 ? keys : CATEGORY_KEYS;
}

function computeAreaReport() {
  const area = state.report.area;
  if (!area) return { error: "エリアがありません" };

  const { listSheet, categorySheets } = getAreaSheetSet(area);
  const primaryIndustrySheet = getPrimaryIndustrySheet(categorySheets);
  if (!listSheet && !primaryIndustrySheet) {
    return {
      error: `エリア「${area}」に対象となるシートが見つかりません(「業種未コール」「業種不在1」等、または「リストデータ」という名前のシートが必要です)`,
    };
  }

  const defs = getColumnDefs();
  const customDefs = getCustomMetricDefs();
  const extraCols = customDefs.map((c) => c.key);
  const customDefMap = Object.fromEntries(customDefs.map((c) => [c.key, c]));
  const industryNames = getIndustryNames(primaryIndustrySheet);
  const leftoverCols = getLeftoverListColumns();
  const visibleCategoryKeys = getVisibleCategoryKeys();

  // ソースごと(list/notCalled/absent1/absent2/absent3plus)に、どの生の列を集計しておく必要があるかを洗い出す
  const colsNeededBySource = { list: new Set(leftoverCols) };
  CATEGORY_KEYS.forEach((k) => (colsNeededBySource[k] = new Set(industryNames)));
  const allDefs = [...BASE_METRIC_KEYS.map((m) => defs[m.key]), ...customDefs];
  allDefs.forEach((def) => {
    if (!def || !def.columns) return;
    const set = colsNeededBySource[def.source] || colsNeededBySource.list;
    def.columns.forEach((c) => set.add(c));
  });

  const valueMapsBySource = { list: buildListValueMap(listSheet, Array.from(colsNeededBySource.list)) };
  CATEGORY_KEYS.forEach((k) => {
    valueMapsBySource[k] = buildListValueMap(categorySheets[k], Array.from(colsNeededBySource[k]));
  });

  const allListNames = new Set();
  Object.values(valueMapsBySource).forEach((m) => m.forEach((_, listName) => allListNames.add(listName)));

  const listRows = [];
  allListNames.forEach((listName) => {
    const valuesBySource = {};
    Object.keys(valueMapsBySource).forEach((src) => {
      valuesBySource[src] = valueMapsBySource[src].get(listName) || {};
    });

    const all = {};
    BASE_METRIC_KEYS.forEach((m) => (all[m.key] = computeDefValue(defs[m.key], valuesBySource)));
    all.extra = {};
    customDefs.forEach((c) => (all.extra[c.key] = computeDefValue(c, valuesBySource)));
    all.leftover = {};
    leftoverCols.forEach((c) => (all.leftover[c] = valuesBySource.list[c] || 0));
    // 業種別の列(indcol)は、業種別4シートの合計(=そのリスト・業種の架電可能な残量全体)を表す
    all.industry = {};
    industryNames.forEach((n) => {
      all.industry[n] = CATEGORY_KEYS.reduce((sum, k) => sum + (valuesBySource[k][n] || 0), 0);
    });
    computeDerived(all, extraCols, visibleCategoryKeys);
    listRows.push({ listName, all });
  });

  const grand = { extra: {}, industry: {}, leftover: {} };
  CATEGORY_KEYS.forEach((k) => (grand[k] = 0));
  ["validCount", "tossup", "appo", "approachNg", "honshiNg", "closingNg"].forEach((k) => (grand[k] = 0));
  extraCols.forEach((c) => (grand.extra[c] = 0));
  leftoverCols.forEach((c) => (grand.leftover[c] = 0));
  industryNames.forEach((n) => (grand.industry[n] = 0));
  listRows.forEach((lr) => {
    CATEGORY_KEYS.forEach((k) => (grand[k] += lr.all[k]));
    ["validCount", "tossup", "appo", "approachNg", "honshiNg", "closingNg"].forEach((k) => (grand[k] += lr.all[k]));
    extraCols.forEach((c) => (grand.extra[c] += lr.all.extra[c]));
    leftoverCols.forEach((c) => (grand.leftover[c] += lr.all.leftover[c]));
    industryNames.forEach((n) => (grand.industry[n] += lr.all.industry[n] || 0));
  });
  computeDerived(grand, extraCols, visibleCategoryKeys);

  const sortKey = state.report.sort.key;
  const dirMul = state.report.sort.dir === "asc" ? 1 : -1;
  const simpleKeys = [
    "dialable",
    "notCalled",
    "absent1",
    "absent2",
    "absent3plus",
    "validCount",
    "validRate",
    "tossupRate",
    "appoRate",
    "approachNgRate",
    "honshiNgRate",
    "closingNgRate",
  ];
  // 架電可能数が同数の場合の自動タイブレーク順(架電可能数でソートしている時だけ適用)
  const TIE_BREAK_KEYS = ["validRate", "tossupRate", "appoRate"];
  const compareBy = (key, a, b) => {
    let av, bv;
    if (simpleKeys.includes(key)) {
      av = a.all[key];
      bv = b.all[key];
    } else if (key.startsWith("indcol:")) {
      const name = key.slice("indcol:".length);
      av = a.all.industry[name] || 0;
      bv = b.all.industry[name] || 0;
    } else if (key.startsWith("leftover:")) {
      const name = key.slice("leftover:".length);
      av = a.all.leftover[name] || 0;
      bv = b.all.leftover[name] || 0;
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
    // 「架電可能数」でソートしている場合、同数の行は有効率→トスアップ率→アポイント率の順で自動的に並び替える
    if (sortKey === "dialable") {
      for (const key of TIE_BREAK_KEYS) {
        diff = compareBy(key, a, b);
        if (diff !== 0) return diff;
      }
    }
    return 0;
  });

  // 表示条件(上限/下限による絞り込み)を適用する。ALL行(そのリストの全都道府県合計)の値で判定し、
  // 条件を満たさないリストは表示対象から除く(エリア全体の合計「grand」は絞り込み前の値のまま)。
  const totalListCount = listRows.length;
  const displayListRows = listRows.filter((lr) => rowPassesRangeFilters(lr.all, extraCols));

  return {
    area,
    listSheet,
    categorySheets,
    listRows: displayListRows,
    totalListCount,
    filteredListCount: displayListRows.length,
    grand,
    extraCols,
    customDefMap,
    industryNames,
    leftoverCols,
  };
}

// 「行=業種」モード用の集計。業種別4シートを業種名で横断集計し、業種ごとの
// 未コール・不在1・不在2・不在3以上・架電可能数を返す(リストデータシートの内訳が無いため、それ以外の項目は対象外)。
function computeIndustryReport() {
  const area = state.report.area;
  if (!area) return { error: "エリアがありません" };

  const { categorySheets } = getAreaSheetSet(area);
  const primaryIndustrySheet = getPrimaryIndustrySheet(categorySheets);
  if (!primaryIndustrySheet) {
    return { error: `エリア「${area}」に「業種未コール」「業種不在1」等のシートが見つかりません` };
  }
  const industryNames = getIndustryNames(primaryIndustrySheet);
  if (industryNames.length === 0) {
    return { error: "業種の列が見つかりません" };
  }
  const visibleCategoryKeys = getVisibleCategoryKeys();

  const totals = {};
  industryNames.forEach((n) => {
    totals[n] = {};
    CATEGORY_KEYS.forEach((k) => (totals[n][k] = 0));
  });

  CATEGORY_KEYS.forEach((k) => {
    const title = categorySheets[k];
    if (!title || !state.sheets[title]) return;
    const { headers, rows } = state.sheets[title];
    const colIdx = industryNames.map((n) => headers.indexOf(n));
    rows.forEach((cells) => {
      industryNames.forEach((n, i) => {
        const idx = colIdx[i];
        if (idx === -1) return;
        const v = parseFloat(cells[idx]);
        if (!isNaN(v)) totals[n][k] += v;
      });
    });
  });

  const industryRows = industryNames.map((name) => {
    const all = { ...totals[name] };
    all.dialable = visibleCategoryKeys.reduce((sum, k) => sum + (all[k] || 0), 0);
    return { industryName: name, all };
  });

  const grand = {};
  CATEGORY_KEYS.forEach((k) => (grand[k] = 0));
  industryRows.forEach((r) => CATEGORY_KEYS.forEach((k) => (grand[k] += r.all[k])));
  grand.dialable = visibleCategoryKeys.reduce((sum, k) => sum + (grand[k] || 0), 0);

  const sortKey = state.report.sort.key;
  const dirMul = state.report.sort.dir === "asc" ? 1 : -1;
  const numericKeys = ["dialable", ...CATEGORY_KEYS];
  industryRows.sort((a, b) => {
    if (sortKey === "industryName") return a.industryName.localeCompare(b.industryName, "ja") * dirMul;
    const key = numericKeys.includes(sortKey) ? sortKey : "dialable";
    return ((a.all[key] || 0) - (b.all[key] || 0)) * dirMul;
  });

  const totalCount = industryRows.length;
  const displayRows = industryRows.filter((r) => rowPassesRangeFilters(r.all, []));

  return {
    area,
    industryRows: displayRows,
    totalCount,
    filteredCount: displayRows.length,
    grand,
  };
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


function renderSummary() {
  const panel = $("#summary-panel");
  panel.innerHTML = "";
  if (!state.loaded) return;

  if (state.report.rowMode === "industry") {
    renderSummaryByIndustry(panel);
  } else {
    renderSummaryByList(panel);
  }
}

function renderSummaryByList(panel) {
  const report = computeAreaReport();
  if (report.error) {
    panel.innerHTML = `<p class="muted">${escapeHtml(report.error)}</p>`;
    return;
  }
  const { listRows, grand, extraCols, customDefMap, industryNames, leftoverCols, totalListCount, filteredListCount } = report;

  // --- エリア全体のALL ---
  const grandBar = document.createElement("div");
  grandBar.className = "grand-total-bar";
  grandBar.innerHTML =
    `<span class="grand-label">${escapeHtml(state.report.area)} ALL</span>` +
    `<span>架電可能数 <b>${grand.dialable}</b></span>` +
    `<span>未コール <b>${grand.notCalled}</b></span>` +
    `<span>不在1 <b>${grand.absent1}</b></span>` +
    `<span>不在2 <b>${grand.absent2}</b></span>` +
    `<span>不在3以上 <b>${grand.absent3plus}</b></span>` +
    `<span>有効結果 <b>${grand.validCount}</b></span>` +
    `<span>有効率 ${gradedBoldHtml(grand.validRate, VALID_RATE_THRESHOLDS.badMax, VALID_RATE_THRESHOLDS.goodMin)}</span>` +
    `<span>トスアップ率 ${gradedBoldHtml(grand.tossupRate, TOSSUP_RATE_THRESHOLDS.badMax, TOSSUP_RATE_THRESHOLDS.goodMin)}</span>` +
    `<span>アポイント率 <b>${formatPct(grand.appoRate)}</b></span>` +
    `<span>アプローチNG率 <b>${formatPct(grand.approachNgRate)}</b></span>` +
    `<span>決裁者接触率 <b>${formatPct(grand.honshiNgRate)}</b></span>` +
    `<span>クロージングNG率 <b>${formatPct(grand.closingNgRate)}</b></span>`;
  panel.appendChild(grandBar);

  if (filteredListCount < totalListCount) {
    const notice = document.createElement("p");
    notice.className = "row-count";
    notice.textContent = `表示条件による絞り込み中: 全${totalListCount}件中 ${filteredListCount}件を表示`;
    panel.appendChild(notice);
  }

  if (listRows.length === 0) {
    panel.innerHTML += `<p class="muted">表示条件に一致するリストがありません(条件をリセットすると全件表示されます)</p>`;
    return;
  }

  const maxDialable = Math.max(1, ...listRows.map((r) => r.all.dialable));
  const maxCategory = {};
  CATEGORY_KEYS.forEach((k) => {
    maxCategory[k] = Math.max(1, ...listRows.map((r) => r.all[k] || 0));
  });
  const maxIndustry = {};
  industryNames.forEach((n) => {
    maxIndustry[n] = Math.max(1, ...listRows.map((r) => r.all.industry[n] || 0));
  });
  const maxLeftover = {};
  leftoverCols.forEach((n) => {
    maxLeftover[n] = Math.max(1, ...listRows.map((r) => r.all.leftover[n] || 0));
  });

  const tableWrap = document.createElement("div");
  tableWrap.className = "table-scroll";
  const table = document.createElement("table");
  table.className = "pivot-table report-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const customDefs = extraCols.map((c) => customDefMap[c]).filter(Boolean);
  const visible = state.report.visibleColumns || new Set(DEFAULT_VISIBLE_COLUMNS);
  const visibleBuiltins = getDisplayableColumnList(customDefs, { industryNames, leftoverCols }).filter((h) => visible.has(h.key));
  const headers = [{ key: "listName", label: "リスト名" }, ...visibleBuiltins];
  const cellCtx = { customDefMap, maxDialable, maxCategory, maxIndustry, maxLeftover };
  headers.forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h.label + reportSortArrow(h.key);
    th.className = "sortable";
    th.addEventListener("click", () => toggleReportSort(h.key));
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
      visibleBuiltins.map((h) => renderReportCell(h.key, lr.all, cellCtx)).join("");
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  tableWrap.appendChild(table);

  setupResizableColumns(table, headRow, headers, state.report.columnWidths);

  panel.appendChild(wrapTableForResize(tableWrap, state.report.tableSize));

  const note = document.createElement("p");
  note.className = "muted";
  note.textContent =
    "行はリスト名単位(そのエリア内の全都道府県合計)。架電可能数 = 「表示する項目を選択」でONにしている未コール・不在1・不在2・不在3以上の合計です" +
    "(1つも選んでいない場合は4項目すべての合計)。未コール・不在1〜3以上・その他リスト項目・業種別の列は、件数の下に(  )でカッコ書きの割合もあわせて表示します" +
    "(未コール・不在系・業種別は架電可能数に対する割合、その他リスト項目は有効結果に対する割合です)。" +
    "有効率 = 有効結果 ÷ (不在1〜3以上の合計 + 有効結果)。トスアップ率・アポイント率・アプローチNG率・決裁者接触率(旧:主旨NG率)・クロージングNG率はすべて対有効(÷有効結果)。" +
    "各項目がどの列から数値を拾うか、どの項目を表に表示するかは、上の「項目の定義を設定」「表示する項目を選択」から変更できます(この端末のブラウザにのみ保存されます)。" +
    "業種別の列(業種:飲食・業種:和食など)は、業種別4シート(未コール・不在1・不在2・不在3以上)の値をそのリスト・業種で合計した架電可能な残量の内訳です。" +
    "セルは、その列内での相対的な高さに応じて赤(低い)→緑(普通)→青(高い)のグラデーションで文字色が変化します(背景色は付きません)。" +
    "列見出しクリックで昇順・降順に並び替えできます。既定(架電可能数順)の並びでは、同数の行を有効率→トスアップ率→アポイント率の順で自動的に並び替えます。" +
    "有効率(良い:50%以上/普通:30〜50%/悪い:30%以下)・トスアップ率(良い:5%以上/普通:4〜5%/悪い:4%以下)は評価に応じて文字色を赤〜緑のグラデーションで表示します。" +
    "行を「業種」に切り替えると、業種ごとに未コール・不在1〜3以上・架電可能数を集計した表が見られます。";
  panel.appendChild(note);
}

function renderSummaryByIndustry(panel) {
  const report = computeIndustryReport();
  if (report.error) {
    panel.innerHTML = `<p class="muted">${escapeHtml(report.error)}</p>`;
    return;
  }
  const { industryRows, grand, totalCount, filteredCount } = report;

  const grandBar = document.createElement("div");
  grandBar.className = "grand-total-bar";
  grandBar.innerHTML =
    `<span class="grand-label">${escapeHtml(state.report.area)} ALL業種</span>` +
    `<span>架電可能数 <b>${grand.dialable}</b></span>` +
    `<span>未コール <b>${grand.notCalled}</b></span>` +
    `<span>不在1 <b>${grand.absent1}</b></span>` +
    `<span>不在2 <b>${grand.absent2}</b></span>` +
    `<span>不在3以上 <b>${grand.absent3plus}</b></span>`;
  panel.appendChild(grandBar);

  if (filteredCount < totalCount) {
    const notice = document.createElement("p");
    notice.className = "row-count";
    notice.textContent = `表示条件による絞り込み中: 全${totalCount}件中 ${filteredCount}件を表示`;
    panel.appendChild(notice);
  }

  if (industryRows.length === 0) {
    panel.innerHTML += `<p class="muted">表示条件に一致する業種がありません(条件をリセットすると全件表示されます)</p>`;
    return;
  }

  const maxDialable = Math.max(1, ...industryRows.map((r) => r.all.dialable));
  const maxCategory = {};
  CATEGORY_KEYS.forEach((k) => {
    maxCategory[k] = Math.max(1, ...industryRows.map((r) => r.all[k] || 0));
  });

  const tableWrap = document.createElement("div");
  tableWrap.className = "table-scroll";
  const table = document.createElement("table");
  table.className = "pivot-table report-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const visible = state.report.visibleColumns || new Set(DEFAULT_VISIBLE_COLUMNS);
  const visibleBuiltins = getDisplayableColumnList([], { rowMode: "industry" }).filter((h) => visible.has(h.key));
  const headers = [{ key: "industryName", label: "業種" }, ...visibleBuiltins];
  const cellCtx = { maxDialable, maxCategory };
  headers.forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h.label + reportSortArrow(h.key);
    th.className = "sortable";
    th.addEventListener("click", () => toggleReportSort(h.key));
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  industryRows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.className = "report-all-row";
    tr.innerHTML =
      `<td class="pref-cell">${escapeHtml(r.industryName)}</td>` + visibleBuiltins.map((h) => renderReportCell(h.key, r.all, cellCtx)).join("");
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  tableWrap.appendChild(table);

  setupResizableColumns(table, headRow, headers, state.report.columnWidths);
  panel.appendChild(wrapTableForResize(tableWrap, state.report.tableSize));

  const note = document.createElement("p");
  note.className = "muted";
  note.textContent =
    "行は業種単位(そのエリア内の全リスト・全都道府県合計)。業種別4シート(未コール・不在1・不在2・不在3以上)を業種名で横断集計しています。" +
    "架電可能数 = 「表示する項目を選択」でONにしている未コール・不在1・不在2・不在3以上の合計です(1つも選んでいない場合は4項目すべての合計)。" +
    "リストデータシートには業種別の内訳が無いため、有効率などそれ以外の項目は行=業種では表示できません(行=リスト名に切り替えると見られます)。" +
    "セルは、その列内での相対的な高さに応じて赤(低い)→緑(普通)→青(高い)のグラデーションで文字色が変化します(背景色は付きません)。列見出しクリックで並び替えできます。";
  panel.appendChild(note);
}

// ------------------------------------------------------------
// 描画: 分析タブ(日次スナップショットの週次/曜日別集計)
//
// スプレッドシート側でGoogle Apps Script(お渡ししたスクリプト)を設定すると、
// 毎日自動的に config.js の logSheetName で指定したシート(既定「トスアップログ」)へ
// リスト名・都道府県・エリア・日付・トスアップ累計・増加分 が1行ずつ記録されます。
// このアプリはそのシートを他のシートと同じ「読み込み専用」の方法で読み込んで
// 集計するだけで、書き込みは一切行いません。
// ------------------------------------------------------------

function getLogSheetName() {
  return (CONFIG && CONFIG.logSheetName) || "トスアップログ";
}

// ログシートの「日付」列の値をJSのDateに変換する。
// Apps Script側が文字列("2026-09-05"等)で書き込むことを想定しているが、
// スプレッドシート側で日付として自動認識され、UNFORMATTED_VALUEでシリアル値
// (1899-12-30起点の日数)として返ってくる場合にも対応する。解釈できなければnull。
function parseLogDate(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "number" && isFinite(raw)) {
    const base = Date.UTC(1899, 11, 30);
    return new Date(base + raw * 86400000);
  }
  const s = String(raw).trim();
  const m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (m) {
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// 月曜始まりの週のラベル(例: "9/1週")。同じ週なら常に同じラベルになるよう、
// その週の月曜日の日付を基準にする。
function getWeekMonday(date) {
  const day = date.getUTCDay(); // 0=日, 1=月, ... 6=土
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(date.getTime());
  monday.setUTCDate(monday.getUTCDate() + diffToMonday);
  return monday;
}
function getWeekLabel(date) {
  const monday = getWeekMonday(date);
  return `${monday.getUTCMonth() + 1}/${monday.getUTCDate()}週`;
}

const WEEKDAY_LABELS_BY_JS_DAY = ["日", "月", "火", "水", "木", "金", "土"];
const WEEKDAY_ORDER = ["月", "火", "水", "木", "金", "土", "日"];
function getWeekdayLabel(date) {
  return WEEKDAY_LABELS_BY_JS_DAY[date.getUTCDay()];
}

function analysisSortArrow(key) {
  const curKey = state.analysis.sort.key || "cumulative";
  if (curKey !== key) return "";
  return state.analysis.sort.dir === "asc" ? " ▲" : " ▼";
}

function toggleAnalysisSort(key) {
  const s = state.analysis.sort;
  const curKey = s.key || "cumulative";
  if (curKey !== key) {
    state.analysis.sort = { key, dir: "desc" };
  } else {
    state.analysis.sort = { key, dir: s.dir === "desc" ? "asc" : "desc" };
  }
  renderAnalysis();
}

// ログシートを集計し、選択中エリア・都道府県フィルタに絞った上で、
// リスト名(ALLは都道府県合計)ごとに「現在の累計」と、週次/曜日別の「増加分」の合計を返す。
function computeAnalysisReport() {
  const area = state.report.area;
  if (!area) return { error: "エリアがありません" };

  const logSheetName = getLogSheetName();
  const logSheet = state.sheets[logSheetName];
  if (!logSheet) {
    return { error: "missing-log-sheet", logSheetName };
  }

  const { headers, rows } = logSheet;
  const idx = {
    listName: headers.indexOf("リスト名"),
    pref: headers.indexOf("都道府県"),
    area: headers.indexOf("エリア"),
    date: headers.indexOf("日付"),
    cumulative: headers.indexOf("トスアップ累計"),
    delta: headers.indexOf("増加分"),
  };
  if (idx.listName === -1 || idx.pref === -1 || idx.date === -1) {
    return {
      error: `「${logSheetName}」シートの列構成が想定と異なります(リスト名・都道府県・日付の列が必要です)`,
    };
  }

  const mode = state.analysis.mode;
  const byList = new Map(); // listName -> Map(pref -> { cols: {label->合計}, latestCumulative, latestDate })
  const columnKeys = new Set();
  const weekSortKey = new Map(); // 週ラベル -> ソート用タイムスタンプ

  rows.forEach((cells) => {
    if (idx.area !== -1) {
      const rowArea = String(cells[idx.area] ?? "");
      if (rowArea && rowArea !== area) return;
    }
    const listName = String(cells[idx.listName] ?? "");
    const pref = String(cells[idx.pref] ?? "");
    if (!listName || !pref) return;
    if (state.globalPrefectures.size > 0 && !state.globalPrefectures.has(pref)) return;

    const date = parseLogDate(cells[idx.date]);
    if (!date) return;

    const deltaRaw = idx.delta !== -1 ? parseFloat(cells[idx.delta]) : NaN;
    const delta = isNaN(deltaRaw) ? 0 : deltaRaw;
    const cumulativeRaw = idx.cumulative !== -1 ? parseFloat(cells[idx.cumulative]) : NaN;

    const colKey = mode === "week" ? getWeekLabel(date) : getWeekdayLabel(date);
    columnKeys.add(colKey);
    if (mode === "week") weekSortKey.set(colKey, getWeekMonday(date).getTime());

    if (!byList.has(listName)) byList.set(listName, new Map());
    const prefMap = byList.get(listName);
    if (!prefMap.has(pref)) prefMap.set(pref, { cols: {}, latestCumulative: 0, latestDate: null });
    const entry = prefMap.get(pref);
    entry.cols[colKey] = (entry.cols[colKey] || 0) + delta;
    if (!isNaN(cumulativeRaw) && (!entry.latestDate || date > entry.latestDate)) {
      entry.latestCumulative = cumulativeRaw;
      entry.latestDate = date;
    }
  });

  const columns =
    mode === "week"
      ? Array.from(columnKeys).sort((a, b) => weekSortKey.get(a) - weekSortKey.get(b))
      : WEEKDAY_ORDER.filter((w) => columnKeys.has(w));

  const listRows = [];
  byList.forEach((prefMap, listName) => {
    const all = { cols: {}, latestCumulative: 0, latestDate: null };
    columns.forEach((c) => (all.cols[c] = 0));
    const prefRows = [];
    prefMap.forEach((entry, pref) => {
      columns.forEach((c) => (all.cols[c] += entry.cols[c] || 0));
      all.latestCumulative += entry.latestCumulative || 0;
      if (!all.latestDate || (entry.latestDate && entry.latestDate > all.latestDate)) {
        all.latestDate = entry.latestDate;
      }
      prefRows.push({ pref, cols: entry.cols, latestCumulative: entry.latestCumulative });
    });
    prefRows.sort((a, b) => a.pref.localeCompare(b.pref, "ja"));
    listRows.push({ listName, all, prefRows });
  });

  const sortKey = state.analysis.sort.key || "cumulative";
  const dirMul = state.analysis.sort.dir === "asc" ? 1 : -1;
  listRows.sort((a, b) => {
    if (sortKey === "listName") return a.listName.localeCompare(b.listName, "ja") * dirMul;
    const av = sortKey === "cumulative" ? a.all.latestCumulative : a.all.cols[sortKey] || 0;
    const bv = sortKey === "cumulative" ? b.all.latestCumulative : b.all.cols[sortKey] || 0;
    return (av - bv) * dirMul;
  });

  return { area, logSheetName, columns, listRows, mode };
}

function renderAnalysis() {
  const panel = $("#analysis-panel");
  if (!panel) return;
  panel.innerHTML = "";
  if (!state.loaded) return;

  const report = computeAnalysisReport();
  if (report.error === "missing-log-sheet") {
    panel.innerHTML =
      `<p class="muted">「${escapeHtml(report.logSheetName)}」シートがまだ見つかりません。` +
      `スプレッドシート側で日次の自動記録(Google Apps Script)を設定すると、このタブにデータが表示されるようになります。` +
      `設定方法はREADME、またはお渡ししたセットアップ手順をご覧ください。設定後は、翌日以降の記録からこのタブに反映されます。</p>`;
    return;
  }
  if (report.error) {
    panel.innerHTML = `<p class="muted">${escapeHtml(report.error)}</p>`;
    return;
  }

  const { columns, listRows } = report;

  if (columns.length === 0 || listRows.length === 0) {
    panel.innerHTML = `<p class="muted">「${escapeHtml(report.logSheetName)}」にまだデータがありません(スプレッドシート側の日次記録が始まるとここに表示されます)</p>`;
    return;
  }

  const maxCumulative = Math.max(1, ...listRows.map((r) => r.all.latestCumulative));
  const maxCol = {};
  columns.forEach((c) => {
    maxCol[c] = Math.max(1, ...listRows.map((r) => r.all.cols[c] || 0));
  });

  const tableWrap = document.createElement("div");
  tableWrap.className = "table-scroll";
  const table = document.createElement("table");
  table.className = "pivot-table report-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const headers = [
    { key: "listName", label: "リスト名" },
    { key: "pref", label: "都道府県" },
    { key: "cumulative", label: "現在の累計" },
    ...columns.map((c) => ({ key: c, label: c })),
  ];
  headers.forEach((h) => {
    const th = document.createElement("th");
    if (h.key === "pref") {
      th.textContent = h.label;
    } else {
      th.textContent = h.label + analysisSortArrow(h.key);
      th.className = "sortable";
      th.addEventListener("click", () => toggleAnalysisSort(h.key));
    }
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  listRows.forEach((lr) => {
    const expanded = state.analysis.expandedLists.has(lr.listName);
    const tr = document.createElement("tr");
    tr.className = "report-all-row";
    tr.innerHTML =
      `<td class="pref-cell"><span class="row-toggle">${expanded ? "▼" : "▶"}</span>${escapeHtml(lr.listName)}</td>` +
      `<td class="pref-cell">ALL</td>` +
      heatCellHtml(lr.all.latestCumulative, maxCumulative) +
      columns.map((c) => heatCellHtml(lr.all.cols[c], maxCol[c])).join("");
    tr.addEventListener("click", () => {
      if (expanded) state.analysis.expandedLists.delete(lr.listName);
      else state.analysis.expandedLists.add(lr.listName);
      renderAnalysis();
    });
    tbody.appendChild(tr);

    if (expanded) {
      lr.prefRows.forEach((pr) => {
        const subTr = document.createElement("tr");
        subTr.className = "report-pref-row";
        subTr.innerHTML =
          `<td class="pref-cell"></td>` +
          `<td class="pref-cell">${escapeHtml(pr.pref)}</td>` +
          `<td class="count-cell">${pr.latestCumulative}</td>` +
          columns.map((c) => heatCellHtml(pr.cols[c], maxCol[c])).join("");
        tbody.appendChild(subTr);
      });
    }
  });
  table.appendChild(tbody);
  tableWrap.appendChild(table);

  setupResizableColumns(table, headRow, headers, state.analysis.columnWidths);
  panel.appendChild(wrapTableForResize(tableWrap, state.analysis.tableSize));

  const note = document.createElement("p");
  note.className = "muted";
  note.textContent =
    "行はリスト名単位(ALL=そのエリア内の全都道府県合計)。行をクリックすると都道府県別の内訳を開閉できます。" +
    "「現在の累計」はトスアップの最新の累計値です。それ以外の列(週次表示なら「9/1週」のような週単位、曜日別表示なら「月」〜「日」)は、" +
    "その期間に新たに増えたトスアップの合計(増加分)です。上部の「週次」「曜日別」ボタンで表示単位を切り替えられます。" +
    "セルは、その列内での相対的な高さに応じて赤(低い)→緑(普通)→青(高い)のグラデーションで文字色が変化します(背景色は付きません)。" +
    "列見出しクリックでその項目を基準に並び替えできます。";
  panel.appendChild(note);
}

// ------------------------------------------------------------
// 描画: クール戦略タブ(残量があるリストを、有効率ベース/主旨ベースの優先順位で並べ、
// 業種ごとの「繋がりやすい時間帯」の目安を添えて、クールごとのリスト選定を支援する)
//
// 大前提として「残量が残っているリスト」だけを対象にする。並び順は2通り:
// ・有効率ベース: 有効率が高い順→(同率なら)トスアップ率が高い順(素直に繋がりやすいリスト)
// ・主旨ベース(決裁者有効): 主旨NG率が高い順→(同率なら)クロージングNG率が高い順
//   (有効率が低くても、決裁者への主旨説明・クロージングまで到達できているなら
//    「話せているリスト」として評価する考え方)
// 業種ごとの時間帯の目安(CONFIG.industryTimeSlotHints)は実際の架電時刻データに基づくもの
// ではなく、一般的な業種特性からの仮説(目安)。各リストの中で残量が最も多い業種をそのリストの
// 主要業種とみなし、選択中のクールに合っていれば「◎」で示す(並び順そのものは変えない)。
// ------------------------------------------------------------

function renderStrategyCoolSwitcher() {
  const container = $("#strategy-cool-switcher");
  if (!container) return;
  container.innerHTML = "";
  const cools = (CONFIG && CONFIG.cools) || [];
  if (!cools.some((c) => c.id === state.strategy.cool)) {
    state.strategy.cool = cools[0] ? cools[0].id : 1;
  }
  cools.forEach((cool) => {
    const btn = document.createElement("button");
    btn.className = "area-btn" + (state.strategy.cool === cool.id ? " active" : "");
    btn.textContent = `${cool.label}(${cool.time})`;
    btn.addEventListener("click", () => {
      state.strategy.cool = cool.id;
      renderStrategyCoolSwitcher();
      renderStrategy();
    });
    container.appendChild(btn);
  });
}

// 業種名からCONFIG.industryTimeSlotHintsに定義されたカテゴリを判定する(部分一致)。該当が無ければnull。
function classifyIndustry(name) {
  if (!name) return null;
  const hints = (CONFIG && CONFIG.industryTimeSlotHints) || [];
  for (const hint of hints) {
    if ((hint.keywords || []).some((kw) => name.includes(kw))) return hint;
  }
  return null;
}

// リストの業種内訳オブジェクトから、残量が最も多い業種名を返す(無ければnull)
function dominantIndustryName(industryObj) {
  let best = null;
  let bestVal = 0;
  Object.entries(industryObj || {}).forEach(([name, val]) => {
    if ((val || 0) > bestVal) {
      bestVal = val;
      best = name;
    }
  });
  return best;
}

// 「クール戦略」タブの表示条件(上限/下限フィルター)で絞り込み可能な項目の一覧。
// 集計タブと同じ考え方・同じUI部品を使うが、対象項目はクール戦略タブの表に実際に表示している列のみ。
const STRATEGY_RANGE_FILTER_COLUMNS = [
  { key: "dialable", label: "架電可能数" },
  { key: "validRate", label: "有効率" },
  { key: "tossupRate", label: "トスアップ率" },
  { key: "honshiNgRate", label: "決裁者接触率" },
  { key: "closingNgRate", label: "クロージングNG率" },
];
const STRATEGY_RANGE_FILTER_PERCENT_KEYS = new Set(["validRate", "tossupRate", "honshiNgRate", "closingNgRate"]);

function rowPassesStrategyRangeFilters(row) {
  for (const [key, f] of Object.entries(state.strategy.rangeFilters)) {
    if (!f || (f.min === null && f.max === null)) continue;
    const value = row[key];
    if (value === null || value === undefined || isNaN(value)) return false;
    if (f.min !== null && value < f.min) return false;
    if (f.max !== null && value > f.max) return false;
  }
  return true;
}

// 「表示条件を設定」パネルの中身を描画する(項目一覧が固定のため、エリア切替時などに毎回作り直しても
// 実質問題は無いが、集計タブと同じく頻繁な再描画のたびには作り直さない = 入力中の値を保持するため)
function renderStrategyRangeFilters() {
  const container = $("#strategy-range-filters");
  if (!container) return;
  container.innerHTML = "";

  STRATEGY_RANGE_FILTER_COLUMNS.forEach((col) => {
    if (!state.strategy.rangeFilters[col.key]) {
      state.strategy.rangeFilters[col.key] = { min: null, max: null };
    }
    const f = state.strategy.rangeFilters[col.key];
    const label = STRATEGY_RANGE_FILTER_PERCENT_KEYS.has(col.key) ? `${col.label}(%)` : col.label;

    const row = document.createElement("div");
    row.className = "range-filter-row";
    row.innerHTML =
      `<span class="range-filter-label">${escapeHtml(label)}</span>` +
      `<span class="numeric-row">` +
      `<input type="number" placeholder="下限" value="${f.min ?? ""}" />` +
      `<span>〜</span>` +
      `<input type="number" placeholder="上限" value="${f.max ?? ""}" />` +
      `</span>`;
    const [minInput, , maxInput] = row.querySelector(".numeric-row").children;
    minInput.addEventListener("change", (e) => {
      f.min = e.target.value === "" ? null : Number(e.target.value);
      renderStrategy();
    });
    maxInput.addEventListener("change", (e) => {
      f.max = e.target.value === "" ? null : Number(e.target.value);
      renderStrategy();
    });
    container.appendChild(row);
  });
}

$("#strategy-range-reset").addEventListener("click", () => {
  Object.keys(state.strategy.rangeFilters).forEach((key) => {
    state.strategy.rangeFilters[key] = { min: null, max: null };
  });
  renderStrategyRangeFilters();
  renderStrategy();
});

function computeStrategyReport() {
  const base = computeAreaReport();
  if (base.error) return { error: base.error };

  // クール戦略タブでは「表示する項目を選択」の設定に関わらず、常に未コール〜不在3以上の4項目全部の
  // 合計を架電可能数として扱う(集計タブのように選択した項目だけを見ているわけではないため)。
  const eligible = base.listRows.filter((lr) => CATEGORY_KEYS.reduce((sum, k) => sum + (lr.all[k] || 0), 0) > 0);
  if (eligible.length === 0) {
    return { error: "架電可能なリストが見つかりません(未コール・不在1〜3以上がすべて0のリストのみのため対象外です)" };
  }

  const mode = state.strategy.mode; // "validRate"(有効率ベース) | "honshi"(主旨ベース)
  const allRows = eligible.map((lr) => {
    const domName = dominantIndustryName(lr.all.industry);
    const dialable = CATEGORY_KEYS.reduce((sum, k) => sum + (lr.all[k] || 0), 0);
    return {
      listName: lr.listName,
      dialable,
      validRate: lr.all.validRate,
      tossupRate: lr.all.tossupRate,
      honshiNgRate: lr.all.honshiNgRate,
      closingNgRate: lr.all.closingNgRate,
      dominantIndustry: domName,
      hint: classifyIndustry(domName),
    };
  });

  // 表示条件(上限/下限)による絞り込み。残量>0の対象件数(totalEligible)は絞り込み前の値のまま。
  const rows = allRows.filter((r) => rowPassesStrategyRangeFilters(r));

  const primaryKey = mode === "honshi" ? "honshiNgRate" : "validRate";
  const secondaryKey = mode === "honshi" ? "closingNgRate" : "tossupRate";
  const val = (r, key) => (r[key] === null || r[key] === undefined ? -Infinity : r[key]);
  rows.sort((a, b) => {
    const diff = val(b, primaryKey) - val(a, primaryKey);
    if (diff !== 0) return diff;
    return val(b, secondaryKey) - val(a, secondaryKey);
  });

  const cool = state.strategy.cool;
  const displayRows = state.strategy.onlyRecommended
    ? rows.filter((r) => r.hint && (r.hint.bestCools || []).includes(cool))
    : rows;

  return {
    mode,
    cool,
    rows: displayRows,
    totalEligible: allRows.length,
    filteredEligible: rows.length,
  };
}

// 「おすすめクール・メモ」セルのHTML。選択中クールに合っていれば「◎」を添える(背景色は付けない)。
function coolHintCellHtml(hint, currentCool) {
  if (!hint) {
    return `<td class="pref-cell"><span class="muted-inline">業種不明(判定対象外)</span></td>`;
  }
  const cools = (CONFIG && CONFIG.cools) || [];
  const labelOf = (id) => {
    const c = cools.find((x) => x.id === id);
    return c ? c.label.replace("クール", "") : id;
  };
  const best = (hint.bestCools || []).map(labelOf).join("・") || "—";
  const isMatch = (hint.bestCools || []).includes(currentCool);
  const mark = isMatch
    ? `<span style="color:hsl(240,72%,38%); font-weight:700;">◎ このクールにおすすめ</span><br/>`
    : "";
  return `<td class="pref-cell">${mark}おすすめ: ${escapeHtml(best)}<div class="muted-inline">${escapeHtml(hint.note)}</div></td>`;
}

function renderStrategy() {
  const panel = $("#strategy-panel");
  if (!panel) return;
  panel.innerHTML = "";
  if (!state.loaded) return;

  const report = computeStrategyReport();
  if (report.error) {
    panel.innerHTML = `<p class="muted">${escapeHtml(report.error)}</p>`;
    return;
  }

  const { rows, cool, mode, totalEligible, filteredEligible } = report;

  if (filteredEligible < totalEligible) {
    const notice = document.createElement("p");
    notice.className = "row-count";
    notice.textContent = `表示条件による絞り込み中: 架電可能な全${totalEligible}件中 ${filteredEligible}件が対象`;
    panel.appendChild(notice);
  }

  if (rows.length === 0) {
    panel.innerHTML += `<p class="muted">条件に合うリストが見つかりません(表示条件や「このクールにおすすめの業種のみ表示」のチェックを見直すと表示されます)</p>`;
    return;
  }

  const tableWrap = document.createElement("div");
  tableWrap.className = "table-scroll";
  const table = document.createElement("table");
  table.className = "pivot-table report-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const headers = [
    { key: "rank", label: "順位" },
    { key: "listName", label: "リスト名" },
    { key: "dialable", label: "架電可能数" },
    { key: "validRate", label: "有効率" },
    { key: "tossupRate", label: "トスアップ率" },
    { key: "honshiNgRate", label: "決裁者接触率" },
    { key: "closingNgRate", label: "クロージングNG率" },
    { key: "dominantIndustry", label: "主要業種" },
    { key: "hint", label: "おすすめクール・メモ" },
  ];
  headers.forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h.label;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  rows.forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="count-cell">${i + 1}</td>` +
      `<td class="pref-cell">${escapeHtml(r.listName)}</td>` +
      `<td class="count-cell">${r.dialable}</td>` +
      gradedPctHtml(r.validRate, VALID_RATE_THRESHOLDS.badMax, VALID_RATE_THRESHOLDS.goodMin) +
      gradedPctHtml(r.tossupRate, TOSSUP_RATE_THRESHOLDS.badMax, TOSSUP_RATE_THRESHOLDS.goodMin) +
      `<td class="count-cell">${formatPct(r.honshiNgRate)}</td>` +
      `<td class="count-cell">${formatPct(r.closingNgRate)}</td>` +
      `<td class="pref-cell">${r.dominantIndustry ? escapeHtml(r.dominantIndustry) : "—"}</td>` +
      coolHintCellHtml(r.hint, cool);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  tableWrap.appendChild(table);

  setupResizableColumns(table, headRow, headers, state.strategy.columnWidths);
  panel.appendChild(wrapTableForResize(tableWrap, state.strategy.tableSize));

  const cools = (CONFIG && CONFIG.cools) || [];
  const currentCool = cools.find((c) => c.id === cool);
  const note = document.createElement("p");
  note.className = "muted";
  note.textContent =
    "架電可能なリスト(未コール・不在1〜3以上のいずれかが残っている)のみを対象に、順位はドラッグや列見出しクリックでは変わりません(戦略上の優先順位を示す固定の並びです)。" +
    (mode === "honshi"
      ? "「主旨ベース(決裁者有効)」= 決裁者接触率(旧:主旨NG率)が高い順→同率ならクロージングNG率が高い順で並べています(有効率が低くても、決裁者への主旨説明・クロージングまで到達できているリストを評価する考え方です)。"
      : "「有効率ベース」= 有効率が高い順→同率ならトスアップ率が高い順で並べています(架電可能数がある中での大前提の優先順位です)。") +
    `現在選択中のクールは${currentCool ? `${currentCool.label}(${currentCool.time})` : "—"}です。` +
    "「主要業種」は、そのリストの中で残量が最も多い業種です。「おすすめクール・メモ」は、その業種が一般的に繋がりやすいとされる時間帯の目安で、実際の架電時刻データではなく一般的な業種特性に基づく仮説です(config.jsのindustryTimeSlotHintsで調整できます)。選択中のクールに合う場合は「◎」を表示します。";
  panel.appendChild(note);
}

// ------------------------------------------------------------
// 変更履歴タブ・ご要望フォーム
// (シートの読み込みとは無関係に、config.jsの内容だけで表示できる)
// ------------------------------------------------------------

function renderChangelog() {
  renderChangelogList();
  renderFeedbackForm();
}

function renderChangelogList() {
  const panel = $("#changelog-panel");
  if (!panel) return;
  panel.innerHTML = "";
  const entries = [...((CONFIG && CONFIG.changelog) || [])].sort((a, b) => {
    const aKey = `${a.date || ""} ${a.time || "00:00"}`;
    const bKey = `${b.date || ""} ${b.time || "00:00"}`;
    return bKey.localeCompare(aKey); // 新しい日時が上に来るように降順
  });

  if (entries.length === 0) {
    panel.innerHTML = `<p class="muted">変更履歴はまだありません</p>`;
    return;
  }

  const list = document.createElement("div");
  list.className = "changelog-list";
  entries.forEach((entry) => {
    const item = document.createElement("div");
    item.className = "changelog-item";
    const dateLabel = entry.time ? `${entry.date} ${entry.time}` : entry.date || "";
    item.innerHTML =
      `<div class="changelog-date">${escapeHtml(dateLabel)}</div>` +
      `<div class="changelog-title">${escapeHtml(entry.title || "")}</div>` +
      (entry.description ? `<div class="changelog-desc">${escapeHtml(entry.description)}</div>` : "");
    list.appendChild(item);
  });
  panel.appendChild(list);
}

// ご要望フォーム。config.jsのscriptWebAppUrlが未設定の場合は、代わりにセットアップ案内を表示する。
// 送信は Google Apps Script の doPost(e) 宛てに fetch(mode: "no-cors") で行う仕様のため、
// レスポンス内容は読み取れない(ブラウザの仕様上の制約)。そのため送信自体が例外を投げなければ
// 「送信しました」と楽観的に表示する。
function renderFeedbackForm() {
  const container = $("#feedback-form-container");
  if (!container) return;
  container.innerHTML = "";

  const url = ((CONFIG && CONFIG.scriptWebAppUrl) || "").trim();
  if (!url) {
    container.innerHTML =
      `<p class="muted">ご要望フォームはまだセットアップされていません。config.jsの「scriptWebAppUrl」を設定すると使えるようになります` +
      `(手順はREADME.mdの「変更履歴タブとご要望フォーム」を参照してください)。</p>`;
    return;
  }

  const wrap = document.createElement("div");
  wrap.className = "feedback-form";
  wrap.innerHTML =
    `<label>お名前(任意)</label>` +
    `<input type="text" id="feedback-name" placeholder="例: 阿部" />` +
    `<label>ご要望・仕様変更のご依頼内容</label>` +
    `<textarea id="feedback-message" rows="4" placeholder="どのタブの、どんな変更を希望するか具体的にご記入ください"></textarea>` +
    `<button id="feedback-submit" class="btn-primary">送信する</button>` +
    `<span id="feedback-status" class="muted-inline"></span>`;
  container.appendChild(wrap);

  $("#feedback-submit").addEventListener("click", () => submitFeedback(url));
}

async function submitFeedback(url) {
  const nameInput = $("#feedback-name");
  const messageInput = $("#feedback-message");
  const statusEl = $("#feedback-status");
  const message = messageInput.value.trim();

  if (!message) {
    statusEl.textContent = "内容を入力してください";
    return;
  }

  statusEl.textContent = "送信中...";
  try {
    await fetch(url, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "feedback",
        name: nameInput.value.trim(),
        message,
        page: state.activeTab,
        sentAt: new Date().toISOString(),
      }),
    });
    statusEl.textContent = "送信しました。ご協力ありがとうございます。";
    messageInput.value = "";
  } catch (err) {
    console.error(err);
    statusEl.textContent = "送信に失敗しました。時間をおいて再度お試しください。";
  }
}

// 「分析」タブの「今すぐ記録する」ボタン。config.jsのscriptWebAppUrlに設定したGoogle Apps Scriptの
// doPost(e)へ { action: "recordSnapshot" } を送り、スプレッドシート側で即座にrecordDailySnapshot()を
// 実行させる(本来は毎日決まった時刻に自動実行されるものを、その場で手動実行するためのボタン)。
// ご要望フォームと同様にfetch(mode: "no-cors")のためレスポンス内容は読み取れず、送信自体が
// 例外を投げなければ楽観的に「リクエストしました」と表示する。実際に反映されたかどうかは、
// 「再読み込み」ボタンでシートを読み直すか、スプレッドシート側の「トスアップログ」で確認できる。
async function triggerManualSnapshot() {
  const statusEl = $("#snapshot-trigger-status");
  const url = ((CONFIG && CONFIG.scriptWebAppUrl) || "").trim();
  if (!url) {
    if (statusEl) {
      statusEl.textContent =
        "セットアップされていません(config.jsの「scriptWebAppUrl」を設定すると使えるようになります)";
    }
    return;
  }

  if (statusEl) statusEl.textContent = "記録をリクエスト中...";
  try {
    await fetch(url, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "recordSnapshot", sentAt: new Date().toISOString() }),
    });
    if (statusEl) {
      statusEl.textContent = "記録をリクエストしました。数秒待ってから「再読み込み」ボタンを押すと反映されます。";
    }
  } catch (err) {
    console.error(err);
    if (statusEl) statusEl.textContent = "リクエストに失敗しました。時間をおいて再度お試しください。";
  }
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
renderChangelog(); // シートの読み込み成否に関わらず表示できるよう、loadAllとは独立して呼び出す
loadAll();
