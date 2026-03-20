// ══════════════════════════════════════════════════════
//  集金管理アプリ - Google スプレッドシート連携スクリプト
// ══════════════════════════════════════════════════════
//
// 【セットアップ手順】
//  1. Google スプレッドシートを新規作成する
//  2. メニュー「拡張機能」→「Apps Script」を開く
//  3. このファイルの内容をすべてコピーして貼り付ける
//  4. 「デプロイ」→「新しいデプロイ」をクリック
//  5. 種類: 「ウェブアプリ」を選択
//  6. 「次のユーザーとして実行」: 自分
//  7. 「アクセスできるユーザー」: 全員
//  8. 「デプロイ」ボタンを押す → 表示された URL をコピー
//  9. 集金管理アプリの「⚙ 連携設定」にその URL を貼り付けて保存
//
// 【シート構成】
//  - 現金集金 : 店舗別シート（例: 下関店_2026年3月）
//              列: 店舗 / ルート / 名前 / 住所 / 金額 / 集金日 / 集金日時 / キー
//  - 口座振替 : 「口座振替」シート（全店統合）
//              列: 店舗 / ルート / 月 / 名前 / 住所 / 金額 / 完了日時 / キー
//  - 振込入金 : 「振込入金」シート（全店統合）
//              列: 店舗 / ルート / 月 / 名前 / 住所 / 金額 / 振込日 / 記録日時 / キー
//  - 連絡事項 : 「連絡事項」シート
// ══════════════════════════════════════════════════════

// ─── シート定義 ───────────────────────────────────────
const CASH_HEADERS = ['ルート', '月', '名前', '住所', '金額', '集金日', '集金時刻', 'キー'];
const CASH_COL_WIDTHS = [70, 70, 160, 260, 90, 100, 160, 1];

const BANK_SHEET   = '口座振替';
const BANK_HEADERS = ['店舗', 'ルート', '月', '名前', '住所', '金額', '完了日時', 'キー'];
const BANK_COL_WIDTHS = [100, 70, 70, 160, 260, 90, 160, 1];

const TRANSFER_SHEET   = '振込入金';
const TRANSFER_HEADERS = ['店舗', 'ルート', '月', '名前', '住所', '金額', '振込日', '記録日時', 'キー'];
const TRANSFER_COL_WIDTHS = [100, 70, 70, 160, 260, 90, 100, 160, 1];

const MSG_SHEET   = '連絡事項';
const MSG_HEADERS = ['ID', '店舗', 'ルート', '顧客名', '連絡内容', '送信日時'];

const AMOUNT_LOG_SHEET   = '金額修正';
const AMOUNT_LOG_HEADERS = ['店舗', 'ルート', '月', '名前', '修正前金額', '修正後金額', '修正日時', 'キー'];
const AMOUNT_LOG_COL_WIDTHS = [100, 70, 70, 160, 100, 100, 160, 1];

// doGet でチェックデータ読み取りをスキップするシート名
const SKIP_SHEETS = new Set([BANK_SHEET, TRANSFER_SHEET, MSG_SHEET, AMOUNT_LOG_SHEET]);

// ─── メインハンドラ ───────────────────────────────────
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const { action, record } = payload;
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    // ── 現金集金 追加／更新 ──
    if (action === 'add') {
      const sheetName = formatCashSheetName(record.store, record.dataMonth);
      const sheet = getOrCreateSheet(ss, sheetName, CASH_HEADERS, '#c2410c', CASH_COL_WIDTHS);
      upsertRow(sheet, record.key, buildCashRow(record, payload.collectDate || ''));
      sortCashSheet(sheet);

    // ── 現金集金 削除 ──
    } else if (action === 'remove') {
      const sheetName = formatCashSheetName(record.store, record.dataMonth);
      const sheet = ss.getSheetByName(sheetName);
      if (sheet) removeRow(sheet, record.key, CASH_HEADERS.length);

    // ── 口座振替 完了 ──
    } else if (action === 'bankComplete') {
      const sheet = getOrCreateSheet(ss, BANK_SHEET, BANK_HEADERS, '#1d4ed8', BANK_COL_WIDTHS);
      upsertRow(sheet, record.key, buildBankRow(record, payload.completedAt || ''));
      sortSheet(sheet);

    // ── 口座振替 削除（引き落とし失敗 → 現金集金に変更） ──
    } else if (action === 'bankRemove') {
      const sheet = ss.getSheetByName(BANK_SHEET);
      if (sheet) removeRow(sheet, record.key, BANK_HEADERS.length);

    // ── 口座振替 一括登録（バッチ：一括読み書きでタイムアウト防止） ──
    } else if (action === 'bankCompleteBatch') {
      const sheet       = getOrCreateSheet(ss, BANK_SHEET, BANK_HEADERS, '#1d4ed8', BANK_COL_WIDTHS);
      const completedAt = payload.completedAt || '';
      const successRecs = payload.success || [];
      const removeKeys  = new Set((payload.remove || []).map(r => r.key));
      const keyCol      = BANK_HEADERS.length; // キーは最終列（1始まり）
      const lastRow     = sheet.getLastRow();

      // 既存行を一括読み込み
      let rows = lastRow > 1
        ? sheet.getRange(2, 1, lastRow - 1, keyCol).getValues()
        : [];

      // 削除対象を除外
      rows = rows.filter(row => !removeKeys.has(row[keyCol - 1]));

      // 追加・更新（キーで検索してあれば上書き、なければ末尾追加）
      const keyToIdx = {};
      rows.forEach((row, i) => { keyToIdx[row[keyCol - 1]] = i; });
      for (const rec of successRecs) {
        const newRow = buildBankRow(rec, completedAt);
        if (rec.key in keyToIdx) {
          rows[keyToIdx[rec.key]] = newRow;
        } else {
          rows.push(newRow);
        }
      }

      // メモリ上でソート（店舗 → 月 → ルート）
      rows.sort((a, b) =>
        String(a[0]).localeCompare(String(b[0])) ||   // 店舗
        (parseInt(a[2]) - parseInt(b[2])) ||           // 月（"3月" → 3）
        (Number(a[1]) - Number(b[1]))                  // ルート
      );

      // シートに一括書き込み（ヘッダー行以外を全書き換え）
      if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, keyCol).clearContent();
      if (rows.length > 0) sheet.getRange(2, 1, rows.length, keyCol).setValues(rows);

    // ── 振込入金 追加 ──
    } else if (action === 'addTransfer') {
      const sheet = getOrCreateSheet(ss, TRANSFER_SHEET, TRANSFER_HEADERS, '#15803d', TRANSFER_COL_WIDTHS);
      upsertRow(sheet, record.key, buildTransferRow(record, payload.transferDate || '', payload.recordedAt || ''));
      sortSheet(sheet);

    // ── 振込入金 削除 ──
    } else if (action === 'removeTransfer') {
      const sheet = ss.getSheetByName(TRANSFER_SHEET);
      if (sheet) removeRow(sheet, record.key, TRANSFER_HEADERS.length);

    // ── 連絡事項 追加 ──
    } else if (action === 'addMessage') {
      const msg = payload.message;
      if (!msg) return ok();
      const sheet = getOrCreateSheet(ss, MSG_SHEET, MSG_HEADERS, '#1e40af', [80, 100, 60, 160, 320, 160]);
      let createdStr = msg.createdAt || '';
      if (createdStr) {
        try {
          createdStr = Utilities.formatDate(new Date(createdStr), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
        } catch (_) {}
      }
      sheet.appendRow([msg.id || '', msg.store || '', msg.route || '', msg.customerName || '', msg.text || '', createdStr]);

    // ── 連絡事項 削除 ──
    } else if (action === 'removeMessage') {
      const msgId = payload.messageId;
      if (!msgId) return ok();
      const sheet = ss.getSheetByName(MSG_SHEET);
      if (!sheet) return ok();
      const lastRow = sheet.getLastRow();
      if (lastRow < 2) return ok();
      const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat();
      const idx = ids.indexOf(msgId);
      if (idx >= 0) sheet.deleteRow(idx + 2);

    // ── 金額修正 ──
    } else if (action === 'updateAmount') {
      const key       = payload.key;
      const amount    = Number(payload.amount);
      const oldAmount = payload.oldAmount !== undefined ? Number(payload.oldAmount) : null;
      const rec       = payload.record || {};
      const updatedAt = payload.updatedAt || '';

      // 現金集金シートの金額を更新
      const sheets = ss.getSheets();
      for (const sheet of sheets) {
        if (SKIP_SHEETS.has(sheet.getName())) continue;
        const lastRow = sheet.getLastRow();
        if (lastRow < 2) continue;
        const keyCol  = CASH_HEADERS.length; // キーは最終列
        const amtCol  = 5;                   // 金額列（ルート/月/名前/住所/金額/...）
        const keys    = sheet.getRange(2, keyCol, lastRow - 1, 1).getValues().flat();
        const idx     = keys.indexOf(key);
        if (idx >= 0) {
          sheet.getRange(idx + 2, amtCol).setValue(amount);
          break;
        }
      }

      // 金額修正ログに記録
      const logSheet = getOrCreateSheet(ss, AMOUNT_LOG_SHEET, AMOUNT_LOG_HEADERS, '#7c3aed', AMOUNT_LOG_COL_WIDTHS);
      let updatedStr = updatedAt;
      if (updatedStr) {
        try {
          updatedStr = Utilities.formatDate(new Date(updatedStr), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
        } catch (_) {}
      }
      const [, logM] = (rec.dataMonth || '').split('-');
      logSheet.appendRow([
        rec.store || '',
        rec.route || '',
        logM ? `${parseInt(logM)}月` : '',
        rec.name  || '',
        oldAmount !== null ? oldAmount : '',
        amount,
        updatedStr,
        key,
      ]);

    // ── 全リセット ──
    } else if (action === 'resetAll') {
      // 現金集金シート（口座振替・振込入金・連絡事項以外）のデータ行を全削除
      const sheets = ss.getSheets();
      for (const sheet of sheets) {
        const name = sheet.getName();
        if (SKIP_SHEETS.has(name)) continue;
        const lastRow = sheet.getLastRow();
        if (lastRow > 1) sheet.deleteRows(2, lastRow - 1);
      }
      // 口座振替シートのデータ行を全削除
      const bankSheet = ss.getSheetByName(BANK_SHEET);
      if (bankSheet && bankSheet.getLastRow() > 1) bankSheet.deleteRows(2, bankSheet.getLastRow() - 1);
      // 振込入金シートのデータ行を全削除
      const transferSheet = ss.getSheetByName(TRANSFER_SHEET);
      if (transferSheet && transferSheet.getLastRow() > 1) transferSheet.deleteRows(2, transferSheet.getLastRow() - 1);
    }

    return ok();

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ─── GET: チェック状態・連絡事項を返す ───────────────
function doGet(e) {
  try {
    const ss     = SpreadsheetApp.getActiveSpreadsheet();
    const sheets = ss.getSheets();
    const checkedData = {};

    for (const sheet of sheets) {
      // 口座振替・振込入金・連絡事項シートは読み飛ばす
      if (SKIP_SHEETS.has(sheet.getName())) continue;

      const lastRow = sheet.getLastRow();
      if (lastRow < 2) continue;

      // 現金集金シート: col6=集金日, col7=集金時刻, col8=キー
      const data = sheet.getRange(2, 6, lastRow - 1, 3).getValues();
      for (const [collectDate, , key] of data) {
        if (key) checkedData[key] = { collectDate: collectDate || '' };
      }
    }

    // 振込入金シートを読み込む（key → { date }）
    // TRANSFER_HEADERS: 店舗/ルート/月/名前/住所/金額/振込日(col7)/記録日時(col8)/キー(col9)
    const transferSheetR = ss.getSheetByName(TRANSFER_SHEET);
    const transferData = {};
    if (transferSheetR && transferSheetR.getLastRow() >= 2) {
      const rows = transferSheetR.getRange(2, 7, transferSheetR.getLastRow() - 1, 3).getValues();
      for (const [transferDate, , key] of rows) {
        if (!key) continue;
        const dateStr = (transferDate instanceof Date)
          ? Utilities.formatDate(transferDate, 'Asia/Tokyo', 'yyyy-MM-dd')
          : String(transferDate);
        transferData[String(key)] = { date: dateStr };
      }
    }

    // 口座振替シートを読み込む（key → { status: 'completed' }）
    // BANK_HEADERS: 店舗/ルート/月/名前/住所/金額/完了日時(col7)/キー(col8)
    const bankSheetR = ss.getSheetByName(BANK_SHEET);
    const bankData = {};
    if (bankSheetR && bankSheetR.getLastRow() >= 2) {
      const keys = bankSheetR.getRange(2, 8, bankSheetR.getLastRow() - 1, 1).getValues().flat();
      for (const key of keys) {
        if (key) bankData[String(key)] = { status: 'completed' };
      }
    }

    // 連絡事項シートを読み込む
    const msgSheet = ss.getSheetByName(MSG_SHEET);
    const messages = [];
    if (msgSheet && msgSheet.getLastRow() >= 2) {
      const rows = msgSheet.getRange(2, 1, msgSheet.getLastRow() - 1, MSG_HEADERS.length).getValues();
      for (const [id, store, route, customerName, text, createdAt] of rows) {
        if (!id) continue;
        messages.push({
          id:           String(id),
          store:        String(store),
          route,
          customerName: String(customerName),
          text:         String(text),
          createdAt:    String(createdAt),
        });
      }
    }

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, checkedData, transferData, bankData, messages }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ─── シート名 ─────────────────────────────────────────
// 現金集金: "{店舗}"  例: 下関店
function formatCashSheetName(store, dataMonth) {
  return store || '不明';
}

// ─── シート取得 or 作成 ───────────────────────────────
function getOrCreateSheet(ss, name, headers, headerBg, colWidths) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    const hRange = sheet.getRange(1, 1, 1, headers.length);
    hRange.setValues([headers]);
    hRange.setFontWeight('bold');
    hRange.setBackground(headerBg);
    hRange.setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    colWidths.forEach((w, i) => sheet.setColumnWidth(i + 1, w));
    // キー列（最終列）を非表示
    sheet.hideColumns(headers.length, 1);
  }
  return sheet;
}

// ─── 行の追加 or 更新（キーで重複チェック） ──────────
// rowData の末尾要素がキーであること
function upsertRow(sheet, key, rowData) {
  const keyCol  = rowData.length;
  const lastRow = sheet.getLastRow();
  let foundRow  = -1;
  if (lastRow > 1) {
    const keys = sheet.getRange(2, keyCol, lastRow - 1, 1).getValues().flat();
    const idx  = keys.indexOf(key);
    if (idx >= 0) foundRow = idx + 2;
  }
  if (foundRow > 0) {
    sheet.getRange(foundRow, 1, 1, rowData.length).setValues([rowData]);
  } else {
    sheet.appendRow(rowData);
  }
}

// ─── 行の削除（キーで検索） ───────────────────────────
function removeRow(sheet, key, keyCol) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const keys = sheet.getRange(2, keyCol, lastRow - 1, 1).getValues().flat();
  const idx  = keys.indexOf(key);
  if (idx >= 0) sheet.deleteRow(idx + 2);
}

// ─── 現金集金: 集金日 → ルート → 集金時刻順ソート ────
function sortCashSheet(sheet) {
  const dataRows = sheet.getLastRow() - 1;
  if (dataRows < 2) return;
  const cols = sheet.getLastColumn();
  sheet.getRange(2, 1, dataRows, cols)
    .sort([
      { column: 6, ascending: true },  // 集金日
      { column: 1, ascending: true },  // ルート
      { column: 7, ascending: true },  // 集金時刻
    ]);
}

// ─── 店舗→月→ルート順ソート（口座振替・振込入金） ──
function sortSheet(sheet) {
  const dataRows = sheet.getLastRow() - 1;
  if (dataRows < 2) return;
  const cols = sheet.getLastColumn();
  sheet.getRange(2, 1, dataRows, cols)
    .sort([
      { column: 1, ascending: true },  // 店舗
      { column: 3, ascending: true },  // 月
      { column: 2, ascending: true },  // ルート
    ]);
}

// ─── 行データ生成 ─────────────────────────────────────
function buildCashRow(r, collectDate) {
  let dateStr = r.checkedAt || '';
  if (dateStr) {
    try {
      dateStr = Utilities.formatDate(new Date(dateStr), 'Asia/Tokyo', 'HH:mm');
    } catch (_) {}
  }
  const [, m] = (r.dataMonth || '').split('-');
  return [
    r.route      || '',
    m ? `${parseInt(m)}月` : '',
    r.name       || '',
    r.address    || '',
    r.amount     || 0,
    collectDate  || '',
    dateStr,
    r.key        || '',
  ];
}

function buildBankRow(r, completedAt) {
  let dateStr = completedAt || '';
  if (dateStr) {
    try {
      dateStr = Utilities.formatDate(new Date(dateStr), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
    } catch (_) {}
  }
  const [, m] = (r.dataMonth || '').split('-');
  return [
    r.store    || '',
    r.route    || '',
    m ? `${parseInt(m)}月` : '',
    r.name     || '',
    r.address  || '',
    r.amount   || 0,
    dateStr,
    r.key      || '',
  ];
}

function buildTransferRow(r, transferDate, recordedAt) {
  let recStr = recordedAt || '';
  if (recStr) {
    try {
      recStr = Utilities.formatDate(new Date(recStr), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
    } catch (_) {}
  }
  const [, m] = (r.dataMonth || '').split('-');
  return [
    r.store       || '',
    r.route       || '',
    m ? `${parseInt(m)}月` : '',
    r.name        || '',
    r.address     || '',
    r.amount      || 0,
    transferDate  || '',
    recStr,
    r.key         || '',
  ];
}

// ─── レスポンス ───────────────────────────────────────
function ok() {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
