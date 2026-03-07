// 集金管理アプリ - 最終完成版プログラム

async function startApp() {
    const container = document.getElementById('list-container');
    const badge = document.getElementById('loading-badge');

    // 1. データが届いているか確認（最大10秒間、0.5秒おきにチェック）
    let retryCount = 0;
    while (!window.COLLECTION_DATA && retryCount < 20) {
        await new Promise(resolve => setTimeout(resolve, 500));
        retryCount++;
    }

    if (!window.COLLECTION_DATA) {
        container.innerHTML = '<div style="color:red; padding:20px;">データ(data.js)の読み込みに失敗しました。再読み込みしてください。</div>';
        return;
    }

    // 2. 2800件超のデータを高速に組み立てる
    let html = '';
    window.COLLECTION_DATA.forEach(r => {
        const key = r.key || `${r.store}-${r.name}-${r.seq}`;
        html += `
            <div class="list-item">
                <label>
                    <input type="checkbox" data-key="${key}" onchange="sendCheck('${key}', this.checked)">
                    <div class="info">
                        <div class="name">${r.name}</div>
                        <div class="addr">${r.store} / ${r.address}</div>
                    </div>
                    <div class="price">¥${(r.amount || 0).toLocaleString()}</div>
                </label>
            </div>
        `;
    });

    // 3. 画面に反映して「読込中」を消す
    container.innerHTML = html;
    if (badge) badge.style.display = 'none';

    // 4. 同期を開始
    syncCheckboxes();
}

// チェック状態を送信
async function sendCheck(key, isChecked) {
    const url = localStorage.getItem('gas_url');
    if (!url) return;
    const record = window.COLLECTION_DATA.find(r => (r.key || `${r.store}-${r.name}-${r.seq}`) === key);
    try {
        await fetch(url, {
            method: 'POST',
            mode: 'no-cors',
            body: JSON.stringify({ action: isChecked ? 'add' : 'remove', record: { ...record, key } })
        });
    } catch (e) { console.error("送信エラー", e); }
}

// スプレッドシートの状態と同期
async function syncCheckboxes() {
    const url = localStorage.getItem('gas_url');
    if (!url) return;
    try {
        const res = await fetch(url);
        const json = await res.json();
        const checkboxes = document.querySelectorAll('input[type="checkbox"]');
        checkboxes.forEach(cb => {
            cb.checked = json.checkedKeys.includes(cb.getAttribute('data-key'));
        });
    } catch (e) { console.error("同期失敗", e); }
}

// 起動と30秒ごとの自動同期
window.addEventListener('DOMContentLoaded', startApp);
setInterval(syncCheckboxes, 30000);