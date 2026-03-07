// 集金管理アプリ メインプログラム

// 1. データの初期表示
function renderApp() {
    const container = document.getElementById('list-container');
    container.innerHTML = '';
    
    // data.js の名簿データ（SHUKIN_DATA）を使用
    SHUKIN_DATA.forEach(record => {
        const div = document.createElement('div');
        div.className = 'list-item';
        div.innerHTML = `
            <input type="checkbox" data-key="${record.key}" onchange="toggleCheck(this, '${record.key}')">
            <span>${record.store} - ${record.name}</span>
        `;
        container.appendChild(div);
    });
    // 初期表示後にスプレッドシートから現在の状態を読み込む
    syncStatus();
}

// 2. チェック操作をスプレッドシートに送信
async function toggleCheck(el, key) {
    const url = localStorage.getItem('gas_url');
    if (!url) { alert('⚙設定からスプレッドシートURLを入力してください'); return; }

    const record = SHUKIN_DATA.find(r => r.key === key);
    const action = el.checked ? 'add' : 'remove';

    try {
        await fetch(url, {
            method: 'POST',
            body: JSON.stringify({ action, record: { ...record, checkedAt: new Date().toISOString() } })
        });
    } catch (err) {
        console.error("送信エラー:", err);
    }
}

// 3. スプレッドシートの状態を画面に反映（同期）
async function syncStatus() {
    const url = localStorage.getItem('gas_url');
    if (!url) return;

    try {
        const response = await fetch(url);
        const data = await response.json();
        
        // シートにあるキーのチェックを入れる
        document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.checked = data.checkedKeys.includes(cb.getAttribute('data-key'));
        });
    } catch (err) {
        console.error("同期エラー:", err);
    }
}

// 30秒ごとに自動同期
setInterval(syncStatus, 30000);

// 起動
renderApp();