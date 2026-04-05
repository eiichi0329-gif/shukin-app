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
const MSG_STORE_ORDER = ['下関店', '北九州店', '宇部店', '宗像店', '飯塚店', '福岡東店'];

const AMOUNT_LOG_SHEET   = '金額修正';
const AMOUNT_LOG_HEADERS = ['店舗', 'ルート', '月', '名前', '修正前金額', '修正後金額', '修正日時', 'キー'];
const AMOUNT_LOG_COL_WIDTHS = [100, 70, 70, 160, 100, 100, 160, 1];

const ALLOWED_USERS_SHEET   = '許可ユーザー';
const ALLOWED_USERS_HEADERS = ['店舗名', '名前', 'メールアドレス'];

const DELIVERY_SHEET   = '配達時刻';
const DELIVERY_HEADERS = ['店舗', 'ルート', '名前', '住所', '配達日時', 'キー'];
const DELIVERY_COL_WIDTHS = [100, 60, 160, 260, 160, 1];

const ROUTE_OVERRIDE_SHEET   = 'ルート変更';
const ROUTE_OVERRIDE_HEADERS = ['日付', 'グループキー', 'ルート番号', 'データ生成時刻'];

const DENOM_SHEET   = '現金精査';
const DENOM_HEADERS = ['日付', 'ルート', '精査データ', '保存日時', 'キー'];
const DENOM_COL_WIDTHS = [100, 60, 500, 160, 1];

const MSG_READ_SHEET   = '連絡事項既読';
const MSG_READ_HEADERS = ['メッセージID', '保存日時'];

const MANUAL_SHEET   = '手動追加';
const MANUAL_HEADERS = ['店舗', 'ルート', '月', '名前', '住所', '金額', '支払区分', '登録日時', 'ID'];
const MANUAL_COL_WIDTHS = [100, 60, 70, 160, 260, 90, 80, 160, 1];

const BANK_FAILED_SHEET   = '口振失敗';
const BANK_FAILED_HEADERS = ['キー', '登録日時'];
const BANK_FAILED_COL_WIDTHS = [1, 160];

// doGet でチェックデータ読み取りをスキップするシート名
const SKIP_SHEETS = new Set([BANK_SHEET, TRANSFER_SHEET, MSG_SHEET, AMOUNT_LOG_SHEET, ALLOWED_USERS_SHEET, DELIVERY_SHEET, ROUTE_OVERRIDE_SHEET, DENOM_SHEET, MSG_READ_SHEET, MANUAL_SHEET, BANK_FAILED_SHEET]);

// ─── 診断ログ（デバッグ用）────────────────────────────
function writeDebugLog(ss, action, note) {
  try {
    let sheet = ss.getSheetByName('デバッグログ');
    if (!sheet) {
      sheet = ss.insertSheet('デバッグログ');
      sheet.getRange(1,1,1,3).setValues([['日時','action','note']]);
    }
    const d = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm:ss');
    sheet.appendRow([d, action || '', note || '']);
  } catch(_) {}
}

// ─── メインハンドラ ───────────────────────────────────
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const { action, record } = payload;
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    writeDebugLog(ss, action, JSON.stringify(record || {}).slice(0, 100));

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
      let createdDate = msg.createdAt ? new Date(msg.createdAt) : new Date();
      sheet.appendRow([msg.id || '', msg.store || '', msg.route || '', msg.customerName || '', msg.text || '', createdDate]);
      sheet.getRange(sheet.getLastRow(), 6).setNumberFormat('yyyy/MM/dd HH:mm');
      sortMsgSheet(sheet);

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

    // ── 連絡事項 編集 ──
    } else if (action === 'updateMessage') {
      const msgId   = payload.messageId;
      const newText = payload.text;
      if (!msgId || newText === undefined) return ok();
      const sheet = ss.getSheetByName(MSG_SHEET);
      if (!sheet) return ok();
      const lastRow = sheet.getLastRow();
      if (lastRow < 2) return ok();
      const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat();
      const idx = ids.indexOf(msgId);
      if (idx >= 0) sheet.getRange(idx + 2, 5).setValue(newText); // 5列目がテキスト列

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

    // ── 配達時刻 記録 ──
    } else if (action === 'addDelivery') {
      const sheet   = getOrCreateSheet(ss, DELIVERY_SHEET, DELIVERY_HEADERS, '#0f766e', DELIVERY_COL_WIDTHS, true);
      const groupKey = payload.groupKey || `${payload.store}|${payload.dataMonth || ''}|${payload.name}|${payload.address}`;
      let dateStr = '';
      try {
        dateStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm');
      } catch(e) {
        dateStr = new Date().toISOString();
      }
      writeDebugLog(ss, 'addDelivery', `dateStr=${dateStr}`);
      upsertRow(sheet, groupKey, [
        payload.store   || '',
        payload.route   || '',
        payload.name    || '',
        payload.address || '',
        dateStr,
        groupKey,
      ]);
      sortDeliverySheet(sheet);

    // ── 配達済み取消 ──
    } else if (action === 'removeDelivery') {
      const sheet = ss.getSheetByName(DELIVERY_SHEET);
      if (sheet && payload.groupKey) removeRow(sheet, payload.groupKey, DELIVERY_HEADERS.length);

    // ── ルートオーバーライド保存 ──
    } else if (action === 'setRouteOverrides') {
      const overrides = payload.overrides || {};
      const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
      const sheet = getOrCreateSheet(ss, ROUTE_OVERRIDE_SHEET, ROUTE_OVERRIDE_HEADERS, '#7c3aed', [100, 320, 80, 200], false);
      // 既存の全行を削除して書き直す（今日分のみ保持）
      const lastRow = sheet.getLastRow();
      if (lastRow > 1) sheet.deleteRows(2, lastRow - 1);
      Object.entries(overrides).forEach(([gk, ov]) => {
        if (ov.date === today) {
          sheet.appendRow([today, gk, ov.route, ov.dataGeneratedAt || '']);
        }
      });

    // ── 現金精査 保存 ──
    } else if (action === 'saveDenom') {
      const sheet = getOrCreateSheet(ss, DENOM_SHEET, DENOM_HEADERS, '#0f766e', DENOM_COL_WIDTHS);
      const data  = payload.data || {};
      upsertRow(sheet, payload.key, [
        data.date    || '',
        data.route   || '',
        JSON.stringify({ counts: data.counts || {}, expected: data.expected || 0 }),
        data.savedAt || '',
        payload.key,
      ]);

    // ── 連絡事項 既読同期 ──
    } else if (action === 'saveMsgRead') {
      const sheet = getOrCreateSheet(ss, MSG_READ_SHEET, MSG_READ_HEADERS, '#1e40af', [200, 160]);
      const ids     = payload.ids || [];
      const savedAt = payload.savedAt || new Date().toISOString();
      const lastRow = sheet.getLastRow();
      if (lastRow > 1) sheet.deleteRows(2, lastRow - 1);
      if (ids.length > 0) {
        sheet.getRange(2, 1, ids.length, 2).setValues(ids.map(id => [String(id), savedAt]));
      }

    // ── 手動追加レコード 保存 ──
    } else if (action === 'saveManual') {
      const rec = payload.record || {};
      if (!rec.id) return ok();
      const sheet = getOrCreateSheet(ss, MANUAL_SHEET, MANUAL_HEADERS, '#b45309', MANUAL_COL_WIDTHS);
      const [, m] = (rec.dataMonth || '').split('-');
      upsertRow(sheet, rec.id, [
        rec.store       || '',
        rec.route       || 0,
        m ? `${parseInt(m)}月` : (rec.dataMonth || ''),
        rec.name        || '',
        rec.address     || '',
        rec.amount      || 0,
        rec.paymentType || 'cash',
        payload.savedAt || new Date().toISOString(),
        rec.id,
      ]);

    // ── 手動追加レコード 削除 ──
    } else if (action === 'removeManual') {
      const id = payload.id;
      if (!id) return ok();
      const sheet = ss.getSheetByName(MANUAL_SHEET);
      if (sheet) removeRow(sheet, id, MANUAL_HEADERS.length);

    // ── 口振失敗 登録 ──
    } else if (action === 'saveBankFailed') {
      const key = payload.key;
      if (!key) return ok();
      const sheet = getOrCreateSheet(ss, BANK_FAILED_SHEET, BANK_FAILED_HEADERS, '#b91c1c', BANK_FAILED_COL_WIDTHS);
      upsertRow(sheet, key, [key, payload.savedAt || new Date().toISOString()]);

    // ── 口振失敗 解除 ──
    } else if (action === 'removeBankFailed') {
      const key = payload.key;
      if (!key) return ok();
      const sheet = ss.getSheetByName(BANK_FAILED_SHEET);
      if (sheet) removeRow(sheet, key, BANK_FAILED_HEADERS.length);

    // ── 住所間移動時間取得（配達所要時間計算用、記録なし） ──
    } else if (action === 'getTravelTimes') {
      // stops形式 { address, name, isNew, isDepot?, label? } または旧来の addresses 配列に対応
      const rawStops = payload.stops || [];
      const rawAddr  = payload.addresses || [];
      const allStops = rawStops.length > 0
        ? rawStops.filter(s => s.address)
        : rawAddr.filter(Boolean).map(a => ({ address: a, name: '', isNew: false }));
      const stops = allStops.slice(0, 102); // デポ2件分多め

      if (stops.length < 2) {
        return ContentService.createTextOutput(JSON.stringify({ ok: true, durations: [], nearest: [] }))
          .setMimeType(ContentService.MimeType.JSON);
      }

      // ─ ハーバーサイン距離（メートル）
      const haversineM = (lat1, lng1, lat2, lng2) => {
        const R    = 6371000;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a    = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      };

      // デポ（出発・帰着）を分離し、中間ストップのみで新規/既存の最適化を行う
      const depotFirst = stops.length > 0 && stops[0].isDepot   ? stops[0]               : null;
      const depotLast  = stops.length > 1 && stops[stops.length - 1].isDepot ? stops[stops.length - 1] : null;
      const midStops   = stops.filter(s => !s.isDepot);

      const newIndices    = midStops.reduce((a, s, i) => { if (s.isNew)  a.push(i); return a; }, []);
      const nonNewIndices = midStops.reduce((a, s, i) => { if (!s.isNew) a.push(i); return a; }, []);
      const nearestInfo   = [];
      let orderedMid      = midStops;

      if (newIndices.length > 0 && nonNewIndices.length > 0) {
        // 中間ストップをジオコーディング
        const geocoder = Maps.newGeocoder().setLanguage('ja').setRegion('JP');
        const coords   = midStops.map(s => {
          try {
            const r = geocoder.geocode(s.address);
            if (r.results && r.results.length > 0) {
              const loc = r.results[0].geometry.location;
              return { lat: loc.lat, lng: loc.lng };
            }
          } catch (_) {}
          return null;
        });

        // 各新規・再注文に最近傍の既存顧客インデックスを求める
        const insertAfterMap = new Map(); // newIdx → nearestNonNewIdx
        newIndices.forEach(ni => {
          const nc = coords[ni];
          let minDist    = Infinity;
          let nearestIdx = nonNewIndices[0];
          nonNewIndices.forEach(ji => {
            const jc = coords[ji];
            if (!nc || !jc) return;
            const d = haversineM(nc.lat, nc.lng, jc.lat, jc.lng);
            if (d < minDist) { minDist = d; nearestIdx = ji; }
          });
          insertAfterMap.set(ni, nearestIdx);
          nearestInfo.push({
            newName:     midStops[ni].name,
            nearestName: midStops[nearestIdx].name,
            distanceM:   Math.round(minDist),
            label:       midStops[ni].label || '新規',
          });
        });

        // 新規・再注文を取り除き、最近傍の直後へ挿入して並び替え
        orderedMid = [];
        for (let i = 0; i < midStops.length; i++) {
          if (!midStops[i].isNew) {
            orderedMid.push(midStops[i]);
            newIndices
              .filter(ni => insertAfterMap.get(ni) === i)
              .forEach(ni => orderedMid.push(midStops[ni]));
          }
        }
      }

      // デポを先頭・末尾に戻してルート確定
      const orderedStops = [
        ...(depotFirst ? [depotFirst] : []),
        ...orderedMid,
        ...(depotLast  ? [depotLast]  : []),
      ];

      // ─ Directions で移動時間計算（25件チャンク）
      const addresses  = orderedStops.map(s => s.address);
      const MAX_CHUNK  = 25;
      const durations  = [];
      let i = 0;

      while (i < addresses.length - 1) {
        const end   = Math.min(i + MAX_CHUNK, addresses.length);
        const chunk = addresses.slice(i, end);

        try {
          const finder = Maps.newDirectionFinder()
            .setOrigin(chunk[0])
            .setDestination(chunk[chunk.length - 1])
            .setMode(Maps.DirectionFinder.Mode.DRIVING);

          for (let j = 1; j < chunk.length - 1; j++) {
            finder.addWaypoint(chunk[j]);
          }

          const result = finder.getDirections();
          if (!result || !result.routes || !result.routes[0]) {
            for (let j = 0; j < chunk.length - 1; j++) durations.push(0);
          } else {
            result.routes[0].legs.forEach(leg => durations.push(leg.duration.value));
          }
        } catch (e) {
          for (let j = 0; j < chunk.length - 1; j++) durations.push(0);
        }

        i += chunk.length - 1;
      }

      return ContentService.createTextOutput(JSON.stringify({ ok: true, durations, nearest: nearestInfo }))
        .setMimeType(ContentService.MimeType.JSON);

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

    // ── 移動時間取得（Google Maps Distance Matrix API）──
    } else if (action === 'getTravelTimes') {
      const addresses = payload.addresses || [];
      if (addresses.length < 2) {
        return ContentService
          .createTextOutput(JSON.stringify({ ok: true, durations: [] }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      const apiKey = PropertiesService.getScriptProperties().getProperty('MAPS_API_KEY');
      if (!apiKey) {
        return ContentService
          .createTextOutput(JSON.stringify({ ok: false, error: 'MAPS_API_KEY がスクリプトプロパティに設定されていません' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      const requests = [];
      for (let i = 0; i < addresses.length - 1; i++) {
        requests.push({
          url: 'https://maps.googleapis.com/maps/api/distancematrix/json'
            + '?origins='      + encodeURIComponent(addresses[i])
            + '&destinations=' + encodeURIComponent(addresses[i + 1])
            + '&mode=driving&language=ja&key=' + apiKey,
          method: 'get',
          muteHttpExceptions: true
        });
      }
      const responses = UrlFetchApp.fetchAll(requests);
      const durations = responses.map(resp => {
        try {
          const data = JSON.parse(resp.getContentText());
          const elem = data.rows?.[0]?.elements?.[0];
          return (elem?.status === 'OK') ? elem.duration.value : null;
        } catch(_) { return null; }
      });
      return ContentService
        .createTextOutput(JSON.stringify({ ok: true, durations }))
        .setMimeType(ContentService.MimeType.JSON);
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

    // ── 認証チェック ──
    if (e?.parameter?.action === 'checkAuth') {
      const email = (e?.parameter?.email || '').trim().toLowerCase();
      const sheet = ss.getSheetByName(ALLOWED_USERS_SHEET);
      if (!sheet || sheet.getLastRow() < 2) {
        // シートが存在しない or 空 → 全員許可
        return ContentService
          .createTextOutput(JSON.stringify({ ok: true, allowed: true }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      const emails = sheet.getRange(2, 3, sheet.getLastRow() - 1, 1).getValues()
        .flat().map(v => String(v).trim().toLowerCase()).filter(v => v);
      const allowed = emails.includes(email);
      return ContentService
        .createTextOutput(JSON.stringify({ ok: true, allowed }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    const sheets = ss.getSheets();
    const checkedData = {};

    for (const sheet of sheets) {
      // 口座振替・振込入金・連絡事項シートは読み飛ばす
      if (SKIP_SHEETS.has(sheet.getName())) continue;

      const lastRow = sheet.getLastRow();
      if (lastRow < 2) continue;

      // 現金集金シート: col5=金額, col6=集金日, col7=集金時刻, col8=キー
      const data = sheet.getRange(2, 5, lastRow - 1, 4).getValues();
      for (const [amount, collectDate, , key] of data) {
        if (key) checkedData[key] = { collectDate: collectDate || '', collectedAmount: Number(amount) || 0 };
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
          createdAt:    createdAt instanceof Date
              ? Utilities.formatDate(createdAt, 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ss")
              : String(createdAt),
        });
      }
    }

    // ルートオーバーライドを読み込む（今日分のみ）
    const today2 = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
    let routeOverrides = {};
    const roSheet = ss.getSheetByName(ROUTE_OVERRIDE_SHEET);
    if (roSheet && roSheet.getLastRow() >= 2) {
      const roRows = roSheet.getRange(2, 1, roSheet.getLastRow() - 1, 4).getValues();
      roRows.forEach(([date, gk, route, dataGenAt]) => {
        if (date === today2 && gk) {
          routeOverrides[String(gk)] = { route: Number(route), date: today2, dataGeneratedAt: String(dataGenAt) };
        }
      });
    }

    // 現金精査データを読み込む（キー → { counts, expected, date, route, savedAt }）
    // DENOM_HEADERS: 日付(1) / ルート(2) / 精査データJSON(3) / 保存日時(4) / キー(5)
    const denomSheetR = ss.getSheetByName(DENOM_SHEET);
    const denomData = {};
    if (denomSheetR && denomSheetR.getLastRow() >= 2) {
      const rows = denomSheetR.getRange(2, 1, denomSheetR.getLastRow() - 1, 5).getValues();
      for (const [date, route, jsonStr, savedAt, key] of rows) {
        if (!key || !jsonStr) continue;
        try {
          const parsed = JSON.parse(String(jsonStr));
          denomData[String(key)] = {
            counts:   parsed.counts   || {},
            expected: parsed.expected || 0,
            date:     String(date),
            route:    Number(route),
            savedAt:  String(savedAt),
          };
        } catch(_) {}
      }
    }

    // 配達済みデータを読み込む（今日分のみ返す）
    const deliverySheetR2 = ss.getSheetByName(DELIVERY_SHEET);
    const deliveryData = {};
    const today3 = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd');
    if (deliverySheetR2 && deliverySheetR2.getLastRow() >= 2) {
      const dRows = deliverySheetR2.getRange(2, 1, deliverySheetR2.getLastRow() - 1, 6).getValues();
      for (const [, , , , deliveredAt, key] of dRows) {
        if (!key) continue;
        const dateStr = (deliveredAt instanceof Date)
          ? Utilities.formatDate(deliveredAt, 'Asia/Tokyo', 'yyyy/MM/dd')
          : String(deliveredAt).slice(0, 10).replace(/-/g, '/');
        if (dateStr === today3) {
          deliveryData[String(key)] = {
            checkedAt: (deliveredAt instanceof Date)
              ? Utilities.formatDate(deliveredAt, 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ss")
              : String(deliveredAt),
          };
        }
      }
    }

    // 連絡事項既読IDを読み込む
    const msgReadSheetR = ss.getSheetByName(MSG_READ_SHEET);
    const msgReadIds = [];
    if (msgReadSheetR && msgReadSheetR.getLastRow() >= 2) {
      const rows = msgReadSheetR.getRange(2, 1, msgReadSheetR.getLastRow() - 1, 1).getValues();
      rows.forEach(([id]) => { if (id) msgReadIds.push(String(id)); });
    }

    // 手動追加レコードを読み込む
    // MANUAL_HEADERS: 店舗(1)/ルート(2)/月(3)/名前(4)/住所(5)/金額(6)/支払区分(7)/登録日時(8)/ID(9)
    const manualSheetR = ss.getSheetByName(MANUAL_SHEET);
    const manualData = [];
    if (manualSheetR && manualSheetR.getLastRow() >= 2) {
      const rows = manualSheetR.getRange(2, 1, manualSheetR.getLastRow() - 1, MANUAL_HEADERS.length).getValues();
      for (const [store, route, monthStr, name, address, amount, paymentType, , id] of rows) {
        if (!id || !name) continue;
        // 月文字列（例: "4月"）を dataMonth 形式に変換するのはクライアント側で行う
        manualData.push({
          id:          String(id),
          store:       String(store),
          route:       Number(route),
          monthStr:    String(monthStr),
          name:        String(name),
          address:     String(address),
          amount:      Number(amount),
          paymentType: String(paymentType),
        });
      }
    }

    // 口振失敗キーを読み込む
    // BANK_FAILED_HEADERS: キー(1)/登録日時(2)
    const bankFailedSheetR = ss.getSheetByName(BANK_FAILED_SHEET);
    const bankFailedKeys = [];
    if (bankFailedSheetR && bankFailedSheetR.getLastRow() >= 2) {
      const rows = bankFailedSheetR.getRange(2, 1, bankFailedSheetR.getLastRow() - 1, 1).getValues();
      for (const [key] of rows) {
        if (key) bankFailedKeys.push(String(key));
      }
    }

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, checkedData, transferData, bankData, messages, routeOverrides, denomData, deliveryData, msgReadIds, manualData, bankFailedKeys }))
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
function getOrCreateSheet(ss, name, headers, headerBg, colWidths, hideLastCol = true) {
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
    // キー列（最終列）を非表示（配達時刻シートなどキーなしの場合はスキップ）
    if (hideLastCol) sheet.hideColumns(headers.length, 1);
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

// ─── 連絡事項: 送信日順 → 店舗カスタム順 → ルート順 ─
function sortMsgSheet(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 3) return; // データが1行以下はソート不要
  const cols = MSG_HEADERS.length;
  const rows = sheet.getRange(2, 1, lastRow - 1, cols).getValues();

  // Date オブジェクト・文字列どちらでも "yyyy/MM/dd HH:mm" 文字列に変換
  const toStr = v => v instanceof Date
    ? Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm')
    : String(v);

  rows.sort((a, b) => {
    // 送信日（日付部分のみ）で昇順
    const dateCmp = toStr(a[5]).slice(0, 10).localeCompare(toStr(b[5]).slice(0, 10));
    if (dateCmp !== 0) return dateCmp;
    // 店舗（index1）カスタム順
    const oa = MSG_STORE_ORDER.indexOf(String(a[1]));
    const ob = MSG_STORE_ORDER.indexOf(String(b[1]));
    const storeCmp = (oa === -1 ? 999 : oa) - (ob === -1 ? 999 : ob);
    if (storeCmp !== 0) return storeCmp;
    // ルート（index2）昇順
    return Number(a[2]) - Number(b[2]);
  });

  sheet.getRange(2, 1, lastRow - 1, cols).setValues(rows);
  // setValues 後も送信日時列の書式を維持
  sheet.getRange(2, 6, lastRow - 1, 1).setNumberFormat('yyyy/MM/dd HH:mm');
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
  let dateStr = '';
  try {
    dateStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HH:mm');
  } catch (_) {}
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

// ─── 配達時刻: 配達日時 → 店舗 → ルート順ソート ────
function sortDeliverySheet(sheet) {
  const dataRows = sheet.getLastRow() - 1;
  if (dataRows < 2) return;
  const cols = sheet.getLastColumn();
  sheet.getRange(2, 1, dataRows, cols)
    .sort([
      { column: 5, ascending: true },  // 配達日時
      { column: 1, ascending: true },  // 店舗
      { column: 2, ascending: true },  // ルート
    ]);
}

// ─── レスポンス ───────────────────────────────────────
function ok() {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
