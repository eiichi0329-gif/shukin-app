// 集金管理アプリ v3

const LS_KEY = 'coll-state-v3';

// ─── State ───────────────────────────────────────────────────────
let allData = [];
let checked = {};   // key → { checkedAt, collectDate }
let filters = { store: '', month: '', route: '', payment: 'cash', search: '', uncollectedOnly: true };
let currentTab = 'list';
let expandedCell = null;  // { route, month } for admin detail

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

// ─── Filter ──────────────────────────────────────────────────────
function filteredData() {
    return allData.filter(r => {
        if (filters.store   && r.store          !== filters.store)   return false;
        if (filters.month   && r.dataMonth      !== filters.month)   return false;
        if (filters.route   && String(r.route)  !== filters.route)   return false;
        if (filters.payment && r.paymentType    !== filters.payment) return false;
        if ((r.amount || 0) === 0)                                     return false;
        if (filters.uncollectedOnly && checked[getKey(r)]) {
            // 当日チェックしたものは終日リストに残す
            const state      = checked[getKey(r)];
            const checkedDay = new Date(state.checkedAt).toDateString();
            const today      = new Date().toDateString();
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
    const stores  = [...new Set(allData.map(r => r.store))].sort();
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
    const months = [...new Set(allData.map(r => r.dataMonth))].sort();
    document.getElementById('month-badge').textContent =
        months.length === 1 ? months[0] : months.join(' / ');

    const total          = data.reduce((s, r) => s + (r.amount || 0), 0);
    const checkedCount   = data.filter(r => checked[getKey(r)]).length;
    const checkedAmount  = data.filter(r => checked[getKey(r)]).reduce((s, r) => s + (r.amount || 0), 0);

    document.getElementById('header-summary').textContent =
        `${checkedCount} / ${data.length} 件   ¥${fmt(checkedAmount)} / ¥${fmt(total)}`;

    // ルート×月 未集金サマリー
    const routeMap = {};
    allData.forEach(r => {
        if (checked[getKey(r)]) return;
        if (!routeMap[r.route]) routeMap[r.route] = {};
        routeMap[r.route][r.dataMonth] = (routeMap[r.route][r.dataMonth] || 0) + (r.amount || 0);
    });

    const allRoutes = [...new Set(allData.map(r => r.route))].sort((a, b) => a - b);
    let html = '';
    allRoutes.forEach(route => {
        const byMonth = routeMap[route];
        if (!byMonth) return;
        html += `<div class="rs-row"><span class="rs-label">R${route}</span>`;
        months.forEach(mo => {
            const amt = (byMonth[mo] || 0);
            html += `<span class="rs-pill${amt === 0 ? ' rs-zero' : ''}">
                <span class="rs-mo">${mo.slice(5)}月</span>
                <span class="rs-amt">¥${fmt(amt)}</span>
            </span>`;
        });
        html += '</div>';
    });
    document.getElementById('route-stats').innerHTML = html;
}

// ─── Render Table ────────────────────────────────────────────────
function renderTable() {
    const data  = filteredData();
    const tbody = document.getElementById('tbody');

    if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="no-results">該当するデータがありません</td></tr>';
        renderHeader(filteredData());
        return;
    }

    let html = '';
    data.forEach(r => {
        const key       = getKey(r);
        const isChecked = !!checked[key];
        const state     = checked[key] || {};
        const date      = state.collectDate || '';

        const payBadge = r.paymentType === 'bank'
            ? '<span class="pay-badge pay-bank">口振</span>'
            : '<span class="pay-badge pay-cash">現金</span>';

        html += `<tr class="${isChecked ? 'row-checked' : ''}${(r.amount || 0) === 0 ? ' row-zero' : ''}" data-key="${key}">
            <td class="col-check">
                <input type="checkbox" class="check-box" data-key="${key}" ${isChecked ? 'checked' : ''}>
            </td>
            <td class="col-route">R${r.route}</td>
            <td class="col-month">${r.dataMonth.slice(5)}月</td>
            <td class="col-name"><div class="name-inner">${payBadge}${r.name}</div></td>
            <td class="col-addr">${r.address || ''}</td>
            <td class="col-amount">¥${fmt(r.amount)}</td>
            <td class="col-date" data-key="${key}">${date || '—'}</td>
        </tr>`;
    });

    tbody.innerHTML = html;

    // イベント登録（チェックボックス）
    tbody.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => onCheck(cb.dataset.key, cb.checked));
    });

    // イベント登録（集金日）
    tbody.querySelectorAll('td.col-date[data-key]').forEach(cell => {
        cell.addEventListener('click', () => editDate(cell.dataset.key, cell));
    });

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
        checked[key] = {
            checkedAt:   new Date().toISOString(),
            collectDate: (checked[key] || {}).collectDate || ''
        };
    }

    const row = document.querySelector(`tr[data-key="${key}"]`);
    if (row) row.classList.toggle('row-checked', isChecked);

    saveChecked();
    renderHeader(filteredData());

    // GAS 送信
    const url = localStorage.getItem('gas_url');
    if (url) {
        const record = allData.find(r => getKey(r) === key);
        fetch(url, {
            method: 'POST',
            mode:   'no-cors',
            body:   JSON.stringify({ action: isChecked ? 'add' : 'remove', record: { ...record, key } })
        }).catch(e => console.error('送信エラー', e));
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
        saveChecked();
        cell.textContent = val || '—';
    }
    input.addEventListener('change', save);
    input.addEventListener('blur',   save);
}

// ─── Reset ───────────────────────────────────────────────────────
function resetAll() {
    if (!confirm('全てのチェックをリセットしますか？この操作は元に戻せません。')) return;
    checked = {};
    saveChecked();
    renderTable();
}

// ─── Tab Switch ──────────────────────────────────────────────────
function switchTab(tab) {
    currentTab = tab;
    document.getElementById('tab-list').classList.toggle('hidden', tab !== 'list');
    document.getElementById('tab-admin').classList.toggle('hidden', tab !== 'admin');
    document.getElementById('nav-list').classList.toggle('active', tab === 'list');
    document.getElementById('nav-admin').classList.toggle('active', tab === 'admin');
    if (tab === 'admin') renderAdmin();
}

// ─── Admin Tab ───────────────────────────────────────────────────
function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toJSTDate(isoStr) {
    if (!isoStr) return null;
    if (isoStr.length === 10) return isoStr;
    return new Date(new Date(isoStr).getTime() + 9 * 60 * 60 * 1000).toISOString().substring(0, 10);
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
                    for (const { record } of rItems) {
                        html += `<div class="detail-item"><span class="detail-name">${escHtml(record.name)}</span><span class="detail-amount">${fmt(record.amount)}</span></div>`;
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

function renderAdmin() {
    const content  = document.getElementById('admin-content');
    const storeVal = filters.store;

    const checkedItems = [];
    for (const [key, state] of Object.entries(checked)) {
        if (!state?.checkedAt) continue;
        const record = allData.find(r => getKey(r) === key);
        if (!record) continue;
        if (storeVal && record.store !== storeVal) continue;
        checkedItems.push({ key, record, state });
    }

    if (checkedItems.length === 0) {
        content.innerHTML = '<p class="empty-msg">集金済みデータがありません</p>';
        return;
    }

    const srcRecords = storeVal ? allData.filter(r => r.store === storeVal) : allData;
    const routes = [...new Set(srcRecords.map(r => r.route).filter(r => r > 0))].sort((a, b) => a - b);

    const byDateRouteMonth = {};
    const byDate = {};
    for (const item of checkedItems) {
        const { record, state } = item;
        const d  = toJSTDate(state.checkedAt) || '不明';
        const r  = record.route > 0 ? record.route : null;
        const mo = record.dataMonth || '不明';
        if (!r) continue;
        if (!byDateRouteMonth[d]) byDateRouteMonth[d] = {};
        if (!byDateRouteMonth[d][r]) byDateRouteMonth[d][r] = {};
        byDateRouteMonth[d][r][mo] = (byDateRouteMonth[d][r][mo] || 0) + (record.amount || 0);
        if (!byDate[d]) byDate[d] = [];
        byDate[d].push(item);
    }
    const dates = Object.keys(byDate).sort().reverse();

    let html = '';
    for (const d of dates) {
        html += buildDailySection(d, routes, byDateRouteMonth[d] || {}, byDate[d]);
    }
    content.innerHTML = html;
}

// ─── GAS Sync ────────────────────────────────────────────────────
async function syncCheckboxes() {
    const url = localStorage.getItem('gas_url');
    if (!url) return;
    try {
        const res  = await fetch(url);
        const json = await res.json();
        if (!json.checkedKeys) return;

        // リモート優先でマージ
        const remote = new Set(json.checkedKeys);
        remote.forEach(key => {
            if (!checked[key]) checked[key] = { checkedAt: new Date().toISOString(), collectDate: '' };
        });
        Object.keys(checked).forEach(key => { if (!remote.has(key)) delete checked[key]; });

        saveChecked();
        renderTable();
    } catch (e) { console.error('同期失敗', e); }
}

// ─── Settings Dialog ─────────────────────────────────────────────
function openSettings() {
    document.getElementById('settings-url-input').value = localStorage.getItem('gas_url') || '';
    document.getElementById('settings-status').textContent = '';
    document.getElementById('settings-dialog').showModal();
}

function closeSettings() {
    document.getElementById('settings-dialog').close();
}

function saveSettings() {
    const url = document.getElementById('settings-url-input').value.trim();
    localStorage.setItem('gas_url', url);
    document.getElementById('settings-status').textContent = url ? '保存しました' : 'URLを削除しました';
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
            '<tr><td colspan="7" style="color:red;padding:20px">データ(data.js)の読み込みに失敗しました。再読み込みしてください。</td></tr>';
        document.getElementById('loading-badge').textContent = 'エラー';
        return;
    }

    allData = window.COLLECTION_DATA;
    checked = loadChecked();

    renderFilters();
    document.getElementById('toggle-uncollected').checked = true;
    document.getElementById('filter-payment').value = 'cash';
    renderTable();

    document.getElementById('loading-badge').style.display = 'none';

    // フィルターイベント
    document.getElementById('search-input').addEventListener('input', e => {
        filters.search = e.target.value;
        renderTable();
    });
    document.getElementById('filter-store').addEventListener('change', e => {
        filters.store = e.target.value;
        renderTable();
    });
    document.getElementById('filter-month').addEventListener('change', e => {
        filters.month = e.target.value;
        renderTable();
    });
    document.getElementById('filter-route').addEventListener('change', e => {
        filters.route = e.target.value;
        renderTable();
    });
    document.getElementById('filter-payment').addEventListener('change', e => {
        filters.payment = e.target.value;
        renderTable();
    });
    document.getElementById('toggle-uncollected').addEventListener('change', e => {
        filters.uncollectedOnly = e.target.checked;
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
