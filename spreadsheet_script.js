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
//  - 月分ごとにシートが自動作成されます（例：2026年3月）
//  - 列: 店舗 / ルート / 名前 / 住所 / 金額 / 集金日時 / キー
//  - 集金済みにチェック → 行が追加（店舗→ルート順で整列）
//  - チェックを外す → 行が削除
// ══════════════════════════════════════════════════════

const HEADERS = ['店舗', 'ルート', '名前', '住所', '金額', '集金日', '集金日時', 'キー'];
const MSG_SHEET  = '連絡事項';
const MSG_HEADERS = ['ID', '店舗', 'ルート', '顧客名', '連絡内容', '送信日時'];

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const { action, record } = payload;

    const ss        = SpreadsheetApp.getActiveSpreadsheet();
    const sheetName = formatSheetName(record.dataMonth);

    if (action === 'add') {
      let sheet = ss.getSheetByName(sheetName);
      if (!sheet) {
        sheet = ss.insertSheet(sheetName);
        const hRange = sheet.getRange(1, 1, 1, HEADERS.length);
        hRange.setValues([HEADERS]);
        hRange.setFontWeight('bold');
        hRange.setBackground('#c2410c');
        hRange.setFontColor('#ffffff');
        sheet.setFrozenRows(1);
        sheet.setColumnWidth(1, 100);  // 店舗
        sheet.setColumnWidth(2, 70);   // ルート
        sheet.setColumnWidth(3, 160);  // 名前
        sheet.setColumnWidth(4, 260);  // 住所
        sheet.setColumnWidth(5, 90);   // 金額
        sheet.setColumnWidth(6, 100);  // 集金日
        sheet.setColumnWidth(7, 160);  // 集金日時
        sheet.setColumnWidth(8, 1);    // キー（非表示用）
        sheet.hideColumns(8, 1);
      }

      // 既存行をキーで検索（col8=キー）
      const lastRow = sheet.getLastRow();
      let foundRow  = -1;
      if (lastRow > 1) {
        const keys = sheet.getRange(2, 8, lastRow - 1, 1).getValues().flat();
        const idx  = keys.indexOf(record.key);
        if (idx >= 0) foundRow = idx + 2;
      }

      const rowData = buildRow(record, payload.collectDate || '');
      if (foundRow > 0) {
        sheet.getRange(foundRow, 1, 1, HEADERS.length).setValues([rowData]);
      } else {
        sheet.appendRow(rowData);
      }

      // 店舗 → ルート順でソート
      const dataRows = sheet.getLastRow() - 1;
      if (dataRows > 1) {
        sheet.getRange(2, 1, dataRows, HEADERS.length)
          .sort([{ column: 1, ascending: true }, { column: 2, ascending: true }]);
      }

    } else if (action === 'addMessage') {
      const msg = payload.message;
      if (!msg) return ok();
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      let sheet = ss.getSheetByName(MSG_SHEET);
      if (!sheet) {
        sheet = ss.insertSheet(MSG_SHEET);
        const hRange = sheet.getRange(1, 1, 1, MSG_HEADERS.length);
        hRange.setValues([MSG_HEADERS]);
        hRange.setFontWeight('bold');
        hRange.setBackground('#1e40af');
        hRange.setFontColor('#ffffff');
        sheet.setFrozenRows(1);
        sheet.setColumnWidth(1, 80);
        sheet.setColumnWidth(2, 100);
        sheet.setColumnWidth(3, 60);
        sheet.setColumnWidth(4, 160);
        sheet.setColumnWidth(5, 320);
        sheet.setColumnWidth(6, 160);
      }
      // 送信日時をJST文字列に
      let createdStr = msg.createdAt || '';
      if (createdStr) {
        try {
          const d = new Date(new Date(createdStr).getTime() + 9 * 60 * 60 * 1000);
          createdStr = Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
        } catch (_) {}
      }
      sheet.appendRow([msg.id || '', msg.store || '', msg.route || '', msg.customerName || '', msg.text || '', createdStr]);
      return ok();

    } else if (action === 'removeMessage') {
      const msgId = payload.messageId;
      if (!msgId) return ok();
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      const sheet = ss.getSheetByName(MSG_SHEET);
      if (!sheet) return ok();
      const lastRow = sheet.getLastRow();
      if (lastRow < 2) return ok();
      const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat();
      const idx = ids.indexOf(msgId);
      if (idx >= 0) sheet.deleteRow(idx + 2);
      return ok();

    } else if (action === 'remove') {
      const sheet = ss.getSheetByName(sheetName);
      if (!sheet) return ok();
      const lastRow = sheet.getLastRow();
      if (lastRow < 2) return ok();
      const keys = sheet.getRange(2, 8, lastRow - 1, 1).getValues().flat();
      const idx  = keys.indexOf(record.key);
      if (idx >= 0) sheet.deleteRow(idx + 2);
    }

    return ok();

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function buildRow(r, collectDate) {
  // 集金日時を JST の読みやすい形式に変換
  let dateStr = r.checkedAt || '';
  if (dateStr) {
    try {
      const d = new Date(new Date(dateStr).getTime() + 9 * 60 * 60 * 1000);
      dateStr = Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
    } catch (_) {}
  }
  return [
    r.store       || '',
    r.route       || '',
    r.name        || '',
    r.address     || '',
    r.amount      || 0,
    collectDate   || '',
    dateStr,
    r.key         || '',
  ];
}

function doGet(e) {
  try {
    const ss      = SpreadsheetApp.getActiveSpreadsheet();
    const sheets  = ss.getSheets();
    const checkedData = {};
    for (const sheet of sheets) {
      const lastRow = sheet.getLastRow();
      if (lastRow < 2) continue;
      // col6=集金日, col8=キー
      const data = sheet.getRange(2, 6, lastRow - 1, 3).getValues();
      for (const [collectDate, , key] of data) {
        if (key) checkedData[key] = { collectDate: collectDate || '' };
      }
    }
    // 連絡事項シートを読み込む
    const msgSheet = ss.getSheetByName(MSG_SHEET);
    const messages = [];
    if (msgSheet && msgSheet.getLastRow() >= 2) {
      const rows = msgSheet.getRange(2, 1, msgSheet.getLastRow() - 1, MSG_HEADERS.length).getValues();
      for (const [id, store, route, customerName, text, createdAt] of rows) {
        if (!id) continue;
        messages.push({ id: String(id), store: String(store), route, customerName: String(customerName), text: String(text), createdAt: String(createdAt) });
      }
    }

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, checkedData, messages }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function formatSheetName(dataMonth) {
  if (!dataMonth) return '不明';
  const [y, m] = dataMonth.split('-');
  return `${y}年${parseInt(m)}月`;
}

function ok() {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
