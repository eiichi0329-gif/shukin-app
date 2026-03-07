// 【重要】app.js はこのプログラムコードだけにしてください

function renderApp() {
    const container = document.getElementById('list-container');
    const loadingMsg = document.querySelector('.読込中...'); // 読込中表示を探す
    if (!container) return;

    // 名簿データがあるかチェック
    if (typeof SHUKIN_DATA === 'undefined') {
        container.innerHTML = '<div style="color:red; padding:20px;">エラー：名簿データ(data.js)が見つかりません。データ更新.batを実行してください。</div>';
        return;
    }

    container.innerHTML = '';
    SHUKIN_DATA.forEach(record => {
        const div = document.createElement('div');
        div.className = 'list-item';
        div.innerHTML = `
            <label style="display: flex; align-items: center; gap: 10px; padding: 12px; border-bottom: 1px solid #eee;">
                <input type="checkbox" data-key="${record.key}" onchange="toggleCheck(this, '${record.key}')" style="width: 24px; height: 24px;">
                <div>
                    <div style="font-weight: bold; font-size: 1.1em;">${record.name}</div>
                    <div style="font-size: 0.85em; color: #666;">${record.store} / ${record.address} / ¥${record.amount.toLocaleString()}</div>
                </div>
            </label>
        `;
        container.appendChild(div);
    });

    // リストが表示されたら「読込中」を消す
    if (loadingMsg) loadingMsg.style.display = 'none';
    
    syncStatus(); // 同期開始
}

async function toggleCheck(el, key) {
    const url = localStorage.getItem('gas_url');
    if (!url) return;
    const record = SHUKIN_DATA.find(r => r.key === key);
    const action = el.checked ? 'add' : 'remove';
    try {
        await fetch(url, { method: 'POST', body: JSON.stringify({ action, record: { ...record, checkedAt: new Date().toISOString() } }) });
    } catch (err) { console.error(err); }
}

async function syncStatus() {
    const url = localStorage.getItem('gas_url');
    if (!url) return;
    try {
        const response = await fetch(url);
        const data = await response.json();
        document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.checked = data.checkedKeys.includes(cb.getAttribute('data-key'));
        });
    } catch (err) { console.error(err); }
}

setInterval(syncStatus, 30000);
document.addEventListener('DOMContentLoaded', renderApp);