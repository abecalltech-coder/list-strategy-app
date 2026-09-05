// ============================================================
// 設定ファイル(このファイルだけ編集すればOKです)
// ============================================================
window.APP_CONFIG = {
  // スプレッドシートのURLの下記の部分がIDです:
  // https://docs.google.com/spreadsheets/d/【ここがID】/edit
  spreadsheetId: "1tjuLmmWgGgkpe5dl6VKjJgSYbtyHtgK0xV_lG6Um3YM", // 「リスト元データ」

  // Google Cloud Consoleで発行したAPIキー(手順はREADME.md参照)
  apiKey: "AIzaSyBSfcP4IhZH5dWs6wh-cVqVCxCCusA7Csw",

  // 読み込み対象から除外したいシート名(メモ用・空シートなど)
  excludeSheets: ["整理用"],

  // 各シート共通の固定列(0始まり)。A列=0, B列=1
  listNameColumnIndex: 0, // リスト名
  prefectureColumnIndex: 1, // 都道府県

  // 都道府県(B列)が空欄の行を除外するか。
  // ピボットテーブル形式のシートで最後に出てくる「総計」「積み上げ集計」等の
  // 集計行を誤ってデータ扱いしないようにするための設定です。
  dropRowsWithEmptyPrefecture: true,

  // 1列をカテゴリ選択フィルタにするかテキスト検索にするかの閾値
  // (ユニーク値の数がこの数以下ならチェックボックス選択、それより多ければテキスト検索)
  categoricalThreshold: 25,

  // 「分析」タブが読み込む、日次のトスアップ記録シート名。
  // スプレッドシート側でGoogle Apps Scriptを設定すると、このシートに毎日自動で記録が追加されます
  // (このアプリはこのシートを読み込むだけで、書き込みは一切行いません)。
  logSheetName: "トスアップログ",
};
