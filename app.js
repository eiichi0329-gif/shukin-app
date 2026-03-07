// 集金管理アプリ メインプログラム（変数名修正版）

function renderApp() {
    const container = document.getElementById('list-container');
    const loadingMsg = document.querySelector('.読込中...');
    if (!container) return;

    // data.js の名簿データ（COLLECTION_DATA）が存在するか確認
    if (typeof COLLECTION_DATA === 'undefined') {
        container.innerHTML = '<div style="color:red; padding:20px;">エラー：名簿データ(COLLECTION_DATA)が見つかりません。</div>';
        return;
    }

    container.innerHTML = '';
    
    // 名簿を表示
    COLLECTION_DATA.forEach(record => {
        // キーがない場合は、店舗-名前-seqを組み合わせて作成
        const key = record.key || `${record.store}-${record.name}-${record.seq}`;
        
        const div = document.createElement('div');
        div.className = 'list-item';
        div.innerHTML = `
            <label style="display: flex; align-items: center; gap: 10px; padding: 12px; border-bottom: 1px solid #eee;">
                <input type="checkbox" data-key="${key}" onchange="toggleCheck(this, '${key}')" style="width: 24px; height: 24px;">
                <div>
                    <div style="font-weight: bold; font-size: 1.1em;">${record.name}</div>
                    <div style="font-size: 0.85em; color: #666;">${record.store} / ${record.address} / ¥${(record.amount || 0).toLocaleString()}</div>
                </div>
            </label>
        `;
        container.appendChild(div);
    });

    // リストが表示されたら「読込中」表示を消す
    if (loadingMsg) loadingMsg.style.display = 'none';
    
    syncStatus(); // 同期開始
}

async function toggleCheck(el, key) {
    const url = localStorage.getItem('gas_url');
    if (!url) { alert('⚙設定からURLを貼り付けてください'); return; }

    const record = COLLECTION_DATA.find(r => (r.key || `${r.store}-${r.name}-${r.seq}`) === key);
    const action = el.checked ? 'add' : 'remove';

    try {
        await fetch(url, {
            method: 'POST',
            body: JSON.stringify({ action, record: { ...record, key, checkedAt: new Date().toISOString() } })
        });
    } catch (err) {
        console.error("送信エラー:", err);
    }
}

async function syncStatus() {
    const url = localStorage.getItem('gas_url');
    if (!url) return;

    try {
        const response = await fetch(url);
        const data = await response.json();
        
        document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            const key = cb.getAttribute('data-key');
            cb.checked = data.checkedKeys.includes(key);
        });
    } catch (err) {
        console.error("同期エラー:", err);
    }
}

// 30秒ごとに自動同期
setInterval(syncStatus, 30000);

// 起動
document.addEventListener('DOMContentLoaded', renderApp);