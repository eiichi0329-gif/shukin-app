// 集金管理アプリ v3

const LS_KEY             = 'coll-state-v3';
const BANK_KEY           = 'coll-bank-v1';
const TRANSFER_KEY       = 'coll-transfer-v1';
const FILTER_KEY         = 'coll-filter-v1';
const AMOUNT_OVERRIDE_KEY = 'coll-amount-override-v1';
const DIRTY_GRACE_MS = 35000; // ローカル変更を守る猶予時間（ms）

// ─── State ───────────────────────────────────────────────────────
let allData         = [];
let checked         = {};   // key → { checkedAt, collectDate }
let bankState       = {};   // key → { status: 'completed'|'failed', updatedAt }
let transferState   = {};   // key → { date: 'YYYY-MM-DD', recordedAt: ISO }
let amountOverrides = {};   // key → number（管理画面で手修正した金額）
let filters = { store: '', month: '', route: '', payment: 'cash', search: '', uncollectedOnly: true };
let currentTab = 'list';
let expandedCell = null;  // { route, month } for admin detail

// 口振一括チェックモード
let bulkMode               = false;
let bulkAffectedKeys       = new Set(); // 一括チェックで対象になったキー
let bulkUncheckedKeys      = new Set(); // ユーザーが手動で外したキー
let bulkPreviouslyCompleted = new Set(); // 一括モード開始時点で完了済みだったキー

// ローカルで変更した直後のキーを追跡（同期による上書きを防ぐ）
const dirtyKeys = new Map(); // key → timestamp

function markDirty(key) { dirtyKeys.set(key, Date.now()); }

// ─── Filter State ────────────────────────────────────────────────
function saveFilters() {
    localStorage.setItem(FILTER_KEY, JSON.stringify(filters));
}
function loadFilterState() {
    try { return JSON.parse(localStorage.getItem(FILTER_KEY) || 'null'); } catch { return null; }
}

// ─── Bank State ───────────────────────────────────────────────────
function loadBankState() {
    try { return JSON.parse(localStorage.getItem(BANK_KEY) || '{}'); } catch { return {}; }
}
function saveBankState() {
    localStorage.setItem(BANK_KEY, JSON.stringify(bankState));
}

// ─── Amount Override State ────────────────────────────────────────
function loadAmountOverrides() {
    try { return JSON.parse(localStorage.getItem(AMOUNT_OVERRIDE_KEY) || '{}'); } catch { return {}; }
}
function saveAmountOverrides() {
    localStorage.setItem(AMOUNT_OVERRIDE_KEY, JSON.stringify(amountOverrides));
}
function effectiveAmount(key, record) {
    return amountOverrides[key] !== undefined ? amountOverrides[key] : (record.amount || 0);
}

// ─── Transfer State ───────────────────────────────────────────────
function loadTransferState() {
    try { return JSON.parse(localStorage.getItem(TRANSFER_KEY) || '{}'); } catch { return {}; }
}
function saveTransferState() {
    localStorage.setItem(TRANSFER_KEY, JSON.stringify(transferState));
}

// 口振失敗した顧客は実効的に現金扱いにする
function effectivePaymentType(r) {
    const key = getKey(r);
    if (bankState[key]?.status === 'failed') return 'cash';
    return r.paymentType;
}

function cleanDirty() {
    const cutoff = Date.now() - DIRTY_GRACE_MS;
    for (const [k, t] of dirtyKeys) { if (t < cutoff) dirtyKeys.delete(k); }
}

// GAS URL: data.js に埋め込まれた値を優先し、なければ端末の設定を使う
function getGasUrl() {
    return (typeof window.GAS_URL === 'string' && window.GAS_URL)
        ? window.GAS_URL
        : (localStorage.getItem('gas_url') || '');
}

// GAS への POST 送信（sendBeacon 優先、サイズ超過や失敗時は fetch にフォールバック）
function postToGas(url, data) {
    const body = JSON.stringify(data);
    if (navigator.sendBeacon) {
        const blob = new Blob([body], { type: 'text/plain' });
        if (navigator.sendBeacon(url, blob)) return; // 成功したらここで終了
        // sendBeacon 失敗（64KB超過など）→ fetch にフォールバック
    }
    fetch(url, { method: 'POST', mode: 'no-cors', body })
        .catch(e => console.error('送信エラー', e));
}

// ─── Helpers ─────────────────────────────────────────────────────
function getKey(r) {
    return r.key || `${r.store}|${r.dataMonth}|${r.code}|${r.name}`;
}

function loadChecked() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
}

function saveChecked() {
    localStorage.setItem(LS_KEY, JSON.stringify(checked));
}

function fmt(n) { return (n || 0).toLocaleString(); }

function fmtDate(d) {
    if (!d) return '—';
    const [, m, day] = d.split('-');
    return `${parseInt(m)}月${parseInt(day)}日`;
}

// ─── Filter ──────────────────────────────────────────────────────
function filteredData() {
    return allData.filter(r => {
        const key        = getKey(r);
        const effPayment = effectivePaymentType(r);

        if (filters.store   && r.store         !== filters.store)   return false;
        if (filters.month   && r.dataMonth     !== filters.month)   return false;
        if (filters.route   && String(r.route) !== filters.route)   return false;
        if (filters.payment && effPayment      !== filters.payment) return false;
        if ((r.amount || 0) === 0)                                   return false;

        // 口振完了：未集金フィルター ON のとき非表示（一括チェックモード中は取消のため表示）
        if (!bulkMode && bankState[key]?.status === 'completed' && filters.uncollectedOnly) return false;

        // 振込入金済み：未集金フィルター ON のとき非表示
        if (transferState[key] && filters.uncollectedOnly) return false;

        if (filters.uncollectedOnly && checked[key]) {
            // 当日チェックしたものは終日リストに残す
            const state      = checked[key];
            const checkedDay = new Date(state.checkedAt).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
            const today      = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
            if (checkedDay !== today) return false;
        }
        if (filters.search) {
            const q = filters.search.toLowerCase();
            if (!r.name.toLowerCase().includes(q) && !(r.address || '').toLowerCase().includes(q)) return false;
        }
        return true;
    });
}

// ─── Render Filters ──────────────────────────────────────────────
function renderFilters() {
    const definedOrder = (window.DATA_META && window.DATA_META.stores) || [];
    const dataStores   = new Set(allData.map(r => r.store));
    const stores = definedOrder.length
        ? definedOrder.filter(s => dataStores.has(s))
        : [...dataStores].sort();
    const months  = [...new Set(allData.map(r => r.dataMonth))].sort();
    const routes  = [...new Set(allData.map(r => r.route))].sort((a, b) => a - b);

    document.getElementById('filter-store').innerHTML =
        '<option value="">全店舗</option>' + stores.map(s => `<option value="${s}">${s}</option>`).join('');

    document.getElementById('filter-month').innerHTML =
        '<option value="">全月</option>' + months.map(m => `<option value="${m}">${m}</option>`).join('');

    document.getElementById('filter-route').innerHTML =
        '<option value="">全ルート</option>' + routes.map(r => `<option value="${r}">R${r}</option>`).join('');
}

// ─── Render Header ───────────────────────────────────────────────
function renderHeader(data) {
    const badge = document.getElementById('month-badge');
    if (filters.month) {
        badge.textContent = filters.month;
    } else {
        const months = [...new Set(allData.map(r => r.dataMonth))].sort();
        badge.textContent = months.length === 1 ? months[0] : months.join(' / ');
    }
}

// ─── Render Table ────────────────────────────────────────────────
function renderTable() {
    const data  = filteredData();
    const tbody = document.getElementById('tbody');

    if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="no-results">該当するデータがありません</td></tr>';
        renderHeader(filteredData());
        return;
    }

    let html = '';
    data.forEach(r => {
        const key            = getKey(r);
        const isChecked      = !!checked[key];
        const state          = checked[key] || {};
        const date           = state.collectDate || '';
        const effPayment     = effectivePaymentType(r);
        const isBankCustomer  = effPayment === 'bank';
        const isBankCompleted = isBankCustomer && bankState[key]?.status === 'completed';
        const isBankFailed    = bankState[key]?.status === 'failed';
        const isTransferred   = !!transferState[key];

        let payBadge;
        if (isBankFailed) {
            payBadge = '<span class="pay-badge pay-bank-failed">口振失敗</span>';
        } else if (isBankCustomer) {
            payBadge = '<span class="pay-badge pay-bank">口振</span>';
        } else {
            payBadge = '<span class="pay-badge pay-cash">現金</span>';
        }

        let rowClass = '';
        if (isTransferred)        rowClass = 'row-transfer';
        else if (isBankCompleted) rowClass = 'row-bank-completed';
        else if (isChecked)       rowClass = 'row-checked';
        if ((r.amount || 0) === 0) rowClass += ' row-zero';

        const checkboxHtml = isBankCustomer
            ? `<input type="checkbox" class="check-box bank-check" data-key="${key}" ${isBankCompleted ? 'checked' : ''}>`
            : `<input type="checkbox" class="check-box" data-key="${key}" ${isChecked ? 'checked' : ''}>`;

        // 口振顧客は集金日セルは編集不要
        const dateCellHtml = isBankCustomer
            ? `<td class="col-date">—</td>`
            : `<td class="col-date" data-key="${key}">${fmtDate(date)}</td>`;

        // 振込入金セル（口振顧客には表示しない）
        let transferCellHtml;
        if (isBankCustomer) {
            transferCellHtml = `<td class="col-transfer"></td>`;
        } else if (isTransferred) {
            transferCellHtml = `<td class="col-transfer transfer-done" data-key="${key}" title="クリックで取消">${fmtDate(transferState[key].date)} ✕</td>`;
        } else {
            transferCellHtml = `<td class="col-transfer"><button class="btn-transfer" data-key="${key}">振込入金</button></td>`;
        }

        html += `<tr class="${rowClass}" data-key="${key}">
            <td class="col-check">${checkboxHtml}</td>
            <td class="col-route">R${r.route}</td>
            <td class="col-month">${r.dataMonth.slice(5)}月</td>
            <td class="col-name"><div class="name-inner">${payBadge}${r.name}</div></td>
            <td class="col-addr">${r.address || ''}</td>
            <td class="col-amount">¥${fmt(r.amount)}</td>
            ${dateCellHtml}
            ${transferCellHtml}
        </tr>`;
    });

    tbody.innerHTML = html;

    // イベント登録（現金チェックボックス）
    tbody.querySelectorAll('input.check-box:not(.bank-check)').forEach(cb => {
        cb.addEventListener('change', () => onCheck(cb.dataset.key, cb.checked));
    });

    // イベント登録（口振完了チェックボックス）
    tbody.querySelectorAll('input.bank-check').forEach(cb => {
        cb.addEventListener('change', () => onBankCheck(cb.dataset.key, cb.checked));
    });

    // イベント登録（集金日）
    tbody.querySelectorAll('td.col-date[data-key]').forEach(cell => {
        cell.addEventListener('click', () => editDate(cell.dataset.key, cell));
    });

    // イベント登録（振込入金ボタン）
    tbody.querySelectorAll('button.btn-transfer').forEach(btn => {
        btn.addEventListener('click', () => {
            const cell = btn.closest('td');
            onTransferClick(btn.dataset.key, cell);
        });
    });

    // イベント登録（振込入金 取消）
    tbody.querySelectorAll('td.transfer-done[data-key]').forEach(cell => {
        cell.addEventListener('click', () => onTransferRevert(cell.dataset.key));
    });

    // 一括チェックモード中はチェック状態を復元
    restoreBulkVisual();

    renderHeader(data);
}

// ─── Check Action ────────────────────────────────────────────────
function onCheck(key, isChecked) {
    if (!isChecked) {
        if (!confirm('チェックを解除しますか？')) {
            const cb = document.querySelector(`input[data-key="${key}"]`);
            if (cb) cb.checked = true;
            return;
        }
        delete checked[key];
    } else {
        const today   = new Date();
        const jstDate = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
        const record  = allData.find(r => getKey(r) === key);
        checked[key] = {
            checkedAt:   today.toISOString(),
            collectDate: (checked[key] || {}).collectDate || jstDate,
            // 管理画面の履歴表示用スナップショット（data.js が更新されても記録が消えないよう保持）
            snapshot: record ? {
                name:      record.name,
                amount:    record.amount,
                route:     record.route,
                store:     record.store,
                dataMonth: record.dataMonth,
            } : (checked[key]?.snapshot || null)
        };
    }

    const row = document.querySelector(`tr[data-key="${key}"]`);
    if (row) {
        row.classList.toggle('row-checked', isChecked);
        const dateCell = row.querySelector('td.col-date[data-key]');
        if (dateCell) dateCell.textContent = fmtDate((checked[key] || {}).collectDate);
    }

    markDirty(key);
    saveChecked();
    renderHeader(filteredData());

    // GAS 送信
    const url = getGasUrl();
    if (url) {
        const record = allData.find(r => getKey(r) === key);
        const state  = checked[key] || {};
        postToGas(url, {
            action:      isChecked ? 'add' : 'remove',
            record:      { ...record, key, checkedAt: state.checkedAt || '' },
            collectDate: state.collectDate || ''
        });

        // 送信後に再同期して他端末への反映を確認
        setTimeout(syncCheckboxes, 3000);
    }
}

// ─── Bank Complete Action ─────────────────────────────────────────
function onBankCheck(key, isChecked) {
    // 一括チェックモード中は DOM 状態だけ追跡し、保存は「登録」ボタンで行う
    if (bulkMode) {
        if (!isChecked) {
            bulkUncheckedKeys.add(key);
        } else {
            bulkUncheckedKeys.delete(key);
        }
        return;
    }

    if (isChecked) {
        // 口振完了 → リストから削除（uncollectedOnly ON 時）
        const completedAt = new Date().toISOString();
        bankState[key] = { status: 'completed', updatedAt: completedAt };
        saveBankState();

        // GAS 送信
        const url = getGasUrl();
        if (url) {
            const record = allData.find(r => getKey(r) === key);
            if (record) postToGas(url, { action: 'bankComplete', record: { ...record, key }, completedAt });
        }

        renderTable();
    } else {
        // チェック解除 → 引き落とし失敗、現金集金に変更
        if (!confirm('口座振替の引き落としができませんでした。\n現金集金に変更しますか？')) {
            const cb = document.querySelector(`input.bank-check[data-key="${key}"]`);
            if (cb) cb.checked = true;
            return;
        }
        bankState[key] = { status: 'failed', updatedAt: new Date().toISOString() };
        saveBankState();

        // GAS 送信（口座振替シートから削除）
        const url = getGasUrl();
        if (url) {
            const record = allData.find(r => getKey(r) === key);
            if (record) postToGas(url, { action: 'bankRemove', record: { ...record, key } });
        }

        renderTable();
    }
}

// ─── Date Edit ───────────────────────────────────────────────────
function editDate(key, cell) {
    const current = (checked[key] || {}).collectDate || '';
    const input   = document.createElement('input');
    input.type      = 'date';
    input.className = 'date-edit';
    input.value     = current;
    cell.innerHTML  = '';
    cell.appendChild(input);
    input.focus();

    function save() {
        const val = input.value;
        if (!checked[key]) checked[key] = { checkedAt: new Date().toISOString() };
        checked[key].collectDate = val;
        markDirty(key);
        saveChecked();
        cell.textContent = fmtDate(val);

        // GAS 同期
        const url = getGasUrl();
        if (url) {
            const record = allData.find(r => getKey(r) === key);
            const state  = checked[key];
            postToGas(url, {
                action:      'add',
                record:      { ...record, key, checkedAt: state.checkedAt || '' },
                collectDate: val
            });
        }
    }
    input.addEventListener('change', save);
    input.addEventListener('blur',   save);
}

// ─── Bulk Bank Check ─────────────────────────────────────────────
function checkAllBank() {
    // 一括モード開始（完了済みも filteredData に含めるため先に設定）
    bulkMode = true;
    bulkAffectedKeys.clear();
    bulkPreviouslyCompleted.clear();
    bulkUncheckedKeys.clear();

    renderTable(); // 完了済み口振も含めて再描画

    // 失敗（現金変更済み）以外の口振顧客を対象にする
    const targets = filteredData().filter(r =>
        r.paymentType === 'bank' && bankState[getKey(r)]?.status !== 'failed'
    );

    if (targets.length === 0) {
        bulkMode = false;
        renderTable();
        alert('対象の口振顧客がありません');
        return;
    }

    bulkAffectedKeys       = new Set(targets.map(r => getKey(r)));
    bulkPreviouslyCompleted = new Set(
        targets.filter(r => bankState[getKey(r)]?.status === 'completed').map(r => getKey(r))
    );

    restoreBulkVisual(); // チェックボックス状態を設定

    document.getElementById('btn-bulk-check').classList.add('hidden');
    document.getElementById('btn-bulk-register').classList.remove('hidden');
}

function registerBulkBank() {
    // 完了済み → チェックを外した → 取消
    const revert  = [...bulkPreviouslyCompleted].filter(k => bulkUncheckedKeys.has(k));
    // 未完了 → チェックを外した → 現金集金に変更
    const failed  = [...bulkUncheckedKeys].filter(k => bulkAffectedKeys.has(k) && !bulkPreviouslyCompleted.has(k));
    // 未完了 → チェックのまま → 完了
    const success = [...bulkAffectedKeys].filter(k => !bulkPreviouslyCompleted.has(k) && !bulkUncheckedKeys.has(k));

    const lines = [];
    if (success.length > 0) lines.push(`【完了】${success.length} 件`);
    if (failed.length  > 0) lines.push(`【現金集金へ変更】${failed.length} 件`);
    if (revert.length  > 0) lines.push(`【取消】${revert.length} 件`);
    if (!confirm(lines.join('　') + '\n登録しますか？')) return;

    const now = new Date();
    success.forEach(key => {
        bankState[key] = { status: 'completed', updatedAt: now.toISOString() };
    });
    failed.forEach(key => {
        bankState[key] = { status: 'failed', updatedAt: now.toISOString() };
    });
    revert.forEach(key => {
        delete bankState[key]; // 完了状態を削除して未処理に戻す
    });

    saveBankState();

    // GAS 送信（全員分を1回のリクエストにまとめて送信）
    const url = getGasUrl();
    if (url) {
        const toRecord = key => {
            const record = allData.find(r => getKey(r) === key);
            return record ? { ...record, key } : null;
        };
        postToGas(url, {
            action:      'bankCompleteBatch',
            completedAt: now.toISOString(),
            success:     success.map(toRecord).filter(Boolean),
            remove:      [...failed, ...revert].map(toRecord).filter(Boolean),
        });
    }

    // 一括モード終了
    bulkMode = false;
    bulkAffectedKeys.clear();
    bulkUncheckedKeys.clear();
    bulkPreviouslyCompleted.clear();

    document.getElementById('btn-bulk-check').classList.remove('hidden');
    document.getElementById('btn-bulk-register').classList.add('hidden');

    renderTable();
}

// renderTable 後に一括チェック状態を DOM へ反映
function restoreBulkVisual() {
    if (!bulkMode) return;
    bulkAffectedKeys.forEach(key => {
        const cb = document.querySelector(`input.bank-check[data-key="${key}"]`);
        if (cb) cb.checked = !bulkUncheckedKeys.has(key);
    });
}

// ─── Transfer Payment ────────────────────────────────────────────
function onTransferClick(key, cell) {
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
    const input = document.createElement('input');
    input.type      = 'date';
    input.className = 'date-edit';
    input.value     = today;
    cell.innerHTML  = '';
    cell.appendChild(input);
    input.focus();

    let saved = false;
    function save() {
        if (saved) return;
        const val = input.value;
        if (!val) { renderTable(); return; }
        saved = true;
        const recordedAt = new Date().toISOString();
        transferState[key] = { date: val, recordedAt };
        saveTransferState();

        // GAS 送信
        const url = getGasUrl();
        if (url) {
            const record = allData.find(r => getKey(r) === key);
            if (record) postToGas(url, { action: 'addTransfer', record: { ...record, key }, transferDate: val, recordedAt });
        }

        renderTable();
    }
    input.addEventListener('change', save);
    input.addEventListener('blur',   () => setTimeout(save, 150));
}

// ─── Transfer Revert ─────────────────────────────────────────────
function onTransferRevert(key) {
    if (!confirm('振込入金の消し込みを取り消しますか？')) return;
    delete transferState[key];
    saveTransferState();

    const url = getGasUrl();
    if (url) {
        const record = allData.find(r => getKey(r) === key);
        if (record) postToGas(url, { action: 'removeTransfer', record: { ...record, key } });
    }

    renderTable();
}

// ─── Admin Actions Toggle ────────────────────────────────────────
function toggleAdminActions() {
    const row = document.getElementById('action-row');
    const btn = document.getElementById('btn-admin-toggle');
    const isHidden = row.classList.toggle('hidden');
    btn.classList.toggle('active', !isHidden);
}

// ─── Reset ───────────────────────────────────────────────────────
function resetAll() {
    if (!confirm('全てのチェック（現金・口座振替・振込）をリセットしますか？\nこの操作は元に戻せません。')) return;
    checked       = {};
    bankState     = {};
    transferState = {};
    saveChecked();
    saveBankState();
    saveTransferState();
    dirtyKeys.clear();
    renderTable();

    // GAS のスプレッドシートも全件削除
    const url = getGasUrl();
    if (url) postToGas(url, { action: 'resetAll' });
}

// ─── Tab Switch ──────────────────────────────────────────────────
function switchTab(tab) {
    currentTab = tab;
    document.getElementById('tab-list').classList.toggle('hidden', tab !== 'list');
    document.getElementById('tab-msg').classList.toggle('hidden',  tab !== 'msg');
    document.getElementById('tab-admin').classList.toggle('hidden', tab !== 'admin');
    document.getElementById('nav-list').classList.toggle('active', tab === 'list');
    document.getElementById('nav-msg').classList.toggle('active',  tab === 'msg');
    document.getElementById('nav-admin').classList.toggle('active', tab === 'admin');
    if (tab === 'admin') renderAdmin();
    if (tab === 'msg')   renderMsgTab();
}

// ─── Admin Tab ───────────────────────────────────────────────────
function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toJSTDate(isoStr) {
    if (!isoStr) return null;
    if (isoStr.length === 10) return isoStr;
    return new Date(isoStr).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

const CHANGE_KEY = 'coll-change-v1';
function getChangeAmounts() {
    try { return JSON.parse(localStorage.getItem(CHANGE_KEY) || '{}'); } catch { return {}; }
}

function toggleMonthDetail(safeId) {
    const detailRows = document.querySelectorAll(`[data-month-group="${safeId}"]`);
    const headerTh   = document.querySelector(`[data-toggle-id="${safeId}"]`);
    if (!detailRows.length) return;
    const anyVisible = [...detailRows].some(r => !r.classList.contains('hidden'));
    detailRows.forEach(r => r.classList.toggle('hidden', anyVisible));
    if (headerTh) headerTh.innerHTML = headerTh.innerHTML.replace(anyVisible ? '▼' : '▶', anyVisible ? '▶' : '▼');
}

function toggleRouteDetail(safeRouteId) {
    const detailRow  = document.querySelector(`[data-detail-id="${safeRouteId}"]`);
    const headerCell = document.querySelector(`[data-toggle-id="${safeRouteId}"]`);
    if (!detailRow || !headerCell) return;
    const hidden = detailRow.classList.toggle('hidden');
    headerCell.innerHTML = headerCell.innerHTML.replace(hidden ? '▼' : '▶', hidden ? '▶' : '▼');
}

function buildDailySection(date, routes, routeMonthData, dateItems) {
    const [, m, day] = date.split('-');
    const dateLabel  = `${parseInt(m)}月${parseInt(day)}日`;

    const monthSet = new Set();
    for (const r of routes) {
        for (const mo of Object.keys(routeMonthData[r] || {})) monthSet.add(mo);
    }
    const months = [...monthSet].sort();
    const changeAmounts = getChangeAmounts();

    let html = `<div class="admin-section">`;
    html += `<h2 class="admin-title">${dateLabel}　集金分</h2>`;
    html += `<div class="excel-wrap"><table class="excel-table">`;
    html += `<thead><tr><th class="corner-cell">項目</th>`;
    for (const r of routes) html += `<th>ルート ${r}</th>`;
    html += `<th class="total-col">合計</th></tr></thead><tbody>`;

    for (const mo of months) {
        const [, mm] = mo.split('-');
        const moLabel = `${parseInt(mm)}月分小計`;
        const safeId  = `${date.replace(/-/g, '')}${mo.replace(/-/g, '')}`;
        let moRowTotal = 0;

        const moItems = dateItems.filter(({ record: r }) => r.dataMonth === mo && r.route > 0);

        html += `<tr class="month-subtotal-row">`;
        html += `<th class="row-header clickable-row" data-toggle-id="${safeId}" onclick="toggleMonthDetail('${safeId}')">${moLabel} ▶</th>`;
        for (const r of routes) {
            const amt     = (routeMonthData[r]?.[mo]) || 0;
            moRowTotal   += amt;
            const rItems  = moItems.filter(({ record }) => record.route === r);
            const safeRId = `${safeId}r${r}`;
            if (amt > 0 && rItems.length > 0) {
                html += `<td class="has-value clickable-cell" data-toggle-id="${safeRId}" onclick="toggleRouteDetail('${safeRId}')">${fmt(amt)} ▶</td>`;
            } else {
                html += `<td class="${amt > 0 ? 'has-value' : 'empty-cell'}">${amt > 0 ? fmt(amt) : '-'}</td>`;
            }
        }
        html += `<td class="total-cell">${fmt(moRowTotal)}</td></tr>`;

        for (const r of routes) {
            const rItems = moItems.filter(({ record }) => record.route === r);
            if (rItems.length === 0) continue;
            const safeRId = `${safeId}r${r}`;
            html += `<tr class="detail-row hidden" data-detail-id="${safeRId}" data-month-group="${safeId}">`;
            html += `<td class="detail-empty"></td>`;
            for (const rr of routes) {
                if (rr === r) {
                    html += `<td class="detail-cell-col"><div class="detail-list">`;
                    for (const { key, record } of rItems) {
                        const effAmt = effectiveAmount(key, record);
                        const isModified = amountOverrides[key] !== undefined;
                        html += `<div class="detail-item">`;
                        html += `<span class="detail-name">${escHtml(record.name)}</span>`;
                        html += `<span class="detail-amount editable-amount${isModified ? ' amount-modified' : ''}" data-key="${escHtml(key)}" title="タップして金額を修正" onclick="startAmountEdit(this)">${fmt(effAmt)}&#9998;</span>`;
                        html += `</div>`;
                    }
                    html += `</div></td>`;
                } else {
                    html += `<td class="detail-empty"></td>`;
                }
            }
            html += `<td class="detail-empty"></td></tr>`;
        }
    }

    // 集金合計行
    const routeTotals = {};
    let grandTotal = 0;
    html += `<tr class="grand-row"><th class="row-header">集金合計</th>`;
    for (const r of routes) {
        let rTotal = 0;
        for (const mo of months) rTotal += (routeMonthData[r]?.[mo]) || 0;
        routeTotals[r] = rTotal;
        grandTotal += rTotal;
        html += `<td class="total-cell${rTotal === 0 ? ' empty-cell' : ''}">${rTotal > 0 ? fmt(rTotal) : '-'}</td>`;
    }
    html += `<td class="total-cell grand-total">${fmt(grandTotal)}</td></tr>`;

    // 釣銭持ち出し行
    let changeTotalSum = 0;
    html += `<tr class="change-row"><th class="row-header">釣銭持ち出し</th>`;
    for (const r of routes) {
        const ck = `${date}|${r}`;
        const ca = changeAmounts[ck] !== undefined ? changeAmounts[ck] : 12220;
        changeTotalSum += ca;
        html += `<td class="change-cell"><input type="text" inputmode="numeric" class="change-input" data-date="${date}" data-route="${r}" value="${ca.toLocaleString('ja-JP')}"></td>`;
    }
    html += `<td class="total-cell" data-change-total="${date}">${fmt(changeTotalSum)}</td></tr>`;

    // 手持ち現金行
    let cashTotal = 0;
    html += `<tr class="cash-row"><th class="row-header">手持ち現金</th>`;
    for (const r of routes) {
        const ck = `${date}|${r}`;
        const ca = changeAmounts[ck] !== undefined ? changeAmounts[ck] : 12220;
        const cash = (routeTotals[r] || 0) + ca;
        cashTotal += cash;
        html += `<td class="cash-cell" data-cash-key="${ck}" data-base="${routeTotals[r] || 0}">${fmt(cash)}</td>`;
    }
    html += `<td class="total-cell grand-total" data-cash-total="${date}">${fmt(cashTotal)}</td></tr>`;

    html += `</tbody></table></div></div>`;
    return html;
}

// ─── 管理画面 金額インライン編集 ─────────────────────────────────
function startAmountEdit(span) {
    if (span.querySelector('input')) return; // 二重起動防止
    const key     = span.getAttribute('data-key');
    const record  = allData.find(r => getKey(r) === key);
    const current = amountOverrides[key] !== undefined
        ? amountOverrides[key]
        : (record?.amount || 0);

    const input = document.createElement('input');
    input.type        = 'text';
    input.inputMode   = 'numeric';
    input.className   = 'amount-edit-input';
    input.value       = current;
    input.setAttribute('data-key', key);

    const finish = () => {
        const raw = parseInt(input.value.replace(/[^\d]/g, ''), 10);
        if (!isNaN(raw) && raw !== current) {
            amountOverrides[key] = raw;
            saveAmountOverrides();
            const url = getGasUrl();
            if (url && record) {
                postToGas(url, { action: 'updateAmount', key, amount: raw, store: record.store });
            }
        }
        renderAdmin();
    };

    input.addEventListener('blur', finish);
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter')  { input.blur(); }
        if (e.key === 'Escape') { input.removeEventListener('blur', finish); renderAdmin(); }
    });

    span.replaceWith(input);
    input.focus();
    input.select();
}

function renderAdmin() {
    const content  = document.getElementById('admin-content');
    const storeVal = filters.store;

    // 集金データを日付でグループ化
    const checkedItems = [];
    for (const [key, state] of Object.entries(checked)) {
        if (!state?.checkedAt) continue;
        // allData に存在しない場合はスナップショットで代替（data.js 更新後も履歴を保持）
        const record = allData.find(r => getKey(r) === key) || state.snapshot || null;
        if (!record) continue;
        if (storeVal && record.store !== storeVal) continue;
        checkedItems.push({ key, record, state });
    }

    const srcRecords = storeVal ? allData.filter(r => r.store === storeVal) : allData;
    const routes = [...new Set(srcRecords.map(r => r.route).filter(r => r > 0))].sort((a, b) => a - b);

    const byDateRouteMonth = {};
    const byDate = {};
    for (const item of checkedItems) {
        const { key, record, state } = item;
        const d  = toJSTDate(state.checkedAt) || '不明';
        const r  = record.route > 0 ? record.route : null;
        const mo = record.dataMonth || '不明';
        if (!r) continue;
        if (!byDateRouteMonth[d]) byDateRouteMonth[d] = {};
        if (!byDateRouteMonth[d][r]) byDateRouteMonth[d][r] = {};
        byDateRouteMonth[d][r][mo] = (byDateRouteMonth[d][r][mo] || 0) + effectiveAmount(key, record);
        if (!byDate[d]) byDate[d] = [];
        byDate[d].push(item);
    }

    // 連絡事項を日付でグループ化
    const allMsgs = loadAllMessages();
    const filteredMsgs = storeVal ? allMsgs.filter(m => m.store === storeVal) : allMsgs;
    const msgsByDate = {};
    filteredMsgs.forEach(m => {
        const dk = m.createdAt.slice(0, 10);
        if (!msgsByDate[dk]) msgsByDate[dk] = [];
        msgsByDate[dk].push(m);
    });

    // 集金・連絡事項どちらかがある全日付を新しい順で列挙
    const allDates = [...new Set([...Object.keys(byDate), ...Object.keys(msgsByDate)])].sort().reverse();

    if (allDates.length === 0) {
        content.innerHTML = '<p class="empty-msg">集金済みデータがありません</p>';
        return;
    }

    let html = '';
    for (const d of allDates) {
        if (byDate[d]) {
            html += buildDailySection(d, routes, byDateRouteMonth[d] || {}, byDate[d]);
        }
        if (msgsByDate[d]) {
            html += buildDailyMessages(d, msgsByDate[d]);
        }
    }
    content.innerHTML = html;
}

// ─── Messages ────────────────────────────────────────────────
const MSG_KEY = 'coll-messages-v1';

function loadMessages() {
    try {
        const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
        const all   = JSON.parse(localStorage.getItem(MSG_KEY) || '[]');
        // 当日分のみ返す（翌日以降は自動除外）
        return all.filter(m => {
            const d = m.createdAt ? m.createdAt.slice(0, 10) : '';
            return d === today;
        });
    } catch { return []; }
}

function loadAllMessages() {
    try { return JSON.parse(localStorage.getItem(MSG_KEY) || '[]'); } catch { return []; }
}

function saveMessages(msgs) {
    localStorage.setItem(MSG_KEY, JSON.stringify(msgs));
}

function renderMsgTab() {
    // 顧客セレクトを現在の店舗・ルートフィルターで絞り込み
    const sel = document.getElementById('msg-customer-select');
    const prevKey = sel.value;
    const customers = allData.filter(r => {
        if ((r.amount || 0) === 0) return false;
        if (filters.store && r.store !== filters.store) return false;
        if (filters.route && String(r.route) !== filters.route) return false;
        return true;
    });
    // 重複除去（同名・同店・同ルート）— 月をまたいで同一顧客は1件のみ
    const seen = new Set();
    const unique = customers.filter(r => {
        const k = `${r.store}|${r.route}|${r.name}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });

    // 「その他」用に現在フィルター中の店舗・ルートを特定
    const storeForOther = filters.store || '';
    const routeForOther = filters.route || '';
    const otherLabel = routeForOther ? `R${routeForOther} その他` : 'その他';

    sel.innerHTML = '<option value="">顧客を選択してください</option>' +
        unique.map(r => {
            const k = getKey(r);
            return `<option value="${k}" data-store="${escHtml(r.store)}" data-route="${r.route}" data-name="${escHtml(r.name)}">R${r.route} ${r.name}（${r.store}）</option>`;
        }).join('') +
        `<option value="__other__" data-store="${escHtml(storeForOther)}" data-route="${routeForOther}" data-name="その他">${otherLabel}</option>`;
    if (prevKey) sel.value = prevKey;
    onMsgCustomerChange();

    // 送信済み一覧（店舗フィルター適用 + 日付グループ化）
    const allMsgs = loadMessages();
    const msgs = filters.store ? allMsgs.filter(m => m.store === filters.store) : allMsgs;
    const list = document.getElementById('msg-sent-list');
    if (msgs.length === 0) {
        list.innerHTML = '<div class="msg-empty">送信済みの連絡事項はありません</div>';
        return;
    }
    const sorted = [...msgs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    // 日付キーでグループ化
    const groups = {};
    sorted.forEach(m => {
        const dk = m.createdAt.slice(0, 10);
        if (!groups[dk]) groups[dk] = [];
        groups[dk].push(m);
    });

    list.innerHTML = Object.keys(groups).sort((a, b) => b.localeCompare(a)).map(dk => {
        const label = new Date(dk + 'T12:00:00').toLocaleDateString('ja-JP',
            { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short' });
        const items = groups[dk].map(m => `
            <div class="msg-item">
                <div class="msg-item-meta">
                    <span class="msg-item-route">R${m.route}</span>
                    <span class="msg-item-name">${escHtml(m.customerName)}</span>
                    <span style="font-size:12px;color:var(--g500)">${escHtml(m.store)}</span>
                    <span class="msg-item-date">${fmtMsgTime(m.createdAt)}</span>
                </div>
                <div class="msg-item-text">${escHtml(m.text)}</div>
                <button class="msg-item-del" onclick="deleteMessage('${m.id}')">削除</button>
            </div>`).join('');
        return `<div class="msg-date-header">${label}</div>${items}`;
    }).join('');
}

function fmtMsgDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' }) + ' ' +
           d.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
}

function fmtMsgTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleTimeString('ja-JP',
        { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
}

function onMsgCustomerChange() {
    const sel     = document.getElementById('msg-customer-select');
    const typeSel = document.getElementById('msg-type-select');
    if (sel.value) {
        typeSel.classList.remove('hidden');
    } else {
        typeSel.classList.add('hidden');
        typeSel.value = '';
    }
}

function submitMessage() {
    const sel      = document.getElementById('msg-customer-select');
    const typeSel  = document.getElementById('msg-type-select');
    const freeText = document.getElementById('msg-textarea').value.trim();
    const typeVal  = typeSel.value;

    if (!sel.value) { alert('顧客を選択してください'); return; }
    if (!typeVal && !freeText) { alert('報告内容を選択するか、自由入力欄に入力してください'); return; }

    const opt   = sel.selectedOptions[0];
    const store = opt.dataset.store;
    const route = opt.dataset.route;
    const name  = opt.dataset.name;

    const parts = [];
    if (typeVal)  parts.push(typeVal);
    if (freeText) parts.push(freeText);
    const text = parts.join('\n');

    const msg = {
        id:           Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        store,
        route:        parseInt(route),
        customerKey:  sel.value,
        customerName: name,
        text,
        createdAt:    new Date().toISOString(),
    };

    const msgs = loadAllMessages();
    msgs.push(msg);
    saveMessages(msgs);

    typeSel.value = '';
    document.getElementById('msg-textarea').value = '';

    // GAS 送信
    const url = getGasUrl();
    if (url) postToGas(url, { action: 'addMessage', message: msg });

    renderMsgTab();
}

function deleteMessage(id) {
    if (!confirm('この連絡事項を削除しますか？')) return;
    const msgs = loadMessages().filter(m => m.id !== id);
    saveMessages(msgs);

    const url = getGasUrl();
    if (url) postToGas(url, { action: 'removeMessage', messageId: id });

    renderMsgTab();
}

function buildDailyMessages(date, msgs) {
    const [, m, day] = date.split('-');
    const dateLabel = `${parseInt(m)}月${parseInt(day)}日`;
    const sorted = [...msgs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    let html = `<div class="admin-section">`;
    html += `<h2 class="admin-title">&#128172; ${dateLabel}の連絡事項</h2>`;
    html += `<div class="admin-msg-store">`;
    sorted.forEach(m => {
        html += `<div class="admin-msg-item">
            <div class="admin-msg-item-meta">
                <span class="admin-msg-item-route">R${m.route}</span>
                <span class="admin-msg-item-name">${escHtml(m.customerName)}</span>
                <span style="font-size:12px;color:var(--g500)">${escHtml(m.store)}</span>
                <span class="admin-msg-item-date">${fmtMsgTime(m.createdAt)}</span>
            </div>
            <div class="admin-msg-item-text">${escHtml(m.text)}</div>
        </div>`;
    });
    html += '</div></div>';
    return html;
}

// ─── GAS Sync ────────────────────────────────────────────────────
async function syncCheckboxes() {
    const url = getGasUrl();
    if (!url) return;
    try {
        const res  = await fetch(url);
        const json = await res.json();
        // 新形式（checkedData）と旧形式（checkedKeys）の両方に対応
        if (!json.checkedData && !json.checkedKeys) return;

        // 期限切れのdirtyキーをクリア
        cleanDirty();

        if (json.checkedData) {
            // リモート優先でマージ（ただしdirtyキーはローカル変更を優先）
            const remote = json.checkedData;
            Object.entries(remote).forEach(([key, val]) => {
                if (dirtyKeys.has(key)) return; // 送信直後のキーは上書きしない
                if (!checked[key]) {
                    // リモートから追加（スナップショットなし）
                    checked[key] = { checkedAt: new Date().toISOString(), collectDate: val.collectDate || '' };
                } else {
                    // 既存エントリはスナップショットを保持しつつ、collectDate だけ補完
                    if (!checked[key].collectDate && val.collectDate) {
                        checked[key].collectDate = val.collectDate;
                    }
                }
            });
            // リモートにないキーを削除（dirtyキーは保護）
            Object.keys(checked).forEach(key => {
                if (!remote[key] && !dirtyKeys.has(key)) delete checked[key];
            });
        } else {
            const remote = new Set(json.checkedKeys);
            remote.forEach(key => {
                if (dirtyKeys.has(key)) return;
                if (!checked[key]) checked[key] = { checkedAt: new Date().toISOString(), collectDate: '' };
            });
            Object.keys(checked).forEach(key => {
                if (!remote.has(key) && !dirtyKeys.has(key)) delete checked[key];
            });
        }

        saveChecked();
        renderTable();

        // 連絡事項をリモートとマージ（自分のデータを正とし、リモートにしかないものを追加）
        if (Array.isArray(json.messages) && json.messages.length > 0) {
            const localMsgs = loadMessages();
            const localIds  = new Set(localMsgs.map(m => m.id));
            let changed = false;
            json.messages.forEach(m => {
                if (m.id && !localIds.has(m.id)) {
                    // GASのcreatedAtはJST文字列なのでそのまま保持
                    localMsgs.push({ ...m, createdAt: m.createdAt || new Date().toISOString() });
                    changed = true;
                }
            });
            if (changed) {
                saveMessages(localMsgs);
                if (currentTab === 'msg') renderMsgTab();
            }
        }
    } catch (e) { console.error('同期失敗', e); }
}

// ─── Settings Dialog ─────────────────────────────────────────────
function openSettings() {
    const embeddedUrl = (typeof window.GAS_URL === 'string' && window.GAS_URL) ? window.GAS_URL : '';
    const input = document.getElementById('settings-url-input');
    input.value = embeddedUrl || localStorage.getItem('gas_url') || '';
    input.readOnly = !!embeddedUrl;
    input.style.opacity = embeddedUrl ? '0.6' : '';
    const status = document.getElementById('settings-status');
    status.textContent = embeddedUrl ? 'data.js に URL が設定されています（変更はデータ更新スクリプトで行ってください）' : '';
    status.style.color = embeddedUrl ? '#2196F3' : '';
    document.getElementById('settings-dialog').showModal();
}

function closeSettings() {
    document.getElementById('settings-dialog').close();
}

function saveSettings() {
    if (typeof window.GAS_URL === 'string' && window.GAS_URL) {
        // data.js に埋め込まれている場合は保存不要
        setTimeout(closeSettings, 400);
        return;
    }
    const url = document.getElementById('settings-url-input').value.trim();
    localStorage.setItem('gas_url', url);
    document.getElementById('settings-status').textContent = url ? '保存しました' : 'URLを削除しました';
    document.getElementById('settings-status').style.color = '';
    setTimeout(closeSettings, 800);
    if (url) syncCheckboxes();
}

// ─── Init ────────────────────────────────────────────────────────
async function startApp() {
    let retry = 0;
    while (!window.COLLECTION_DATA && retry < 20) {
        await new Promise(r => setTimeout(r, 500));
        retry++;
    }

    if (!window.COLLECTION_DATA) {
        document.getElementById('tbody').innerHTML =
            '<tr><td colspan="8" style="color:red;padding:20px">データ(data.js)の読み込みに失敗しました。再読み込みしてください。</td></tr>';
        document.getElementById('loading-badge').textContent = 'エラー';
        return;
    }

    allData         = window.COLLECTION_DATA;
    checked         = loadChecked();
    bankState       = loadBankState();
    transferState   = loadTransferState();
    amountOverrides = loadAmountOverrides();

    renderFilters();

    // フィルター設定を復元（保存済みがあれば優先）
    const savedFilters = loadFilterState();
    if (savedFilters) {
        filters.store          = savedFilters.store          || '';
        filters.month          = savedFilters.month          || '';
        filters.route          = savedFilters.route          || '';
        filters.payment        = savedFilters.payment        ?? 'cash';
        filters.search         = savedFilters.search         || '';
        filters.uncollectedOnly = savedFilters.uncollectedOnly ?? true;
    } else {
        filters.payment        = 'cash';
        filters.uncollectedOnly = true;
    }
    document.getElementById('filter-store').value        = filters.store;
    document.getElementById('filter-month').value        = filters.month;
    document.getElementById('filter-route').value        = filters.route;
    document.getElementById('filter-payment').value      = filters.payment;
    document.getElementById('search-input').value        = filters.search;
    document.getElementById('toggle-uncollected').checked = filters.uncollectedOnly;

    renderTable();

    document.getElementById('loading-badge').style.display = 'none';

    // フィルターイベント
    document.getElementById('search-input').addEventListener('input', e => {
        filters.search = e.target.value;
        saveFilters();
        renderTable();
    });
    document.getElementById('filter-store').addEventListener('change', e => {
        filters.store = e.target.value;
        saveFilters();
        renderTable();
        if (currentTab === 'msg')   renderMsgTab();
        if (currentTab === 'admin') renderAdmin();
    });
    document.getElementById('filter-month').addEventListener('change', e => {
        filters.month = e.target.value;
        saveFilters();
        renderTable();
    });
    document.getElementById('filter-route').addEventListener('change', e => {
        filters.route = e.target.value;
        saveFilters();
        renderTable();
        if (currentTab === 'msg') renderMsgTab();
    });
    document.getElementById('filter-payment').addEventListener('change', e => {
        filters.payment = e.target.value;
        saveFilters();
        renderTable();
    });
    document.getElementById('toggle-uncollected').addEventListener('change', e => {
        filters.uncollectedOnly = e.target.checked;
        saveFilters();
        renderTable();
    });

    // 釣銭持ち出し入力（イベント委譲）
    const adminContent = document.getElementById('admin-content');
    adminContent.addEventListener('focus', e => {
        if (!e.target.classList.contains('change-input')) return;
        e.target.value = e.target.value.replace(/,/g, '');
    }, true);
    adminContent.addEventListener('blur', e => {
        if (!e.target.classList.contains('change-input')) return;
        const v = parseInt(e.target.value.replace(/,/g, '')) || 0;
        e.target.value = v.toLocaleString('ja-JP');
    }, true);
    adminContent.addEventListener('input', e => {
        if (!e.target.classList.contains('change-input')) return;
        const date  = e.target.dataset.date;
        const route = e.target.dataset.route;
        const val   = parseInt(e.target.value.replace(/,/g, '')) || 0;
        const ck    = `${date}|${route}`;

        const amounts = getChangeAmounts();
        amounts[ck] = val;
        localStorage.setItem(CHANGE_KEY, JSON.stringify(amounts));

        const cashCell = adminContent.querySelector(`[data-cash-key="${ck}"]`);
        if (cashCell) {
            const base = parseInt(cashCell.dataset.base) || 0;
            cashCell.textContent = fmt(base + val);
        }

        let changeTotal = 0;
        adminContent.querySelectorAll(`.change-input[data-date="${date}"]`).forEach(inp => {
            changeTotal += parseInt(inp.value.replace(/,/g, '')) || 0;
        });
        const ctCell = adminContent.querySelector(`[data-change-total="${date}"]`);
        if (ctCell) ctCell.textContent = fmt(changeTotal);

        let cashSum = 0;
        adminContent.querySelectorAll(`.cash-cell[data-cash-key]`).forEach(cell => {
            const [d] = cell.dataset.cashKey.split('|');
            if (d === date) cashSum += parseInt(cell.textContent.replace(/,/g, '')) || 0;
        });
        const cashTotal = adminContent.querySelector(`[data-cash-total="${date}"]`);
        if (cashTotal) cashTotal.textContent = fmt(cashSum);
    });

    // GAS 自動同期
    syncCheckboxes();
    setInterval(syncCheckboxes, 30000);
}

window.addEventListener('DOMContentLoaded', startApp);
