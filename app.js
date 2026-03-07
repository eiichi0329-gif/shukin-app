// 集金管理アプリ - 超・頑丈版（大量データ対応）

async function initApp() {
    console.log("アプリ起動...");
    const container = document.getElementById('list-container');
    const loadingBtn = document.querySelector('button.読込中...') || document.querySelector('.読込中...');

    // 1. データの存在確認（window.COLLECTION_DATA を探す）
    const data = window.COLLECTION_DATA;
    
    if (!data || !Array.isArray(data)) {
        console.error("データが見つかりません。1秒後に再試行します。");
        setTimeout(initApp, 1000); // データが届くまで待機
        return;
    }

    console.log(`${data.length}件のデータを表示します...`);

    // 2. 画面を組み立てる（大量データなので、まずは枠だけ作る）
    let html = '';
    for (const record of data) {
        const key = record.key || `${record.store}-${record.name}-${record.seq}`;
        const amount = (record.amount || 0).toLocaleString();
        
        html += `
            <div class="list-item" style="border-bottom: 1px solid #eee; padding: 10px;">
                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                    <input type="checkbox" data-key="${key}" onchange="toggleCheck(this, '${key}')" style="width: 25px; height: 25px;">
                    <div style="flex: 1;">
                        <div style="font-weight: bold; font-size: 16px;">${record.name}</div>
                        <div style="font-size: 12px; color: #666;">${record.store} / ${record.address}</div>
                    </div>
                    <div style="font-weight: bold; color: #c2410c;">¥${amount}</div>
                </label>
            </div>
        `;
    }

    // 3. 一気に画面に流し込む（これが一番速い）
    container.innerHTML = html;

    // 4. 「読込中」を消す
    if (loadingBtn) loadingBtn.style.display = 'none';

    // 5. チェック状態を同期
    syncStatus();
}

// チェック操作の送信
async function toggleCheck(el, key) {
    const url = localStorage.getItem('gas_url');
    if (!url) return;
    const record = window.COLLECTION_DATA.find(r => (r.key || `${r.store}-${r.name}-${r.seq}`) === key);
    try {
        await fetch(url, {
            method: 'POST',
            mode: 'no-cors', // エラー回避のため
            body: JSON.stringify({ action: el.checked ? 'add' : 'remove', record: { ...record, key, checkedAt: new Date().toISOString() } })
        });
    } catch (e) { console.error(e); }
}

// 同期処理
async function syncStatus() {
    const url = localStorage.getItem('gas_url');
    if (!url) return;
    try {
        const res = await fetch(url);
        const json = await res.json();
        document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.checked = json.checkedKeys.includes(cb.getAttribute('data-key'));
        });
    } catch (e) { console.error("同期失敗", e); }
}

// 起動
window.onload = initApp;
setInterval(syncStatus, 30000);