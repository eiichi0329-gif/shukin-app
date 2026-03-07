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
        if (filters.uncollectedOnly && checked[getKey(r)])           return false;
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
function renderAdmin() {
    const routes = [...new Set(allData.map(r => r.route))].sort((a, b) => a - b);
    const months = [...new Set(allData.map(r => r.dataMonth))].sort();

    // matrix[route][month] = { total, collected, items }
    const matrix = {};
    routes.forEach(route => {
        matrix[route] = {};
        months.forEach(mo => {
            const items     = allData.filter(r => r.route === route && r.dataMonth === mo);
            const total     = items.reduce((s, r) => s + (r.amount || 0), 0);
            const collected = items.filter(r => checked[getKey(r)]).reduce((s, r) => s + (r.amount || 0), 0);
            matrix[route][mo] = { total, collected, items };
        });
    });

    const colTotals = {};
    months.forEach(mo => {
        colTotals[mo] = {
            total:     routes.reduce((s, r) => s + matrix[r][mo].total,     0),
            collected: routes.reduce((s, r) => s + matrix[r][mo].collected, 0),
        };
    });
    const grandTotal     = months.reduce((s, mo) => s + colTotals[mo].total,     0);
    const grandCollected = months.reduce((s, mo) => s + colTotals[mo].collected, 0);

    let html = `<div class="excel-wrap"><table class="excel-table"><thead><tr>
        <th class="corner-cell">ルート</th>`;
    months.forEach(mo => { html += `<th>${mo.slice(5)}月分</th>`; });
    html += `<th class="total-col">合計</th></tr></thead><tbody>`;

    routes.forEach(route => {
        const rowTotal     = months.reduce((s, mo) => s + matrix[route][mo].total,     0);

        html += `<tr><th class="row-header">R${route}</th>`;
        months.forEach(mo => {
            const cell       = matrix[route][mo];
            const isExpanded = expandedCell && expandedCell.route === route && expandedCell.month === mo;
            const cellClass  = cell.total > 0 ? 'clickable-cell' : '';
            html += `<td class="${cellClass}${isExpanded ? ' active' : ''}"
                data-route="${route}" data-month="${mo}">
                ${cell.total > 0 ? `¥${fmt(cell.total)}` : '<span style="color:var(--g300)">—</span>'}
            </td>`;
        });
        html += `<td class="total-cell">¥${fmt(rowTotal)}</td></tr>`;

        // 詳細展開行
        if (expandedCell && expandedCell.route === route) {
            html += `<tr class="detail-row"><td></td>`;
            months.forEach(mo => {
                if (expandedCell.month === mo) {
                    const items = matrix[route][mo].items;
                    html += `<td class="detail-cell-col"><div class="detail-list">`;
                    items.forEach(r => {
                        const isCk = !!checked[getKey(r)];
                        html += `<div class="detail-item">
                            <span class="detail-name" style="${isCk ? 'text-decoration:line-through;color:var(--g400)' : ''}">${r.name}</span>
                            <span class="detail-amount">¥${fmt(r.amount)}</span>
                        </div>`;
                    });
                    html += `</div></td>`;
                } else {
                    html += `<td class="detail-empty"></td>`;
                }
            });
            html += `<td class="detail-empty"></td></tr>`;
        }
    });

    // 釣銭行
    html += `<tr class="change-row"><th class="row-header">釣銭</th>`;
    months.forEach(mo => {
        const val = localStorage.getItem(`change-${mo}`) || '';
        html += `<td class="change-cell"><input class="change-input" type="number" placeholder="0"
            value="${val}" data-month="${mo}"></td>`;
    });
    html += `<td class="change-cell"></td></tr>`;

    // 手持ち現金行
    html += `<tr class="cash-row"><th class="row-header">手持ち現金</th>`;
    months.forEach(mo => {
        const change = parseInt(localStorage.getItem(`change-${mo}`) || '0') || 0;
        const cash   = colTotals[mo].collected + change;
        html += `<td class="cash-cell">¥${fmt(cash)}</td>`;
    });
    html += `<td class="grand-total">¥${fmt(grandCollected)}</td></tr>`;

    // 合計行
    html += `<tr class="grand-row"><th class="row-header">合計</th>`;
    months.forEach(mo => { html += `<td class="total-cell">¥${fmt(colTotals[mo].total)}</td>`; });
    html += `<td class="grand-total">¥${fmt(grandTotal)}</td></tr>`;

    html += `</tbody></table></div>`;
    document.getElementById('admin-content').innerHTML = html;

    // イベント登録（詳細展開）
    document.querySelectorAll('#admin-content td.clickable-cell').forEach(td => {
        td.addEventListener('click', () => {
            const route = parseInt(td.dataset.route);
            const mo    = td.dataset.month;
            expandedCell = (expandedCell && expandedCell.route === route && expandedCell.month === mo)
                ? null : { route, month: mo };
            renderAdmin();
        });
    });

    // イベント登録（釣銭入力）
    document.querySelectorAll('#admin-content .change-input').forEach(inp => {
        inp.addEventListener('change', () => {
            localStorage.setItem(`change-${inp.dataset.month}`, inp.value);
            renderAdmin();
        });
    });
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

    // GAS 自動同期
    syncCheckboxes();
    setInterval(syncCheckboxes, 30000);
}

window.addEventListener('DOMContentLoaded', startApp);
