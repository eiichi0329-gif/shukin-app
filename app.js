// 配達用アプリ v3

// ─── Google OAuth 認証 ────────────────────────────────────────────
const GOOGLE_CLIENT_ID = '774508511200-pgglmg87l7mjha2ktp4s48d30farec6p.apps.googleusercontent.com';
const AUTH_KEY = 'coll-auth-v1';

let currentUser = null; // { name, email, picture }

function loadAuth() {
    try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch { return null; }
}
function saveAuth(user) {
    localStorage.setItem(AUTH_KEY, JSON.stringify(user));
}
function clearAuth() {
    localStorage.removeItem(AUTH_KEY);
}

function decodeJwt(token) {
    try {
        const payload = token.split('.')[1];
        return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    } catch { return null; }
}

async function onGoogleSignIn(response) {
    const payload = decodeJwt(response.credential);
    if (!payload) {
        showLoginError('認証に失敗しました。再度お試しください。');
        return;
    }
    const user = { name: payload.name, email: payload.email, picture: payload.picture };

    // GAS が設定済みの場合は許可ユーザーを確認
    const gasUrl = (typeof window.GAS_URL === 'string' && window.GAS_URL)
        ? window.GAS_URL
        : (localStorage.getItem('gas_url') || '');

    if (gasUrl) {
        try {
            showLoginError('確認中...', false);
            const url = `${gasUrl}?action=checkAuth&email=${encodeURIComponent(user.email)}&t=${Date.now()}`;
            const res = await fetch(url);
            const json = await res.json();
            if (!json.allowed) {
                showLoginError(`${user.email} はアクセスが許可されていません。`);
                google.accounts.id.disableAutoSelect();
                return;
            }
        } catch {
            // GAS に繋がらない場合は通過させる（ネットワークエラー時も使えるよう）
        }
    }

    currentUser = user;
    saveAuth(currentUser);
    showApp();
}

function showLoginError(msg, isError = true) {
    const el = document.getElementById('login-error');
    el.textContent = msg;
    el.style.color = isError ? 'var(--red)' : 'var(--g500)';
    el.classList.remove('hidden');
}

function showApp() {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').classList.remove('hidden');

    // 今日の日付をヘッダーに表示
    const todayBadge = document.getElementById('today-badge');
    if (todayBadge) {
        const now = new Date();
        const wdays = ['日','月','火','水','木','金','土'];
        todayBadge.textContent = `${now.getMonth()+1}/${now.getDate()}（${wdays[now.getDay()]}）`;
    }

    // ヘッダーにユーザー情報を反映
    const avatar = document.getElementById('user-avatar');
    if (avatar && currentUser?.picture) {
        avatar.src = currentUser.picture;
        avatar.title = currentUser.name + ' (' + currentUser.email + ')';
    }

    startApp();
}

function logout() {
    if (!confirm('ログアウトしますか？')) return;
    clearAuth();
    google.accounts.id.disableAutoSelect();
    currentUser = null;
    document.getElementById('app').classList.add('hidden');
    document.getElementById('login-screen').style.display = '';
    // ログインボタンを再表示
    initGoogleSignIn();
}

function initGoogleSignIn() {
    google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: onGoogleSignIn,
        auto_select: false,
    });
    google.accounts.id.renderButton(
        document.getElementById('google-signin-btn'),
        { theme: 'outline', size: 'large', locale: 'ja', width: 280 }
    );
}

function initAuth() {
    const saved = loadAuth();
    if (saved) {
        currentUser = saved;
        showApp();
        return;
    }
    // 読込中メッセージを表示
    const btn = document.getElementById('google-signin-btn');
    btn.innerHTML = '<p style="color:#888;font-size:14px;margin-top:8px">読込中...</p>';

    // GIS ライブラリのロード待ち（最大12秒）
    let attempts = 0;
    const ready = () => {
        if (typeof google !== 'undefined' && google.accounts) {
            btn.innerHTML = '';
            initGoogleSignIn();
        } else if (attempts++ < 120) {
            setTimeout(ready, 100);
        } else {
            btn.innerHTML = '';
            showLoginError('Googleログインの読込に失敗しました。\nChrome などの最新ブラウザからアクセスしてください。');
        }
    };
    ready();
}

window.addEventListener('DOMContentLoaded', initAuth);

const LS_KEY             = 'coll-state-v3';
const BANK_KEY           = 'coll-bank-v1';
const BANK_FAILED_KEY    = 'coll-bank-failed-v1'; // 口振失敗（現金変更）した顧客キーの永続セット
const TRANSFER_KEY       = 'coll-transfer-v1';
const FILTER_KEY         = 'coll-filter-v1';
const AMOUNT_OVERRIDE_KEY = 'coll-amount-override-v1';
const DENOM_KEY           = 'coll-denom-v1';
const MANUAL_RECORDS_KEY  = 'coll-manual-v1';
const RECORD_OVERRIDE_KEY = 'coll-record-override-v1';
const DIRTY_GRACE_MS = 35000; // ローカル変更を守る猶予時間（ms）

// ─── 店舗デポ（出発・帰着地点） ─────────────────────────────────
const STORE_DEPOTS = {
    '下関店':   '下関市西大坪町12-9',
    '北九州店': '北九州市小倉北区大田町9-10',
    '宇部店':   '宇部市床波4-3-15-11',
    '宗像店':   '宗像市河東1055-5',
    '飯塚店':   '飯塚市川津369-3',
    '福岡東店': '福岡市東区和白3-27-50',
};

// ─── State ───────────────────────────────────────────────────────
let allData         = [];
let manualRecords   = [];   // 手動追加レコード
let checked         = {};   // key → { checkedAt, collectDate }
let bankState       = {};   // key → { status: 'completed'|'failed', updatedAt }
let bankFailedKeys  = new Set(); // 口振失敗として手動確定したキー（同期で絶対に上書きしない）
let transferState   = {};   // key → { date: 'YYYY-MM-DD', recordedAt: ISO }
let amountOverrides = {};   // key → number（管理画面で手修正した金額）
let recordOverrides = {};   // key → { route?, dataMonth?, name? }（行ダブルタップで修正）
let currentRouteMap = {};  // "store|name" → 現在のルート番号（月をまたいでコード変更に対応）
let filters = { store: '', month: '', route: '', payment: 'cash', search: '', uncollectedOnly: true };
let currentTab = 'delivery';
let expandedCell = null;  // { route, month } for admin detail
let deliveryData           = [];
let deliveryChecked        = {};
let deliveryRouteOverrides = {};
let currentDeliveryListData = []; // 所要時間計算用に renderDelivery() が更新する
let deliveryRouteOptimized  = null; // 最適ルート適用時の groupKey 順序配列（null = 未適用）
let deliveryCompactRoutes  = new Set(); // "store|route" keys currently in compact view
let deliveryArrivalTimes   = {}; // groupKey → "HH:MM" 推定到着時刻（所要時間計算後に設定）

const DELIVERY_CHECK_KEY          = 'coll-delivery-v1';
const DELIVERY_ROUTE_OVERRIDE_KEY = 'coll-delivery-route-v1';
const MSG_READ_KEY                = 'coll-msg-read-v1';

function loadMsgRead() { try { return new Set(JSON.parse(localStorage.getItem(MSG_READ_KEY) || '[]')); } catch { return new Set(); } }
function saveMsgRead(s) { localStorage.setItem(MSG_READ_KEY, JSON.stringify([...s])); }

function loadDeliveryChecked() {
    try {
        const dataGenAt = window.DATA_META?.generatedAt || '';
        const stored = JSON.parse(localStorage.getItem(DELIVERY_CHECK_KEY) || '{}');
        // _dataGeneratedAt が設定されていて現在の data.js と異なる場合はクリア（データ更新時にリセット）
        if (stored._dataGeneratedAt && stored._dataGeneratedAt !== dataGenAt) return {};
        const { _dataGeneratedAt, ...data } = stored;
        return data;
    } catch { return {}; }
}
function saveDeliveryChecked() {
    const dataGenAt = window.DATA_META?.generatedAt || '';
    localStorage.setItem(DELIVERY_CHECK_KEY, JSON.stringify({ _dataGeneratedAt: dataGenAt, ...deliveryChecked }));
}
function getDeliveryKey(r)      { return `${r.store}|${r.dataMonth}|${r.code}|${r.name}`; }

function loadDeliveryRouteOverrides() {
    try {
        const today     = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
        const dataGenAt = window.DATA_META?.generatedAt || '';
        const raw       = JSON.parse(localStorage.getItem(DELIVERY_ROUTE_OVERRIDE_KEY) || '{}');
        // 当日分 かつ 現在の data.js と同じ生成タイミングのもののみ有効
        const clean = {};
        Object.entries(raw).forEach(([k, v]) => {
            if (v.date === today && v.dataGeneratedAt === dataGenAt) clean[k] = v;
        });
        return clean;
    } catch { return {}; }
}
function saveDeliveryRouteOverrides() {
    localStorage.setItem(DELIVERY_ROUTE_OVERRIDE_KEY, JSON.stringify(deliveryRouteOverrides));
    const url = getGasUrl();
    if (!url) return;
    // no-cors ではGASのdoPostが動作しないため通常fetchを使用
    const body = JSON.stringify({ action: 'setRouteOverrides', overrides: deliveryRouteOverrides });
    fetch(url, { method: 'POST', body }).catch(() => {
        const q = loadRetryQueue();
        q.push({ url, body, savedAt: Date.now() });
        saveRetryQueue(q);
    });
}

// 口振一括チェックモード
let bulkMode               = false;
let bulkAffectedKeys       = new Set(); // 一括チェックで対象になったキー
let bulkUncheckedKeys      = new Set(); // ユーザーが手動で外したキー
let bulkPreviouslyCompleted = new Set(); // 一括モード開始時点で完了済みだったキー

// 金種確認ダイアログ用
let currentDenomDate  = null;
let currentDenomRoute = null;
const DENOMINATIONS = [
    { value: 10000, label: '10,000円札' },
    { value:  5000, label:  '5,000円札' },
    { value:  1000, label:  '1,000円札' },
    { value:   500, label:    '500円玉' },
    { value:   100, label:    '100円玉' },
    { value:    50, label:     '50円玉' },
    { value:    10, label:     '10円玉' },
    { value:     5, label:      '5円玉' },
    { value:     1, label:      '1円玉' },
];

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

// ─── Bank Failed Keys（口振失敗の永続セット） ───────────────────
function loadBankFailedKeys() {
    try { return new Set(JSON.parse(localStorage.getItem(BANK_FAILED_KEY) || '[]')); } catch { return new Set(); }
}
function saveBankFailedKeys() {
    localStorage.setItem(BANK_FAILED_KEY, JSON.stringify([...bankFailedKeys]));
}
function markBankFailed(key) {
    bankState[key] = { status: 'failed', updatedAt: new Date().toISOString() };
    bankFailedKeys.add(key);
    saveBankFailedKeys();
    saveBankState();
    const _bUrl = getGasUrl();
    if (_bUrl) postToGas(_bUrl, { action: 'saveBankFailed', key, savedAt: new Date().toISOString() });
}
function unmarkBankFailed(key) {
    bankFailedKeys.delete(key);
    delete bankState[key];
    saveBankFailedKeys();
    saveBankState();
    const _bUrl = getGasUrl();
    if (_bUrl) postToGas(_bUrl, { action: 'removeBankFailed', key });
}

// ─── Amount Override State ────────────────────────────────────────
function loadAmountOverrides() {
    try { return JSON.parse(localStorage.getItem(AMOUNT_OVERRIDE_KEY) || '{}'); } catch { return {}; }
}
function saveAmountOverrides() {
    localStorage.setItem(AMOUNT_OVERRIDE_KEY, JSON.stringify(amountOverrides));
}

// ─── Record Override State ─────────────────────────────────────────
function loadRecordOverrides() {
    try { return JSON.parse(localStorage.getItem(RECORD_OVERRIDE_KEY) || '{}'); } catch { return {}; }
}
function saveRecordOverrides() {
    localStorage.setItem(RECORD_OVERRIDE_KEY, JSON.stringify(recordOverrides));
}

// ─── Denom Storage ────────────────────────────────────────────────
function loadDenomStorage() {
    try {
        const stored = JSON.parse(localStorage.getItem(DENOM_KEY) || '{}');
        const { _dataGeneratedAt, ...data } = stored;
        return data;
    } catch { return {}; }
}
function saveDenomStorage(data) {
    localStorage.setItem(DENOM_KEY, JSON.stringify(data));
}
function calcDenomTotal(counts) {
    return DENOMINATIONS.reduce((sum, d) => sum + d.value * (counts[d.value] || 0), 0);
}
function effectiveAmount(key, record) {
    return amountOverrides[key] !== undefined ? amountOverrides[key] : (record.amount || 0);
}
function effectiveRoute(key, r) { return recordOverrides[key]?.route ?? currentRouteMap[r.store + '|' + r.name] ?? r.route; }

// Excelの顧客管理表（COLLECTION_DATA）の直近月のルートで「店舗|名前 → 現在ルート」マップを構築
// 月をまたいで配達番号・ルートが変わっても、最新月のルートに全レコードを紐づける
function buildCurrentRouteMap() {
    const map = {};
    allData.forEach(r => {
        const k = r.store + '|' + r.name;
        if (!map[k] || r.dataMonth > map[k].month) {
            map[k] = { route: r.route, month: r.dataMonth };
        }
    });
    const result = {};
    for (const k of Object.keys(map)) result[k] = map[k].route;
    return result;
}
function effectiveMonth(key, r) { return recordOverrides[key]?.dataMonth ?? r.dataMonth; }
function effectiveName(key, r)  { return recordOverrides[key]?.name      ?? r.name; }

// 集金済み金額との差分（追加注文があった場合は差額を返す）
function displayAmount(key, r) {
    const base         = effectiveAmount(key, r);
    const collectedAmt = checked[key]?.collectedAmount || 0;
    // リセット運用：集金後にExcelが0になった場合は差分計算せず全額表示
    if (checked[key]?.cycleReset) return base;
    if (collectedAmt > 0 && base > collectedAmt) return base - collectedAmt;
    return base;
}

// Excel金額 === 集金済み金額 → 完全集金済み
// Excel金額が変わった（新規注文含む）場合は未集金として表示
function isFullyCollected(key, r) {
    if (!checked[key]) return false;
    const collectedAmt = checked[key].collectedAmount || 0;
    if (collectedAmt === 0) return true; // 旧データ互換：金額未記録は集金済みとみなす
    // リセット運用：集金後にExcelが0にリセットされた状態は集金済みとみなす
    if (checked[key].cycleReset && effectiveAmount(key, r) === 0) return true;
    return effectiveAmount(key, r) === collectedAmt;
}

// 集金後にExcelが0にリセットされた場合を検出し cycleReset フラグを立てる
// （リセット運用：集金→Excel0→新注文の流れで差分計算を無効化するため）
function updateCycleReset() {
    let changed = false;
    Object.keys(checked).forEach(key => {
        if (checked[key].cycleReset) return; // 既にフラグ済み
        const record = allData.find(r => getKey(r) === key);
        if (!record) return;
        if (effectiveAmount(key, record) === 0) {
            checked[key].cycleReset = true;
            changed = true;
        }
    });
    if (changed) saveChecked();
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
    if (bankState[key]?.status === 'failed' || bankFailedKeys.has(key)) return 'cash';
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

// ─── 顧客画像 ─────────────────────────────────────────────────────
let _currentImageKey = null;

function openImageDialog(groupKey) {
    const dRec = deliveryData.find(r =>
        `${r.store}|${r.dataMonth}|${r.name}|${r.address}` === groupKey
    );
    if (!dRec) return;

    _currentImageKey = `${dRec.store}|${dRec.name}`;
    document.getElementById('image-dialog-title').textContent = `${dRec.name} の画像`;
    document.getElementById('image-dialog-list').innerHTML = '<div class="image-loading">読み込み中...</div>';
    document.getElementById('image-dialog').showModal();
    fetchCustomerImages(_currentImageKey);
}

function closeImageDialog() {
    document.getElementById('image-dialog').close();
    _currentImageKey = null;
}

async function fetchCustomerImages(imageKey) {
    const url   = getGasUrl();
    const listEl = document.getElementById('image-dialog-list');
    if (!url) {
        listEl.innerHTML = '<div class="image-empty">GAS URLが設定されていません</div>';
        return;
    }
    try {
        const res  = await fetch(`${url}?action=getImages&imageKey=${encodeURIComponent(imageKey)}&t=${Date.now()}`);
        const json = await res.json();
        if (!json.ok) throw new Error(json.error || 'エラー');
        renderImageList(imageKey, json.images || []);
    } catch {
        listEl.innerHTML = '<div class="image-error">画像の取得に失敗しました</div>';
    }
}

function renderImageList(imageKey, images) {
    const listEl = document.getElementById('image-dialog-list');
    if (images.length === 0) {
        listEl.innerHTML = '<div class="image-empty">まだ画像はありません</div>';
        return;
    }
    listEl.innerHTML = images.map(img => {
        const thumbUrl = `https://drive.google.com/thumbnail?id=${encodeURIComponent(img.fileId)}&sz=w300`;
        const fullUrl  = `https://drive.google.com/file/d/${encodeURIComponent(img.fileId)}/view`;
        const dateStr  = img.uploadedAt
            ? new Date(img.uploadedAt).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })
            : '';
        const byStr = [img.uploadedBy, dateStr].filter(Boolean).join(' ');
        return `<div class="image-thumb-wrap">
            <a href="${escHtml(fullUrl)}" target="_blank" rel="noopener">
                <img class="image-thumb" src="${escHtml(thumbUrl)}" alt="顧客画像" loading="lazy">
            </a>
            ${byStr ? `<div class="image-meta">${escHtml(byStr)}</div>` : ''}
            <button class="btn btn-danger btn-sm btn-image-delete" data-file-id="${escHtml(img.fileId)}">削除</button>
        </div>`;
    }).join('');

    listEl.querySelectorAll('.btn-image-delete').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!confirm('この画像を削除しますか？')) return;
            deleteCustomerImage(btn.dataset.fileId);
        });
    });
}

function deleteCustomerImage(fileId) {
    const url = getGasUrl();
    if (url) postToGas(url, { action: 'deleteImage', imageKey: _currentImageKey, fileId });

    // 楽観的更新: 即座に UI から除去
    const wrap = document.querySelector(`.btn-image-delete[data-file-id="${CSS.escape(fileId)}"]`)
        ?.closest('.image-thumb-wrap');
    if (wrap) wrap.remove();
    const listEl = document.getElementById('image-dialog-list');
    if (listEl && !listEl.querySelector('.image-thumb-wrap')) {
        listEl.innerHTML = '<div class="image-empty">まだ画像はありません</div>';
    }
}

async function onImageFileSelected(input) {
    const file = input.files[0];
    input.value = '';
    if (!file || !_currentImageKey) return;

    const url    = getGasUrl();
    const listEl = document.getElementById('image-dialog-list');
    if (!url) { showToast('GAS URLが設定されていません', 'error'); return; }

    const prevHTML = listEl.innerHTML;
    listEl.innerHTML = '<div class="image-loading">アップロード中...</div>';

    try {
        const base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload  = e => resolve(e.target.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });

        const res  = await fetch(url, {
            method: 'POST',
            body: JSON.stringify({
                action:     'saveImage',
                imageKey:   _currentImageKey,
                base64,
                mimeType:   file.type || 'image/jpeg',
                uploadedBy: currentUser?.name || '',
                uploadedAt: new Date().toISOString(),
            }),
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.error || 'アップロード失敗');

        showToast('画像をアップロードしました', 'success');
        fetchCustomerImages(_currentImageKey);
    } catch (err) {
        listEl.innerHTML = prevHTML;
        showToast('画像のアップロードに失敗しました', 'error');
        console.error('[画像アップロード]', err);
    }
}

// ─── GAS リトライキュー ───────────────────────────────────────────
const RETRY_QUEUE_KEY    = 'coll-retry-queue-v1';
const RETRY_MAX_AGE_MS   = 24 * 60 * 60 * 1000; // 24時間以上古いものは破棄

function loadRetryQueue() {
    try { return JSON.parse(localStorage.getItem(RETRY_QUEUE_KEY) || '[]'); } catch { return []; }
}
function saveRetryQueue(q) {
    localStorage.setItem(RETRY_QUEUE_KEY, JSON.stringify(q));
}

async function flushRetryQueue() {
    const url = getGasUrl();
    if (!url || !navigator.onLine) return;
    const now = Date.now();
    const q = loadRetryQueue().filter(item => now - item.savedAt < RETRY_MAX_AGE_MS);
    if (!q.length) { saveRetryQueue([]); return; }
    const failed = [];
    for (const item of q) {
        try {
            await fetch(item.url, { method: 'POST', mode: 'no-cors', body: item.body });
        } catch {
            failed.push(item);
        }
    }
    saveRetryQueue(failed);
    const sent = q.length - failed.length;
    if (sent > 0) console.log(`[GASリトライ] ${sent}件 再送信成功`);
}

// GAS への POST 送信（fetch 固定、失敗時はリトライキューに保存）
function postToGas(url, data) {
    const body = JSON.stringify(data);
    fetch(url, { method: 'POST', mode: 'no-cors', body })
        .catch(() => {
            const q = loadRetryQueue();
            q.push({ url, body, savedAt: Date.now() });
            saveRetryQueue(q);
        });
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

        if (filters.store   && r.store                                !== filters.store)   return false;
        if (filters.month === '__action_required__') {
            // 要対応：今月の2か月前以前の未集金を表示
            const now = new Date();
            const thresholdYear  = now.getMonth() < 2
                ? now.getFullYear() - 1
                : now.getFullYear();
            const thresholdMonth = ((now.getMonth() - 2 + 12) % 12) + 1;
            const threshold = `${thresholdYear}-${String(thresholdMonth).padStart(2, '0')}`;
            if (r.dataMonth > threshold) return false;
        } else if (filters.month && r.dataMonth !== filters.month) {
            return false;
        }
        if (filters.route   && String(effectiveRoute(key, r))       !== filters.route)   return false;
        if (filters.payment && effPayment      !== filters.payment) return false;
        if ((r.amount || 0) === 0)                                   return false;

        // 要対応モードでは常に未集金のみ表示（uncollectedOnly トグルに関わらず）
        const isActionRequired = filters.month === '__action_required__';
        const effectiveUncollectedOnly = filters.uncollectedOnly || isActionRequired;

        // 口振完了：未集金フィルター ON のとき非表示（一括チェックモード中は取消のため表示）
        if (!bulkMode && bankState[key]?.status === 'completed' && effectiveUncollectedOnly) return false;

        // 振込入金済み：未集金フィルター ON のとき非表示
        if (transferState[key] && effectiveUncollectedOnly) return false;

        if (checked[key]) {
            if (isFullyCollected(key, r)) {
                if (isActionRequired) {
                    // 要対応：集金済みは日付に関わらず非表示
                    return false;
                }
                // 完全集金済み：当日チェックしたものは終日リストに残す
                if (filters.uncollectedOnly) {
                    const state      = checked[key];
                    const checkedDay = new Date(state.checkedAt).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
                    const today      = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
                    if (checkedDay !== today) return false;
                }
            }
            // 追加注文あり（差額が残っている）→ 未集金として表示
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
        '<option value="">全月</option>' +
        '<option value="__action_required__">要対応</option>' +
        months.map(m => `<option value="${m}">${m}</option>`).join('');

    document.getElementById('filter-route').innerHTML =
        '<option value="">全ルート</option>' + routes.map(r => `<option value="${r}">R${r}</option>`).join('');
}

// ─── Render Header ───────────────────────────────────────────────
function renderHeader(data) {
    const badge = document.getElementById('month-badge');
    if (badge) {
        if (filters.month === '__action_required__') {
            badge.textContent = '要対応';
        } else if (filters.month) {
            badge.textContent = filters.month;
        } else {
            const months = [...new Set(allData.map(r => r.dataMonth))].sort();
            badge.textContent = months.length === 1 ? months[0] : months.join(' / ');
        }
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
        const isChecked      = !!checked[key] && isFullyCollected(key, r);
        const state          = checked[key] || {};
        const date           = state.collectDate || '';
        const effPayment     = effectivePaymentType(r);
        const isBankCustomer  = effPayment === 'bank';
        const isBankCompleted = isBankCustomer && bankState[key]?.status === 'completed';
        const isBankFailed    = bankState[key]?.status === 'failed';
        const isTransferred   = !!transferState[key];

        let payBadge;
        if (isBankFailed) {
            payBadge = `<span class="pay-badge pay-bank-failed" data-key="${key}" style="cursor:pointer" title="タップで口振失敗を解除">口振失敗</span>`;
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

        // 現金・未集金（口振でも振込でもない）なら金額セルを一部集金タップ対応に
        const canPartial = !isBankCustomer && !isTransferred;
        const prevCollected = state.collectedAmount || 0;
        const isPartiallyCollected = prevCollected > 0 && !isFullyCollected(key, r);
        const amountCellClass = canPartial ? 'col-amount col-amount-tap' : 'col-amount';
        const partialAttr = canPartial ? `data-partial-key="${key}"` : '';
        const partialBadge = isPartiallyCollected
            ? `<span class="partial-badge">一部済¥${fmt(prevCollected)}</span>`
            : '';

        html += `<tr class="${rowClass}" data-key="${key}" title="ダブルタップで修正">
            <td class="col-check">${checkboxHtml}</td>
            <td class="col-route">R${effectiveRoute(key, r)}</td>
            <td class="col-month">${effectiveMonth(key, r).slice(5)}月</td>
            <td class="col-name"><div class="name-inner">${payBadge}${effectiveName(key, r)}</div></td>
            <td class="col-addr">${r.address || ''}</td>
            <td class="${amountCellClass}" ${partialAttr}>¥${fmt(displayAmount(key, r))}${partialBadge}</td>
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

    // イベント登録（口振失敗バッジ → タップで解除）
    tbody.querySelectorAll('.pay-bank-failed[data-key]').forEach(badge => {
        badge.addEventListener('click', () => {
            const key = badge.dataset.key;
            if (!confirm('口振失敗を解除して、口座振替（未処理）に戻しますか？')) return;
            unmarkBankFailed(key);
            renderTable();
        });
    });

    // イベント登録（金額セル → 一部集金ダイアログ）
    tbody.querySelectorAll('td.col-amount-tap[data-partial-key]').forEach(cell => {
        cell.addEventListener('click', () => openPartialCollect(cell.dataset.partialKey));
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

    // イベント登録（ダブルタップ／ダブルクリックで行編集）
    let _lastTapKey = null, _lastTapTime = 0;
    tbody.querySelectorAll('tr[data-key]').forEach(row => {
        // PC: dblclick
        row.addEventListener('dblclick', e => {
            if (e.target.closest('input, button, td.col-check, td.col-date, td.col-transfer')) return;
            openRowEdit(row.dataset.key);
        });
        // スマホ: 400ms以内の2タップ
        row.addEventListener('click', e => {
            if (e.target.closest('input, button, td.col-check, td.col-date, td.col-transfer')) return;
            const now = Date.now();
            if (_lastTapKey === row.dataset.key && now - _lastTapTime < 400) {
                openRowEdit(row.dataset.key);
                _lastTapKey = null;
            } else {
                _lastTapKey = row.dataset.key;
                _lastTapTime = now;
            }
        });
    });

    // 一括チェックモード中はチェック状態を復元
    restoreBulkVisual();

    renderHeader(data);
}

// ─── Toast 通知 ──────────────────────────────────────────────────
function showToast(msg, type = 'success') {
    let el = document.getElementById('app-toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'app-toast';
        document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = `app-toast app-toast-${type} app-toast-show`;
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('app-toast-show'), 2000);
}

// ─── 一部集金 ────────────────────────────────────────────────────
function openPartialCollect(key) {
    const record    = allData.find(r => getKey(r) === key);
    if (!record) return;

    const fullAmt      = effectiveAmount(key, record);
    const prevCollected = checked[key]?.collectedAmount || 0;
    const remaining    = displayAmount(key, record); // fullAmt - prevCollected（または fullAmt）

    document.getElementById('partial-collect-key').value = key;

    const infoEl = document.getElementById('partial-collect-info');
    infoEl.innerHTML = `
        <div class="partial-info-name">${escHtml(effectiveName(key, record))}</div>
        <div class="partial-info-row"><span>請求額</span><strong>¥${fmt(fullAmt)}</strong></div>
        ${prevCollected > 0 ? `<div class="partial-info-row"><span>既集金</span><strong>¥${fmt(prevCollected)}</strong></div>` : ''}
        <div class="partial-info-row partial-info-remaining"><span>未集金（残）</span><strong>¥${fmt(remaining)}</strong></div>
    `;

    const input = document.getElementById('partial-collect-input');
    input.value = remaining;
    input.max   = remaining;

    document.getElementById('partial-collect-dialog').showModal();
    setTimeout(() => { input.select(); }, 80);
}

function confirmPartialCollect() {
    const key    = document.getElementById('partial-collect-key').value;
    const record = allData.find(r => getKey(r) === key);
    if (!record) return;

    const entered = parseInt(document.getElementById('partial-collect-input').value) || 0;
    if (entered <= 0) { alert('集金額を入力してください'); return; }

    const fullAmt      = effectiveAmount(key, record);
    const prevCollected = checked[key]?.collectedAmount || 0;
    const remaining    = fullAmt - prevCollected;

    if (entered > remaining) {
        alert(`集金額（¥${fmt(entered)}）が残額（¥${fmt(remaining)}）を超えています`);
        return;
    }

    const today       = new Date();
    const jstDate     = today.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
    const newCollected = prevCollected + entered;
    const isFullNow    = newCollected >= fullAmt;
    const gasKey       = isFullNow && prevCollected === 0
        ? key                           // 初回で全額 → 通常キー
        : `${key}|${Date.now()}`;       // 一部または再集金 → 別行

    const collectDate = checked[key]?.collectDate || jstDate;

    checked[key] = {
        checkedAt:       today.toISOString(),
        collectDate,
        collectedAmount: newCollected,
        cycleReset:      false,
        gasKey,
        routeOverride:   checked[key]?.routeOverride || null,
    };
    saveChecked();
    dirtyKeys.set(key, Date.now());

    const url = getGasUrl();
    if (url) {
        postToGas(url, {
            action:      'add',
            record:      { ...record, key: gasKey, amount: entered },
            collectDate,
        });
    }

    document.getElementById('partial-collect-dialog').close();
    renderTable();

    if (isFullNow) {
        showToast('集金完了 ✓', 'success');
    } else {
        showToast(`¥${fmt(entered)} 集金。残 ¥${fmt(fullAmt - newCollected)}`, 'success');
    }
}

// ─── Check Action ────────────────────────────────────────────────
function onCheck(key, isChecked, routeOverride = null) {
    let gasKey    = key;
    let incAmount = null;

    if (!isChecked) {
        if (!confirm('チェックを解除しますか？')) {
            const cb = document.querySelector(`input[data-key="${key}"]`);
            if (cb) cb.checked = true;
            return;
        }
        gasKey = checked[key]?.gasKey || key; // 削除前に保存したキーで GAS 行を消す
        delete checked[key];
    } else {
        const today          = new Date();
        const jstDate        = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
        const record         = allData.find(r => getKey(r) === key);
        const isReCollection = !!(checked[key]?.collectedAmount); // 再集金かどうか
        incAmount = isReCollection ? displayAmount(key, record) : effectiveAmount(key, record);
        gasKey    = isReCollection ? `${key}|${Date.now()}` : key; // 再集金は別キーで新規行

        checked[key] = {
            checkedAt:       today.toISOString(),
            collectDate:     isReCollection ? jstDate : ((checked[key] || {}).collectDate || jstDate),
            collectedAmount: effectiveAmount(key, record), // 集金時点のExcel金額を記録
            cycleReset:      false, // 集金時点でリセットフラグをクリア
            gasKey,
            routeOverride:   routeOverride || null, // 配達表でルート変更済みの場合に保存
            // 管理画面の履歴表示用スナップショット（data.js が更新されても記録が消えないよう保持）
            snapshot: record ? {
                name:      record.name,
                amount:    record.amount,
                route:     routeOverride || record.route, // 変更後ルートをスナップショットにも反映
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

    const _toastRec = allData.find(r => getKey(r) === key);
    if (isChecked) showToast(`✓ ${_toastRec?.name || ''} — 集金済みにしました`, 'success');

    // GAS 送信
    const url = getGasUrl();
    if (url) {
        const record     = allData.find(r => getKey(r) === key);
        const state      = checked[key] || {};
        const sendAmount = incAmount !== null ? incAmount : effectiveAmount(key, record);
        postToGas(url, {
            action:      isChecked ? 'add' : 'remove',
            record:      { ...record, key: gasKey, amount: sendAmount, checkedAt: state.checkedAt || '',
                           route: state.routeOverride || record?.route }, // 変更後ルートをスプレッドシートにも反映
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
        markBankFailed(key); // bankState['failed'] + bankFailedKeys に永続保存

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

// ─── 口振失敗 一括登録 ───────────────────────────────────────────
function bulkMarkBankFailed() {
    // 現在の月・店舗フィルターを適用し、未処理（完了でも失敗でもない）の口振顧客を取得
    const targets = allData.filter(r => {
        if (r.paymentType !== 'bank') return false;
        if ((r.amount || 0) === 0) return false;
        const key = getKey(r);
        if (bankState[key]?.status === 'completed') return false;
        if (bankState[key]?.status === 'failed' || bankFailedKeys.has(key)) return false;
        if (filters.store && r.store !== filters.store) return false;
        if (filters.month && filters.month !== '__action_required__' && r.dataMonth !== filters.month) return false;
        return true;
    });

    if (targets.length === 0) {
        alert('未処理の口座振替対象者はいません。');
        return;
    }

    const monthLabel = filters.month ? filters.month : '全月';
    const storeLabel = filters.store ? filters.store : '全店舗';
    if (!confirm(`${storeLabel}・${monthLabel} の未処理口座振替 ${targets.length}件 を\n全て「口振失敗（現金集金へ変更）」に登録しますか？`)) return;

    targets.forEach(r => markBankFailed(getKey(r)));
    renderTable();
    showToast(`${targets.length}件を口振失敗に登録しました`, 'success');
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
        unmarkBankFailed(key); // 完了扱いに戻す場合は失敗セットから除外
    });
    failed.forEach(key => {
        bankState[key] = { status: 'failed', updatedAt: now.toISOString() };
        bankFailedKeys.add(key); // 永続セットに追加
    });
    revert.forEach(key => {
        delete bankState[key]; // 完了状態を削除して未処理に戻す
        unmarkBankFailed(key);
    });

    saveBankFailedKeys();
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

// ─── Manual Record Addition ──────────────────────────────────────
function loadManualRecords() {
    try { return JSON.parse(localStorage.getItem(MANUAL_RECORDS_KEY) || '[]'); } catch { return []; }
}
function saveManualRecords() {
    localStorage.setItem(MANUAL_RECORDS_KEY, JSON.stringify(manualRecords));
}

function openManualAdd() {
    const stores = (window.DATA_META?.stores) || [...new Set(allData.filter(r => !r.isManual).map(r => r.store))];
    const now = new Date();
    const months = [];
    for (let i = 0; i < 24; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }

    document.getElementById('manual-store').innerHTML =
        stores.map(s => `<option value="${s}">${s}</option>`).join('');
    document.getElementById('manual-month').innerHTML =
        months.map(m => `<option value="${m}">${m}</option>`).join('');

    renderManualList();
    document.getElementById('manual-add-dialog').showModal();
}

function closeManualAdd() {
    document.getElementById('manual-add-dialog').close();
}

function addManualRecord() {
    const store       = document.getElementById('manual-store').value;
    const dataMonth   = document.getElementById('manual-month').value;
    const route       = parseInt(document.getElementById('manual-route').value) || 0;
    const name        = document.getElementById('manual-name').value.trim();
    const address     = document.getElementById('manual-address').value.trim();
    const amount      = parseInt(document.getElementById('manual-amount').value) || 0;
    const paymentType = document.getElementById('manual-payment').value;

    if (!name)    { alert('名前を入力してください');   return; }
    if (amount <= 0) { alert('金額を入力してください（1円以上）'); return; }

    const record = {
        id: 'manual_' + Date.now(),
        store, route, name, address, amount, dataMonth, paymentType,
        code: 0, seq: 9999, isManual: true, sourceFiles: ['手動追加']
    };

    manualRecords.push(record);
    saveManualRecords();
    allData.push(record);

    const _mUrl = getGasUrl();
    if (_mUrl) postToGas(_mUrl, { action: 'saveManual', record, savedAt: new Date().toISOString() });

    // フォームリセット
    document.getElementById('manual-name').value    = '';
    document.getElementById('manual-address').value = '';
    document.getElementById('manual-amount').value  = '';
    document.getElementById('manual-route').value   = '';

    renderManualList();
    renderFilters();
    renderTable();
}

function deleteManualRecord(id) {
    if (!confirm('この手動追加レコードを削除しますか？\nチェック状態も削除されます。')) return;
    const rec = manualRecords.find(r => r.id === id);
    manualRecords = manualRecords.filter(r => r.id !== id);
    saveManualRecords();
    allData = allData.filter(r => r.id !== id);
    if (rec) {
        const key = getKey(rec);
        delete checked[key];
        saveChecked();
    }

    const _mUrl = getGasUrl();
    if (_mUrl) postToGas(_mUrl, { action: 'removeManual', id });

    renderManualList();
    renderFilters();
    renderTable();
}

function renderManualList() {
    const list = document.getElementById('manual-list');
    if (!manualRecords.length) {
        list.innerHTML = '<p class="manual-empty">手動追加レコードはありません</p>';
        return;
    }
    list.innerHTML = manualRecords.map(r => `
        <div class="manual-record-item">
            <span class="manual-record-info">${r.store}／${r.dataMonth}／R${r.route}／${r.name}／¥${fmt(r.amount)}</span>
            <button class="btn btn-danger manual-delete-btn" onclick="deleteManualRecord('${r.id}')">削除</button>
        </div>
    `).join('');
}

// ─── Row Edit ────────────────────────────────────────────────────
function openRowEdit(key) {
    const record = allData.find(r => getKey(r) === key);
    if (!record) return;

    const now = new Date();
    const months = [];
    for (let i = 0; i < 24; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }

    const routes = [...new Set(allData.map(r => r.route))].sort((a, b) => a - b);

    document.getElementById('row-edit-key').value = key;
    document.getElementById('row-edit-month').innerHTML =
        months.map(m => `<option value="${m}">${m}</option>`).join('');
    document.getElementById('row-edit-month').value  = effectiveMonth(key, record);
    document.getElementById('row-edit-route').innerHTML =
        routes.map(r => `<option value="${r}">R${r}</option>`).join('');
    document.getElementById('row-edit-route').value  = effectiveRoute(key, record);
    document.getElementById('row-edit-name').value   = effectiveName(key, record);
    document.getElementById('row-edit-amount').value = effectiveAmount(key, record);

    const dlg = document.getElementById('row-edit-dialog');
    dlg.showModal();
    setTimeout(() => {
        const focused = dlg.querySelector('select, input');
        if (focused) { focused.blur(); focused.setAttribute('tabindex', '-1'); }
        document.getElementById('row-edit-route')?.focus();
    }, 50);
}

function closeRowEdit() {
    const dlg = document.getElementById('row-edit-dialog');
    dlg.querySelectorAll('[tabindex="-1"]').forEach(el => el.removeAttribute('tabindex'));
    dlg.close();
}

function saveRowEdit() {
    const key       = document.getElementById('row-edit-key').value;
    const route     = parseInt(document.getElementById('row-edit-route').value) || 0;
    const dataMonth = document.getElementById('row-edit-month').value;
    const name      = document.getElementById('row-edit-name').value.trim();
    const amount    = parseInt(document.getElementById('row-edit-amount').value) || 0;

    if (!name)       { alert('名前を入力してください'); return; }
    if (amount <= 0) { alert('金額を入力してください（1円以上）'); return; }

    const record = allData.find(r => getKey(r) === key);
    if (!record) { closeRowEdit(); return; }

    if (record.isManual) {
        // 手動追加レコード：直接更新。keyが変わる場合は各state を移行
        const newKey = `${record.store}|${dataMonth}|${record.code}|${name}`;
        if (newKey !== key) {
            if (checked[key])                      { checked[newKey] = checked[key]; delete checked[key]; }
            if (amountOverrides[key] !== undefined) { amountOverrides[newKey] = amountOverrides[key]; delete amountOverrides[key]; }
            if (transferState[key])                { transferState[newKey] = transferState[key]; delete transferState[key]; }
            if (bankState[key])                    { bankState[newKey] = bankState[key]; delete bankState[key]; }
            if (recordOverrides[key])              { recordOverrides[newKey] = recordOverrides[key]; delete recordOverrides[key]; }
            saveChecked(); saveTransferState(); saveBankState(); saveRecordOverrides();
        }
        record.route = route; record.dataMonth = dataMonth; record.name = name; record.amount = amount;
        // amountOverrides を更新（amount直書きのため上書き不要だが念のため削除）
        if (amountOverrides[newKey] !== undefined) { delete amountOverrides[newKey]; }
        saveManualRecords(); saveAmountOverrides();
    } else {
        // 通常レコード：オーバーライドで管理
        if (!recordOverrides[key]) recordOverrides[key] = {};
        recordOverrides[key].route     = route;
        recordOverrides[key].dataMonth = dataMonth;
        recordOverrides[key].name      = name;
        amountOverrides[key] = amount;
        saveRecordOverrides(); saveAmountOverrides();
    }

    closeRowEdit();
    renderFilters();
    renderTable();
    if (!document.getElementById('tab-admin').classList.contains('hidden')) renderAdmin();
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
    if (!confirm('全てのチェック（現金・口座振替・振込）をリセットしますか？\n手動追加レコードも削除されます。\nこの操作は元に戻せません。')) return;
    checked       = {};
    bankState     = {};
    bankFailedKeys.clear();
    transferState = {};
    manualRecords = [];
    saveChecked();
    saveBankState();
    saveBankFailedKeys();
    saveTransferState();
    saveManualRecords();
    allData         = [...window.COLLECTION_DATA];
    currentRouteMap = buildCurrentRouteMap();
    dirtyKeys.clear();
    renderTable();

    // GAS のスプレッドシートも全件削除
    const url = getGasUrl();
    if (url) postToGas(url, { action: 'resetAll' });
}

// ─── Tab Switch ──────────────────────────────────────────────────
function switchTab(tab) {
    currentTab = tab;
    document.getElementById('tab-delivery').classList.toggle('hidden', tab !== 'delivery');
    document.getElementById('tab-list').classList.toggle('hidden', tab !== 'list');
    document.getElementById('tab-admin').classList.toggle('hidden', tab !== 'admin');
    const navDelivery = document.getElementById('nav-delivery');
    if (navDelivery) navDelivery.classList.toggle('active', tab === 'delivery');
    document.getElementById('nav-list').classList.toggle('active', tab === 'list');
    document.getElementById('nav-admin').classList.toggle('active', tab === 'admin');

    // 配達タブ専用：不要フィルターを隠してサマリーを表示
    document.querySelector('.controls-bar').classList.toggle('delivery-mode', tab === 'delivery');
    document.getElementById('delivery-summary').classList.toggle('hidden', tab !== 'delivery');

    if (tab === 'admin')    renderAdmin();
    if (tab === 'delivery') {
        renderDelivery();
        const doneCards = document.querySelectorAll('#delivery-list .delivery-card-done');
        if (doneCards.length > 0) {
            doneCards[doneCards.length - 1].scrollIntoView({ block: 'center' });
        }
    }
}

// ─── 所要時間計算 ────────────────────────────────────────────────
async function calcDeliveryTime() {
    const url = getGasUrl();
    if (!url) { alert('GAS URLが設定されていません'); return; }

    const midStopsData = currentDeliveryListData.filter(m => m.address); // groupKey 保持
    const midStops = midStopsData.map(m => {
        const isNewStop = m.countLabel === '新規' || m.countLabel === '再注文';
        return {
            address: m.address,
            name:    m.name,
            isNew:   isNewStop,
            label:   isNewStop ? m.countLabel : '',
        };
    });

    if (midStops.length < 2) {
        alert('住所が2件以上必要です');
        return;
    }

    // 店舗デポ（出発・帰着）を先頭・末尾に追加
    const store     = currentDeliveryListData[0]?.store || filters.store || '';
    const depotAddr = STORE_DEPOTS[store];
    const hasDepot  = !!depotAddr;
    const stops     = hasDepot
        ? [
            { address: depotAddr, name: store, isNew: false, isDepot: true },
            ...midStops,
            { address: depotAddr, name: store, isNew: false, isDepot: true },
          ]
        : midStops;

    const btn      = document.getElementById('btn-calc-time');
    const resultEl = document.getElementById('delivery-time-result');
    btn.disabled   = true;
    resultEl.textContent = '計算中...';

    try {
        const res  = await fetch(url, {
            method: 'POST',
            body: JSON.stringify({ action: 'getTravelTimes', stops })
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.error || '取得失敗');

        const count     = midStops.length; // デポは件数に含めない
        const workSec   = count * 3 * 60;
        const durArr    = json.durations || [];
        const travelSec = durArr.reduce((sum, d) => sum + (d || 0), 0);
        const totalSec  = workSec + travelSec;
        const totalMin  = Math.ceil(totalSec / 60);
        const travelMin = Math.round(travelSec / 60);
        const workMin   = count * 3;

        let finishStr = '';
        const startInput = document.getElementById('delivery-start-time');
        if (startInput && startInput.value) {
            const [sh, sm] = startInput.value.split(':').map(Number);
            const startMin = sh * 60 + sm;
            const endMin   = startMin + totalMin;
            const eh = Math.floor(endMin / 60) % 24;
            const em = endMin % 60;
            finishStr = ` → ${String(eh).padStart(2,'0')}:${String(em).padStart(2,'0')}頃`;

            // 各顧客の到着予定時刻を計算
            // hasDepot: durArr[0]=depot→stop0, durArr[i]=stop(i-1)→stop(i)
            // no depot: durArr[i-1]=stop(i-1)→stop(i), stop0 は出発点
            deliveryArrivalTimes = {};
            midStopsData.forEach((stop, i) => {
                const cumulTravelSec = hasDepot
                    ? durArr.slice(0, i + 1).reduce((s, d) => s + (d || 0), 0)
                    : (i === 0 ? 0 : durArr.slice(0, i).reduce((s, d) => s + (d || 0), 0));
                const arrMin = startMin + Math.round(cumulTravelSec / 60) + 3 * i;
                const ah = Math.floor(arrMin / 60) % 24;
                const am = arrMin % 60;
                deliveryArrivalTimes[stop.groupKey] =
                    `${String(ah).padStart(2,'0')}:${String(am).padStart(2,'0')}`;
            });
            updateArrivalTimeDisplay();
        }

        const html = `${count}件 | 移動 約${travelMin}分 + 作業 ${workMin}分 = <strong>合計 約${totalMin}分</strong>${finishStr}`;
        resultEl.innerHTML = html;
    } catch (e) {
        resultEl.textContent = 'エラー: ' + e.message;
    } finally {
        btn.disabled = false;
    }
}

// ─── 到着予定時刻を各カードに反映 ────────────────────────────────
function updateArrivalTimeDisplay() {
    document.querySelectorAll('#delivery-list .delivery-eta[data-group-key]').forEach(el => {
        const time = deliveryArrivalTimes[el.dataset.groupKey];
        el.textContent = time ? `\u23F1 \u7D04${time}\u9803` : '';
    });
}

// ─── 全ルートを Google マップで開く ──────────────────────────────
function openAllRouteMap() {
    const addrs = currentDeliveryListData
        .filter(m => m.address && !deliveryChecked[m.groupKey])
        .map(m => m.address);

    if (addrs.length === 0) { alert('未配達の住所がありません'); return; }

    const store     = currentDeliveryListData[0]?.store || filters.store || '';
    const depotAddr = STORE_DEPOTS[store];
    const allStops  = depotAddr ? [depotAddr, ...addrs] : addrs;

    // Google Maps URL は1リンクあたり約10地点が上限
    // 10件超は末尾1件を重複させてチェーン接続
    const CHUNK = 10;
    const urls = [];
    for (let i = 0; i < allStops.length; i += CHUNK - 1) {
        const slice = allStops.slice(i, i + CHUNK);
        if (slice.length >= 2) {
            const path = slice.map(a => encodeURIComponent(a)).join('/');
            urls.push(`https://www.google.com/maps/dir/${path}`);
        }
        if (i + CHUNK >= allStops.length) break;
    }

    if (urls.length === 0) { alert('住所が不足しています'); return; }

    // window.open() はモバイルのポップアップブロッカーに引っかかるため
    // <a> リンクをダイアログに表示してユーザーにタップしてもらう
    const linksDiv = document.getElementById('route-map-links');
    linksDiv.innerHTML = urls.map((url, i) =>
        `<a class="btn btn-primary" style="display:block;text-align:center;text-decoration:none"
            href="${url}" target="_blank" rel="noopener">
            ${urls.length === 1 ? 'Google マップで開く' : `区間 ${i + 1}／${urls.length} を開く`}
         </a>`
    ).join('');

    document.getElementById('route-map-dialog').showModal();
}

function closeRouteMapDialog() {
    document.getElementById('route-map-dialog').close();
}

// ─── 新規確認（最近傍） ───────────────────────────────────────────
async function checkNewCustomers() {
    const url = getGasUrl();
    if (!url) { alert('GAS URLが設定されていません'); return; }

    const midStops = currentDeliveryListData
        .filter(m => m.address)
        .map(m => {
            const isNewStop = m.countLabel?.includes('新規') || m.countLabel?.includes('再注文');
            const newLabel  = isNewStop
                ? (m.countLabel?.includes('再注文') ? '再注文' : '新規')
                : '';
            return {
                address: m.address,
                name:    m.name,
                isNew:   isNewStop,
                label:   newLabel,
            };
        });

    if (midStops.length < 2) {
        alert('住所が2件以上必要です');
        return;
    }

    const store     = currentDeliveryListData[0]?.store || filters.store || '';
    const depotAddr = STORE_DEPOTS[store];
    const stops     = depotAddr
        ? [
            { address: depotAddr, name: store, isNew: false, isDepot: true },
            ...midStops,
            { address: depotAddr, name: store, isNew: false, isDepot: true },
          ]
        : midStops;

    const btn      = document.getElementById('btn-check-new');
    const resultEl = document.getElementById('delivery-time-result');
    btn.disabled   = true;
    resultEl.textContent = '確認中...';

    try {
        const res  = await fetch(url, {
            method: 'POST',
            body: JSON.stringify({ action: 'getTravelTimes', stops })
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.error || '取得失敗');

        const nearest = json.nearest || [];
        if (nearest.length === 0) {
            resultEl.textContent = '新規・再注文なし';
            return;
        }
        const rows = nearest.map(n => {
            const dist = n.distanceM >= 1000
                ? (n.distanceM / 1000).toFixed(1) + 'km'
                : n.distanceM + 'm';
            return `<span class="nearest-hint">${escHtml(n.label || '新規')} ${escHtml(n.newName)}：${escHtml(n.nearestName)} の次（約${dist}）</span>`;
        }).join('');
        resultEl.innerHTML = `<div class="nearest-hints">${rows}</div>`;
    } catch (e) {
        resultEl.textContent = 'エラー: ' + e.message;
    } finally {
        btn.disabled = false;
    }
}

// ─── 最適ルート ──────────────────────────────────────────────────
async function optimizeDeliveryRoute() {
    const url = getGasUrl();
    if (!url) { alert('GAS URLが設定されていません'); return; }

    const stops = currentDeliveryListData
        .filter(m => m.address)
        .map(m => ({ address: m.address, name: m.name, groupKey: m.groupKey }));

    if (stops.length < 2) {
        alert('住所が2件以上必要です');
        return;
    }
    if (stops.length > 70) {
        alert(`配達件数が ${stops.length} 件あります。70件を超える場合は最適化できません。ルートフィルターで件数を絞ってから実行してください。`);
        return;
    }

    const store     = currentDeliveryListData[0]?.store || filters.store || '';
    const depotAddr = STORE_DEPOTS[store] || null;

    const btn      = document.getElementById('btn-optimize-route');
    const resultEl = document.getElementById('delivery-time-result');
    btn.disabled   = true;
    resultEl.textContent = '最適化中...';

    try {
        const res  = await fetch(url, {
            method: 'POST',
            body: JSON.stringify({ action: 'optimizeRoute', stops, depot: depotAddr })
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.error || '取得失敗');

        // GAS から返ってきた waypointOrder（stops 配列の添え字順）を groupKey 順に変換
        // 範囲外・不正なインデックスは除外してフォールバック
        const rawOrder = json.order || stops.map((_, i) => i);
        const validOrder = rawOrder.filter(i => i >= 0 && i < stops.length);
        const order = validOrder.length === stops.length ? validOrder : stops.map((_, i) => i);
        const optimizedGroupKeys = order.map(i => stops[i].groupKey);

        // 最適ルート順を保存して再描画
        deliveryRouteOptimized = optimizedGroupKeys;
        deliveryArrivalTimes   = {};
        renderDelivery();

        resultEl.textContent = `最適ルートを適用しました（${stops.length}件）`;
    } catch (e) {
        resultEl.textContent = 'エラー: ' + e.message;
    } finally {
        btn.disabled = false;
    }
}

function revertDeliveryOrder() {
    deliveryRouteOptimized = null;
    deliveryArrivalTimes   = {};
    renderDelivery();
    const resultEl = document.getElementById('delivery-time-result');
    if (resultEl) resultEl.textContent = '';
}

// ─── Delivery Tab ────────────────────────────────────────────────
function renderDelivery() {
    const container = document.getElementById('delivery-list');
    if (!container) return;

    // 店舗フィルター（ルートはオーバーライド適用後に絞る）
    const storeData = deliveryData.filter(r =>
        !filters.store || r.store === filters.store
    );

    // 名前・住所が同じレコードをひとつにまとめる
    const groupMap = new Map();
    storeData.forEach(r => {
        const gk = `${r.name}|||${r.address}`;
        if (!groupMap.has(gk)) groupMap.set(gk, []);
        groupMap.get(gk).push(r);
    });

    // 複数値フィールドの重複除去ヘルパー
    function uniq(recs, field) {
        return [...new Set(recs.map(r => r[field]).filter(Boolean))];
    }

    // マージ済みレコード配列を生成
    const merged = [];
    groupMap.forEach(recs => {
        const base     = recs[0];
        const groupKey = `${base.store}|${base.dataMonth}|${base.name}|${base.address}`;
        const override = deliveryRouteOverrides[groupKey];
        const routes   = override
            ? [override.route]
            : [...new Set(recs.map(r => r.route))].sort((a, b) => a - b);
        merged.push({
            routes,
            name:        base.name,
            address:     base.address,
            store:       base.store,
            dataMonth:   base.dataMonth,
            paymentType: base.paymentType,
            items:       recs.map(r => ({ type: r.type, count: r.count })).filter(i => i.type),
            countLabel:  uniq(recs, 'countLabel').filter(Boolean).join(''),
            vessel:    uniq(recs, 'vessel').join(' / '),
            weekly:    uniq(recs, 'weekly').join(' / '),
            phone:     uniq(recs, 'phone').join(' / '),
            emergency: uniq(recs, 'emergency').join(' / '),
            notes:     uniq(recs, 'notes').join('\n'),
            memo:      uniq(recs, 'memo').join('\n'),
            absent:    uniq(recs, 'absent').join('\n'),
            groupKey,
        });
    });

    // ルートフィルター（オーバーライド適用後に判定）
    const data = (filters.route
        ? merged.filter(m => m.routes.some(r => String(r) === filters.route))
        : merged
    ).sort((a, b) => {
        const ra = a.routes[0] ?? 0;
        const rb = b.routes[0] ?? 0;
        if (ra !== rb) return ra - rb;
        // 同一ルート内：オーバーライド済みを先頭に
        const aOv = deliveryRouteOverrides[a.groupKey] ? 0 : 1;
        const bOv = deliveryRouteOverrides[b.groupKey] ? 0 : 1;
        return aOv - bOv;
    });

    // 最適ルートが適用されている場合は最適順で並び替え
    if (deliveryRouteOptimized) {
        const keyOrder = deliveryRouteOptimized;
        data.sort((a, b) => {
            const ai = keyOrder.indexOf(a.groupKey);
            const bi = keyOrder.indexOf(b.groupKey);
            if (ai === -1 && bi === -1) return 0;
            if (ai === -1) return 1;
            if (bi === -1) return -1;
            return ai - bi;
        });
    }

    // 「元の順番」ボタン表示切替
    const revertBtn = document.getElementById('btn-revert-route');
    if (revertBtn) revertBtn.classList.toggle('hidden', !deliveryRouteOptimized);

    // 所要時間計算用にデータを保持、結果はリセット
    currentDeliveryListData = data;
    const timeBar = document.getElementById('delivery-time-bar');
    const timeResult = document.getElementById('delivery-time-result');
    if (timeBar) {
        if (data.length >= 2 && data.some(m => m.address)) {
            timeBar.classList.remove('hidden');
        } else {
            timeBar.classList.add('hidden');
        }
        if (timeResult) timeResult.textContent = '';
    }

    if (data.length === 0) {
        container.innerHTML = '<div class="empty-msg">該当する配達先がありません</div>';
        return;
    }

    const currentMonth = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }).slice(0, 7);

    let html = '';
    data.forEach(m => {
        const isDone   = !!deliveryChecked[m.groupKey];
        const doneTime = isDone
            ? new Date(deliveryChecked[m.groupKey].checkedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' })
            : '';

        const hasOverride = !!deliveryRouteOverrides[m.groupKey];
        const routeBadges = m.routes.map(r =>
            `<span class="delivery-route-badge${hasOverride ? ' route-overridden' : ''}">R${r}</span>`
        ).join('');

        const isBank = m.paymentType === 'bank';

        const mapHref  = m.address ? `https://maps.google.com/?q=${encodeURIComponent(m.address)}` : '';
        const addrHtml = m.address
            ? `<a class="delivery-address" href="${mapHref}" target="_blank" rel="noopener">&#128205; ${escHtml(m.address)}</a>`
            : '';

        const phoneHtml     = m.phone
            ? `<a class="btn-contact btn-contact-phone" href="tel:${m.phone.replace(/[^\d+\-]/g, '')}">&#128222; ${escHtml(m.phone)}</a>`
            : '';
        const emergencyHtml = m.emergency
            ? `<a class="btn-contact btn-contact-emergency" href="tel:${m.emergency.replace(/[^\d+\-]/g, '')}">&#128680; ${escHtml(m.emergency)}</a>`
            : '';

        // 種類×数量をひとまとめに表示（セット系は構成要素に展開して表示）
        // count が全て "0" の場合はお弁当なし・訪問のみ
        const expandedItems = expandDeliveryItems(m.items);
        const isVisitOnly = m.items.length > 0 && expandedItems.length === 0;
        const itemsHtml = isVisitOnly
            ? `<span class="delivery-meta-item dtype-visit">訪問</span>`
            : expandedItems.map(i => {
                const colorClass = DELIVERY_TYPE_COLOR[i.type] || 'dtype-black';
                const countNum  = parseInt(i.count) || 0;
                const countHtml = countNum >= 2
                    ? `<span class="item-count-multi">${escHtml(i.count)}</span>`
                    : escHtml(i.count);
                return `<span class="delivery-meta-item ${colorClass}">${escHtml(i.type)}&times;${countHtml}</span>`;
            }).join('');

        const otherMetaParts = [
            m.vessel ? `<span class="delivery-meta-item">&#128230; ${escHtml(m.vessel)}</span>` : '',
            m.weekly ? `<span class="delivery-meta-item">&#128197; ${escHtml(m.weekly)}</span>` : '',
        ].filter(Boolean).join('');

        const notesHtml = [
            m.notes  ? `<div class="delivery-note">&#9888; ${escHtml(m.notes)}</div>`    : '',
            m.memo   ? `<div class="delivery-note">&#128172; ${escHtml(m.memo)}</div>`   : '',
            m.absent ? `<div class="delivery-note">&#128682; ${escHtml(m.absent)}</div>` : '',
        ].filter(Boolean).join('');

        const safeKey    = escHtml(m.groupKey);
        const routeKey   = `${m.store}|${m.routes[0]}`;
        const isCompact  = deliveryCompactRoutes.has(routeKey);
        const checkBtn  = isDone
            ? `<button class="btn-delivery-check btn-delivery-done" data-key="${safeKey}">&#10003; 配達完了${doneTime ? ' ' + doneTime : ''}（取消）</button>`
            : `<button class="btn-delivery-check" data-key="${safeKey}">配達完了</button>`;
        const compactMapHtml = m.address
            ? `<a class="delivery-compact-map" href="${mapHref}" target="_blank" rel="noopener">&#128205;</a>`
            : '';

        const cardLabelClass = m.countLabel ? ` delivery-card-label-${labelClass(m.countLabel)}` : '';
        html += `
        <div class="delivery-card ${isDone ? 'delivery-card-done' : ''}${isCompact ? ' delivery-card-compact' : ''}${cardLabelClass}" data-group-key="${safeKey}" data-route-key="${escHtml(routeKey)}">
            <div class="delivery-card-header">
                <div class="delivery-route-area" data-group-key="${safeKey}" title="ダブルタップでルート変更">
                    ${routeBadges}
                </div>
                <div class="delivery-name-area">
                    <span class="delivery-name">${escHtml(m.name)}</span>
                    <span class="delivery-eta" data-group-key="${safeKey}"></span>
                    ${m.countLabel ? `<span class="count-label count-label-${labelClass(m.countLabel)}">${escHtml(m.countLabel === '\u96C6\u91D1' ? '\u8ACB\u6C42' : m.countLabel === '\u7FCC\u9031\u6CE8\u6587\u78BA\u8A8D' ? '\u6CE8\u6587\u78BA\u8A8D' : m.countLabel)}</span>` : ''}
                    ${compactMapHtml}
                    <button class="btn-delivery-msg-open" data-group-key="${safeKey}">連絡事項</button>
                    ${isBank
                        ? `<span class="delivery-bank-label">口座振替</span>`
                        : (() => {
                            const prevAmt = allData
                                .filter(r => r.name === m.name && r.store === m.store && r.dataMonth < currentMonth)
                                .filter(r => { const k = getKey(r); return !isFullyCollected(k, r) && effectiveAmount(k, r) > 0; })
                                .reduce((sum, r) => sum + effectiveAmount(getKey(r), r), 0);
                            const badge = prevAmt > 0
                                ? `<span class="collect-prev-badge">未</span>`
                                : '';
                            return `<button class="btn-delivery-collect-open${prevAmt > 0 ? ' has-prev-uncollected' : ''}" data-group-key="${safeKey}">集金${badge}</button>`;
                        })()
                    }
                </div>
            </div>
            ${addrHtml      ? `<div class="delivery-card-row">${addrHtml}</div>`                                    : ''}
            <div class="delivery-card-items-row">
                <div class="delivery-card-items">${itemsHtml}</div>
                <button class="btn-delivery-image-open" data-group-key="${safeKey}">&#128247; 画像</button>
            </div>
            <div class="delivery-card-check-row">${checkBtn}</div>
            ${otherMetaParts? `<div class="delivery-card-other-meta">${otherMetaParts}</div>`                       : ''}
            ${(phoneHtml || emergencyHtml) ? `<div class="delivery-card-contacts">${phoneHtml}${emergencyHtml}</div>` : ''}
            ${notesHtml     ? `<div class="delivery-card-notes-wrap">${notesHtml}</div>`                            : ''}
        </div>`;
    });

    container.innerHTML = html;
    updateArrivalTimeDisplay();

    container.querySelectorAll('.btn-delivery-check').forEach(btn => {
        btn.addEventListener('click', () => onDeliveryCheck(btn.dataset.key, btn));
    });

    updateDeliverySummary(data);

    container.querySelectorAll('.btn-delivery-msg-open').forEach(btn => {
        btn.addEventListener('click', () => openDeliveryMsgDialog(btn.dataset.groupKey));
    });
    container.querySelectorAll('.btn-delivery-collect-open').forEach(btn => {
        btn.addEventListener('click', () => openDeliveryCollectDialog(btn.dataset.groupKey));
    });
    container.querySelectorAll('.btn-delivery-image-open').forEach(btn => {
        btn.addEventListener('click', () => openImageDialog(btn.dataset.groupKey));
    });

    // カード：ダブルタップ／ダブルクリックで同ルート全カードをコンパクト切替
    let _lastCardTapKey  = null;
    let _lastCardTapTime = 0;
    const toggleRouteCompact = (routeKey) => {
        const isNowCompact = !deliveryCompactRoutes.has(routeKey);
        if (isNowCompact) deliveryCompactRoutes.add(routeKey);
        else              deliveryCompactRoutes.delete(routeKey);
        container.querySelectorAll(`.delivery-card[data-route-key="${CSS.escape(routeKey)}"]`).forEach(c => {
            c.classList.toggle('delivery-card-compact', isNowCompact);
        });
    };
    const handleCardTap = (rk) => {
        const now = Date.now();
        if (_lastCardTapKey === rk && now - _lastCardTapTime < 500) {
            toggleRouteCompact(rk);
            _lastCardTapKey = null;
        } else {
            _lastCardTapKey  = rk;
            _lastCardTapTime = now;
        }
    };
    container.querySelectorAll('.delivery-card').forEach(card => {
        const rk = card.dataset.routeKey;
        // PC: dblclick
        card.addEventListener('dblclick', e => {
            if (e.target.closest('button, a, .delivery-route-area')) return;
            _lastCardTapKey = null;
            toggleRouteCompact(rk);
        });
        // スマホ: touchend で300ms遅延を回避
        card.addEventListener('touchend', e => {
            if (e.target.closest('button, a, .delivery-route-area')) return;
            e.preventDefault(); // clickイベントの重複発火を防止
            handleCardTap(rk);
        }, { passive: false });
        // PCフォールバック: touchend が発火しない環境向け
        card.addEventListener('click', e => {
            if (e.target.closest('button, a, .delivery-route-area')) return;
            if (e._fromTouch) return; // touchend 処理済みならスキップ
            handleCardTap(rk);
        });
    });

    // ルートバッジ：ダブルクリック／ダブルタップでルート編集
    let _lastRouteTapKey   = null;
    let _lastRouteTapTime  = 0;
    let _lastRouteTouchTime = 0; // touchend 発火時刻（合成 click を抑制するため）
    const handleRouteTap = (area, gk) => {
        const now = Date.now();
        if (_lastRouteTapKey === gk && now - _lastRouteTapTime < 600) {
            openDeliveryRouteEdit(area, gk);
            _lastRouteTapKey = null;
        } else {
            _lastRouteTapKey  = gk;
            _lastRouteTapTime = now;
        }
    };
    container.querySelectorAll('.delivery-route-area').forEach(area => {
        const gk = area.dataset.groupKey;
        area.addEventListener('touchend', e => {
            e.preventDefault();
            _lastRouteTouchTime = Date.now();
            handleRouteTap(area, gk);
        }, { passive: false });
        area.addEventListener('click', e => {
            // touchend 直後（600ms以内）の合成 click は無視（スマホでの二重発火対策）
            if (Date.now() - _lastRouteTouchTime < 600) return;
            handleRouteTap(area, gk);
        });
    });
}

// セット系を構成要素に展開して表示用アイテム配列を返す
function expandDeliveryItems(items) {
    // \u30BB\u30C3\u30C8=セット \u304A\u304B\u305A=おかず \u3054\u306F\u3093=ごはん
    // \u5C0F\u7B25=小箱 \u30C0\u30D6\u30EB=ダブル
    var SET_EXPAND = {};
    SET_EXPAND['セット']     = ['おかず', 'ごはん'];
    SET_EXPAND['小箱セット'] = ['小箱',   'ごはん'];
    SET_EXPAND['ダブルセット'] = ['ダブル', 'ごはん'];

    const map = new Map();
    items.forEach(function(i) {
        const n = parseInt(i.count);
        if (!(n > 0)) return; // 個数0またはNaNはスキップ
        const expanded = SET_EXPAND[i.type];
        if (expanded) {
            expanded.forEach(function(type) {
                map.set(type, (map.get(type) || 0) + n);
            });
        } else {
            map.set(i.type, (map.get(i.type) || 0) + n);
        }
    });
    return Array.from(map.entries())
        .map(function(e) { return { type: e[0], count: String(e[1]) }; })
        .sort(function(a, b) {
            if (a.type === 'ごはん') return 1;
            if (b.type === 'ごはん') return -1;
            return 0;
        });
}

// 種類名 → CSS色クラス
const DELIVERY_TYPE_COLOR = {
    'おかず':      'dtype-black',
    'セット':      'dtype-green',
    '小箱':        'dtype-cyan',
    '小箱セット':  'dtype-cyan',
    'ダブル':      'dtype-pink',
    'ダブルセット':'dtype-pink',
    'ご膳':        'dtype-red',
    'ごはん':      'dtype-orange',
};

// 種類名 → カテゴリへのマッピング（1種類が複数カテゴリに加算される場合あり）
const DELIVERY_CATEGORY_MAP = {
    'おかず':     ['おかず'],
    'セット':     ['おかず', 'ごはん'],
    '小箱':       ['小箱'],
    '小箱セット': ['小箱', 'ごはん'],
    'ダブル':     ['ダブル'],
    'ダブルセット':['ダブル', 'ごはん'],
    'ご膳':       ['ご膳'],
    'ごはん':     ['ごはん'],
};

function updateDeliverySummary(data) {
    const counts = { おかず: 0, 小箱: 0, ダブル: 0, ご膳: 0, ごはん: 0 };
    // multiCounts[cat][n] = n個注文している人数（n=2〜4）
    const multiCounts = { おかず: {}, 小箱: {}, ダブル: {}, ご膳: {}, ごはん: {} };

    data.forEach(m => {
        if (deliveryChecked[m.groupKey]) return; // 配達済みは除外
        const groupCounts = { おかず: 0, 小箱: 0, ダブル: 0, ご膳: 0, ごはん: 0 };
        m.items.forEach(item => {
            const cats = DELIVERY_CATEGORY_MAP[item.type];
            if (!cats) return;
            const n = parseInt(item.count);
            if (!(n > 0)) return; // 個数0はスキップ
            cats.forEach(cat => {
                counts[cat] += n;
                groupCounts[cat] += n;
            });
        });
        // このグループの各カテゴリ合計が2〜4なら集計
        Object.keys(groupCounts).forEach(cat => {
            const n = groupCounts[cat];
            if (n >= 2 && n <= 4) {
                multiCounts[cat][n] = (multiCounts[cat][n] || 0) + 1;
            }
        });
    });

    [
        ['ds-okazu',  'おかず'],
        ['ds-kobox',  '小箱'],
        ['ds-double', 'ダブル'],
        ['ds-gozen',  'ご膳'],
        ['ds-gohan',  'ごはん'],
    ].forEach(([id, cat]) => {
        const el   = document.getElementById(id);
        const item = el?.closest('.ds-item');
        if (!el) return;
        el.textContent = counts[cat];
        item?.classList.toggle('zero', counts[cat] === 0);

        // 複数個バッジの更新
        let badgeContainer = item?.querySelector('.ds-multi-badges');
        if (!badgeContainer && item) {
            badgeContainer = document.createElement('span');
            badgeContainer.className = 'ds-multi-badges';
            item.appendChild(badgeContainer);
        }
        if (badgeContainer) {
            badgeContainer.innerHTML = '';
            [2, 3, 4].forEach(n => {
                const cnt = multiCounts[cat][n] || 0;
                if (cnt > 0) {
                    const badge = document.createElement('span');
                    badge.className = 'ds-multi-badge';
                    badge.textContent = `${n}個:${cnt}`;
                    badgeContainer.appendChild(badge);
                }
            });
        }
    });

    // 配達件数・進捗メッセージ（訪問のみは除外）
    const deliveryTargets = data.filter(m => {
        const expanded = expandDeliveryItems(m.items);
        const isVisitOnly = m.items.length > 0 && expanded.length === 0;
        return !isVisitOnly;
    });
    const totalDelivery = deliveryTargets.length;
    const doneDelivery  = deliveryTargets.filter(m => !!deliveryChecked[m.groupKey]).length;
    const remain        = totalDelivery - doneDelivery;

    const totalEl = document.getElementById('ds-delivery-total');
    if (totalEl) totalEl.textContent = totalDelivery;
}

function getDeliveryProgress() {
    const storeData = deliveryData.filter(r => !filters.store || r.store === filters.store);
    const groupMap = new Map();
    storeData.forEach(r => {
        const gk = `${r.name}|||${r.address}`;
        if (!groupMap.has(gk)) groupMap.set(gk, []);
        groupMap.get(gk).push(r);
    });
    let total = 0, done = 0;
    groupMap.forEach(recs => {
        const base = recs[0];
        const groupKey = `${base.store}|${base.dataMonth}|${base.name}|${base.address}`;
        const override = deliveryRouteOverrides[groupKey];
        const routes = override ? [override.route] : [...new Set(recs.map(r => r.route))].sort((a, b) => a - b);
        if (filters.route && !routes.some(r => String(r) === filters.route)) return;
        const items = recs.map(r => ({ type: r.type, count: r.count })).filter(i => i.type);
        const isVisitOnly = items.length > 0 && expandDeliveryItems(items).length === 0;
        if (isVisitOnly) return;
        total++;
        if (deliveryChecked[groupKey]) done++;
    });
    return { total, done, remain: total - done };
}

function showDeliveryProgressPopup(anchorEl, msg, type) {
    let el = document.getElementById('delivery-progress-popup');
    if (!el) {
        el = document.createElement('div');
        el.id = 'delivery-progress-popup';
        document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = `delivery-progress-popup delivery-progress-popup-${type}`;
    const rect = anchorEl.getBoundingClientRect();
    const above = rect.top > 60;
    el.style.left = `${rect.left + rect.width / 2}px`;
    el.style.top  = above ? `${rect.top - 44}px` : `${rect.bottom + 8}px`;
    el.dataset.above = above ? '1' : '0';
    requestAnimationFrame(() => {
        const er = el.getBoundingClientRect();
        if (er.right > window.innerWidth - 8)  el.style.left = `${window.innerWidth - er.width / 2 - 8}px`;
        if (er.left  < 8)                       el.style.left = `${er.width / 2 + 8}px`;
        el.classList.add('delivery-progress-popup-show');
    });
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('delivery-progress-popup-show'), type === 'done' ? 3500 : 2200);
}

function onDeliveryCheck(groupKey, btnEl) {
    // グループキー（store|dataMonth|name|address）から代表レコードを取得
    const record = deliveryData.find(r =>
        `${r.store}|${r.dataMonth}|${r.name}|${r.address}` === groupKey
    );
    if (!record) return;

    if (deliveryChecked[groupKey]) {
        delete deliveryChecked[groupKey];
        showToast(`${record.name} — 配達完了を取消`, 'info');
        markDirty(groupKey);
        const url = getGasUrl();
        if (url) {
            postToGas(url, { action: 'removeDelivery', groupKey });
        }
    } else {
        const now = new Date().toISOString();
        deliveryChecked[groupKey] = { checkedAt: now };
        showToast(`✓ ${record.name} — 配達完了にしました`, 'success');
        markDirty(groupKey);
        const url = getGasUrl();
        if (url) {
            postToGas(url, {
                action:      'addDelivery',
                groupKey:    groupKey,
                store:       record.store,
                route:       record.route,
                dataMonth:   record.dataMonth,
                name:        record.name,
                address:     record.address,
                deliveredAt: now,
            });
        }
    }

    saveDeliveryChecked();
    renderDelivery();

    // 進捗ポップアップ（再描画後の新しいボタン要素に対して表示）
    const newBtn = document.querySelector(`#delivery-list .btn-delivery-check[data-key="${CSS.escape(groupKey)}"]`);
    const anchor = newBtn || btnEl;
    if (anchor) {
        const p = getDeliveryProgress();
        if (p.total > 0) {
            if (p.remain === 0) {
                showDeliveryProgressPopup(anchor, '配達終了です。お疲れ様でした。', 'done');
            } else {
                showDeliveryProgressPopup(anchor, `あと${p.remain}件！頑張って`, 'remain');
            }
        }
    }
}

function openDeliveryRouteEdit(area, groupKey) {
    // 利用可能なルート一覧（全配達データから取得）
    const allRoutes = [...new Set(deliveryData.map(r => r.route))].sort((a, b) => a - b);
    const override  = deliveryRouteOverrides[groupKey];
    // 現在のルート（オーバーライドあれば優先、なければ元データの最初のルート）
    const record    = deliveryData.find(r =>
        `${r.store}|${r.dataMonth}|${r.name}|${r.address}` === groupKey
    );
    const currentRoute = override ? override.route : (record ? record.route : allRoutes[0]);

    const select = document.createElement('select');
    select.className = 'delivery-route-edit-select';
    allRoutes.forEach(r => {
        const opt = document.createElement('option');
        opt.value = r;
        opt.textContent = `R${r}`;
        if (r === currentRoute) opt.selected = true;
        select.appendChild(opt);
    });

    area.innerHTML = '';
    area.appendChild(select);
    select.focus();

    select.addEventListener('change', () => {
        const today     = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
        const dataGenAt = window.DATA_META?.generatedAt || '';
        deliveryRouteOverrides[groupKey] = { route: Number(select.value), date: today, dataGeneratedAt: dataGenAt };
        saveDeliveryRouteOverrides();
        renderDelivery();
    });

    // 選択せずにフォーカスが外れたら元に戻す
    select.addEventListener('blur', () => {
        // change が先に発火していない場合のみ再描画
        renderDelivery();
    });
}

// ─── Delivery Message Dialog ─────────────────────────────────────
let _deliveryMsgTarget = null; // { store, route, name, groupKey }
let _deliveryMsgImageData = null; // base64 image data

function openDeliveryMsgDialog(groupKey) {
    const record = deliveryData.find(r =>
        `${r.store}|${r.dataMonth}|${r.name}|${r.address}` === groupKey
    );
    if (!record) return;

    const override = deliveryRouteOverrides[groupKey];
    const route    = override ? override.route : record.route;

    _deliveryMsgTarget = { store: record.store, route, name: record.name, groupKey };

    document.getElementById('delivery-msg-target').innerHTML =
        `<div class="delivery-msg-target-info">
            <span class="delivery-route-badge">R${route}</span>
            <strong>${escHtml(record.name)}</strong>
            <span style="font-size:13px;color:var(--g500)">${escHtml(record.store)}</span>
        </div>`;
    const msgType = document.getElementById('delivery-msg-type');
    msgType.value = '';
    document.getElementById('delivery-msg-text').value = '';
    resetMsgDatePicker();
    _resetMsgImageArea();
    document.getElementById('delivery-msg-dialog').showModal();
    msgType.blur();
}

function closeDeliveryMsgDialog() {
    document.getElementById('delivery-msg-dialog').close();
    _deliveryMsgTarget = null;
    _resetMsgImageArea();
}

function _resetMsgImageArea() {
    _deliveryMsgImageData = null;
    document.getElementById('delivery-msg-image').value = '';
    document.getElementById('msg-image-preview').innerHTML = '';
    document.getElementById('msg-image-area').classList.add('hidden');
}

function onMsgImageChange(input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
        _deliveryMsgImageData = e.target.result; // base64 data URL
        const preview = document.getElementById('msg-image-preview');
        preview.innerHTML = `<img src="${_deliveryMsgImageData}" class="msg-image-thumb" alt="添付画像">`;
    };
    reader.readAsDataURL(file);
}

function submitDeliveryMsg() {
    if (!_deliveryMsgTarget) return;
    const typeVal  = document.getElementById('delivery-msg-type').value;
    const freeText = document.getElementById('delivery-msg-text').value.trim();

    // 注文・キャンセル の場合、選択日付が必須
    if ((typeVal === '注文' || typeVal === 'キャンセル') && _calSelectedDates.size === 0) {
        alert('日付を1つ以上選択してください');
        return;
    }

    if (typeVal === '画像添付') {
        if (!_deliveryMsgImageData) {
            alert('画像を撮影してください');
            return;
        }
    } else if (!typeVal && !freeText) {
        alert('報告内容を選択するか、自由入力欄に入力してください');
        return;
    }

    const parts = [];
    if (typeVal === '注文' || typeVal === 'キャンセル') {
        const sorted = [..._calSelectedDates].sort();
        const dateStr = sorted.map(d => {
            const [y, m, day] = d.split('-');
            return `${parseInt(m)}/${parseInt(day)}`;
        }).join('、');
        parts.push(`${typeVal}（${dateStr}）`);
    } else if (typeVal && typeVal !== '画像添付') {
        parts.push(typeVal);
    }
    if (freeText) parts.push(freeText);

    const msg = {
        id:           Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        store:        _deliveryMsgTarget.store,
        route:        _deliveryMsgTarget.route,
        customerKey:  _deliveryMsgTarget.groupKey,
        customerName: _deliveryMsgTarget.name,
        text:         typeVal === '画像添付' ? (freeText || '画像添付') : parts.join('\n'),
        imageData:    _deliveryMsgImageData || undefined,
        createdAt:    new Date().toISOString(),
    };

    const msgs = loadAllMessages();
    msgs.push(msg);
    saveMessages(msgs);

    const url = getGasUrl();
    if (url) postToGas(url, { action: 'addMessage', message: msg });

    const sentName = _deliveryMsgTarget.name;
    closeDeliveryMsgDialog();
    alert(`「${sentName}」の連絡事項を送信しました`);
}

// ─── Other Customer Message Dialog ───────────────────────────────
function openOtherDeliveryMsgDialog() {
    // 配達表に載っている人の名前セット（現在のフィルター適用）
    const deliveryNames = new Set(
        deliveryData
            .filter(r => !filters.store || r.store === filters.store)
            .filter(r => !filters.route || String(r.route) === filters.route)
            .map(r => r.name)
    );

    // 集金リストから配達表にいないお客様を抽出
    const seen = new Set();
    const otherCustomers = allData.filter(r => {
        if ((r.amount || 0) === 0) return false;
        if (filters.store && r.store !== filters.store) return false;
        const k = getKey(r);
        const rte = effectiveRoute(k, r);
        if (filters.route && String(rte) !== filters.route) return false;
        if (deliveryNames.has(r.name)) return false;
        const dedupeKey = `${r.store}|${rte}|${r.name}`;
        if (seen.has(dedupeKey)) return false;
        seen.add(dedupeKey);
        return true;
    }).sort((a, b) => {
        const ka = getKey(a), kb = getKey(b);
        const ra = effectiveRoute(ka, a), rb = effectiveRoute(kb, b);
        if (ra !== rb) return ra - rb;
        return (a.seq || 0) - (b.seq || 0);
    });

    if (otherCustomers.length === 0) {
        showToast('配達表にないお客様はいません', 'info');
        return;
    }

    const sel = document.getElementById('other-msg-customer-select');
    sel.innerHTML = '<option value="">お客様を選択してください</option>' +
        otherCustomers.map(r => {
            const k = getKey(r);
            const rte = effectiveRoute(k, r);
            return `<option value="${escHtml(k)}" data-store="${escHtml(r.store)}" data-route="${rte}" data-name="${escHtml(r.name)}">R${rte} ${escHtml(r.name)}</option>`;
        }).join('');

    document.getElementById('other-msg-type').value = '';
    document.getElementById('other-msg-text').value = '';
    document.getElementById('other-msg-dialog').showModal();
}

function closeOtherMsgDialog() {
    document.getElementById('other-msg-dialog').close();
}

function submitOtherDeliveryMsg() {
    const sel = document.getElementById('other-msg-customer-select');
    if (!sel.value) { alert('お客様を選択してください'); return; }
    const opt     = sel.selectedOptions[0];
    const typeVal = document.getElementById('other-msg-type').value;
    const freeText = document.getElementById('other-msg-text').value.trim();
    if (!typeVal && !freeText) { alert('報告内容を選択するか、自由入力欄に入力してください'); return; }

    const parts = [];
    if (typeVal)  parts.push(typeVal);
    if (freeText) parts.push(freeText);

    const msg = {
        id:           Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        store:        opt.dataset.store,
        route:        parseInt(opt.dataset.route),
        customerKey:  sel.value,
        customerName: opt.dataset.name,
        text:         parts.join('\n'),
        createdAt:    new Date().toISOString(),
    };

    const msgs = loadAllMessages();
    msgs.push(msg);
    saveMessages(msgs);

    const url = getGasUrl();
    if (url) postToGas(url, { action: 'addMessage', message: msg });

    closeOtherMsgDialog();
    showToast(`「${opt.dataset.name}」の連絡事項を送信しました`, 'success');
}

// ─── Delivery Collect Dialog ─────────────────────────────────────
function openDeliveryCollectDialog(groupKey) {
    const dRec = deliveryData.find(r =>
        `${r.store}|${r.dataMonth}|${r.name}|${r.address}` === groupKey
    );
    if (!dRec) return;

    document.getElementById('delivery-collect-name').textContent = dRec.name;

    const personRecords = allData.filter(r => r.name === dRec.name && r.store === dRec.store);
    const uncollected   = personRecords.filter(r => {
        const key = getKey(r);
        return !isFullyCollected(key, r) && effectiveAmount(key, r) > 0;
    });

    const list = document.getElementById('delivery-collect-list');
    if (uncollected.length === 0) {
        list.innerHTML = '<div class="delivery-collect-empty">未集金レコードはありません</div>';
    } else {
        // 表示されている月だけをソートしてインデックスで色を割り当て
        const monthOrder = [...new Set(uncollected.map(r => r.dataMonth))].sort();
        const totalAmt = uncollected.reduce((s, r) => s + effectiveAmount(getKey(r), r), 0);
        list.innerHTML = uncollected.map(r => {
            const key      = getKey(r);
            const amt      = effectiveAmount(key, r);
            const colorIdx = monthOrder.indexOf(r.dataMonth);
            return `<div class="delivery-collect-row dcm-row-${colorIdx}" data-key="${escHtml(key)}" data-amount="${amt}">
                <div class="dcm-main-row">
                    <span class="delivery-collect-month">${escHtml(r.dataMonth)}月</span>
                    <span class="delivery-collect-amount">¥${amt.toLocaleString()}</span>
                    <button class="btn dcm-btn-calc dcm-calc-open" data-amount="${amt}" data-label="${escHtml(r.dataMonth)}月分" data-key="${escHtml(key)}">計算</button>
                    <button class="btn btn-collect-month dcm-btn-${colorIdx}" data-key="${escHtml(key)}">集金済みにする</button>
                </div>
            </div>`;
        }).join('');

        // まとめて集金エリア（2件以上のときのみ表示）
        if (uncollected.length >= 2) {
            list.insertAdjacentHTML('beforeend', `
                <div class="dcm-bulk-section">
                    <div class="dcm-bulk-main">
                        <span class="dcm-bulk-label">合計</span>
                        <span class="dcm-bulk-total">¥${totalAmt.toLocaleString()}</span>
                        <button class="btn dcm-btn-calc dcm-bulk-calc-open">計算</button>
                        <button class="btn dcm-btn-bulk-collect">まとめて集金</button>
                    </div>
                </div>`);
        }

        // 計算ボタン → 計算パネルへ切り替え
        list.querySelectorAll('.dcm-calc-open').forEach(btn => {
            btn.addEventListener('click', () => {
                openDcmCalcDialog(btn.dataset.label, parseInt(btn.dataset.amount) || 0, btn.dataset.key || null);
            });
        });

        list.querySelectorAll('.btn-collect-month').forEach(btn => {
            btn.addEventListener('click', () => {
                // 配達表でルート変更済みの場合は変更後のルート、未変更の場合は配達レコードのルートを引き継ぐ
                // （前月データなどルートが異なる月の集金も、現在の配達ルートで管理画面に計上されるようにする）
                const activeOverride = deliveryRouteOverrides[groupKey];
                onCheck(btn.dataset.key, true, activeOverride?.route ?? dRec.route);
                btn.closest('.delivery-collect-row').remove();
                // 残り1件以下になったらまとめて集金エリアを非表示
                const remaining = list.querySelectorAll('.delivery-collect-row').length;
                const bulkSection = list.querySelector('.dcm-bulk-section');
                if (bulkSection) bulkSection.classList.toggle('hidden', remaining < 2);
                if (remaining === 0) {
                    list.innerHTML = '<div class="delivery-collect-empty">未集金レコードはありません</div>';
                }
            });
        });

        // まとめて計算ボタン → ダイアログを開く
        const bulkCalcBtn = list.querySelector('.dcm-bulk-calc-open');
        if (bulkCalcBtn) {
            bulkCalcBtn.addEventListener('click', () => {
                openDcmCalcDialog('合計', totalAmt, null, true);
            });
        }

        // まとめて集金ボタン
        const bulkCollectBtn = list.querySelector('.dcm-btn-bulk-collect');
        if (bulkCollectBtn) {
            bulkCollectBtn.addEventListener('click', () => {
                const activeOverride = deliveryRouteOverrides[groupKey];
                list.querySelectorAll('.delivery-collect-row').forEach(row => {
                    onCheck(row.dataset.key, true, activeOverride?.route ?? dRec.route);
                });
                list.innerHTML = '<div class="delivery-collect-empty">未集金レコードはありません</div>';
            });
        }
    }

    // パネルを必ずリスト表示にリセットしてから開く
    document.getElementById('dcm-list-panel')?.classList.remove('hidden');
    document.getElementById('dcm-calc-panel')?.classList.add('hidden');
    document.getElementById('delivery-collect-dialog').showModal();
}

function closeDeliveryCollectDialog() {
    document.getElementById('delivery-collect-dialog').close();
}

function openDcmCalcDialog(label, amount, key, isBulk = false) {
    document.getElementById('dcm-calc-title').textContent = `💰 計算 — ${label}`;
    document.getElementById('dcm-calc-dlg-amount').textContent = `¥${amount.toLocaleString()}`;
    document.getElementById('dcm-calc-dlg-expected').value = amount;
    document.getElementById('dcm-calc-dlg-key').value = key || '';
    document.getElementById('dcm-calc-dlg-collect').dataset.bulk = isBulk ? '1' : '';
    const inp = document.getElementById('dcm-calc-dlg-input');
    inp.value = '';
    const otsuriEl = document.getElementById('dcm-calc-dlg-otsuri');
    otsuriEl.textContent = '—';
    otsuriEl.className = 'dcm-otsuri-val';
    document.getElementById('dcm-list-panel').classList.add('hidden');
    document.getElementById('dcm-calc-panel').classList.remove('hidden');
    inp.focus();
}

function closeDcmCalcPanel() {
    document.getElementById('dcm-calc-panel').classList.add('hidden');
    document.getElementById('dcm-list-panel').classList.remove('hidden');
}

function collectFromCalcPanel() {
    const collectBtn = document.getElementById('dcm-calc-dlg-collect');
    const isBulk     = collectBtn.dataset.bulk === '1';
    const list       = document.getElementById('delivery-collect-list');
    if (isBulk) {
        // まとめて集金：全行の集金済みにするボタンを順に実行
        list.querySelector('.dcm-btn-bulk-collect')?.click();
    } else {
        const key = document.getElementById('dcm-calc-dlg-key').value;
        if (!key) return;
        const row = list.querySelector(`.delivery-collect-row[data-key="${key}"]`);
        row?.querySelector('.btn-collect-month')?.click();
    }
    closeDcmCalcPanel();
}

// 計算パネル内 お釣り計算（グローバルに1回だけ登録）
const _dcmInput = document.getElementById('dcm-calc-dlg-input');
if (_dcmInput) {
    _dcmInput.addEventListener('input', () => {
        const inp     = document.getElementById('dcm-calc-dlg-input');
        const amt     = parseInt(document.getElementById('dcm-calc-dlg-expected').value) || 0;
        const azukari = parseInt(inp.value.replace(/[^\d]/g, '')) || 0;
        const otsuri  = azukari - amt;
        const valEl   = document.getElementById('dcm-calc-dlg-otsuri');
        if (inp.value === '') {
            valEl.textContent = '—';
            valEl.className   = 'dcm-otsuri-val';
        } else if (otsuri < 0) {
            valEl.textContent = `不足 ${Math.abs(otsuri).toLocaleString()}円`;
            valEl.className   = 'dcm-otsuri-val dcm-otsuri-ng';
        } else {
            valEl.textContent = `${otsuri.toLocaleString()}円`;
            valEl.className   = 'dcm-otsuri-val dcm-otsuri-ok';
        }
    });
}

// ─── 文字サイズ選択 ───────────────────────────────────────────────
const FS_KEY = 'app-font-size';

function setFontSize(size) {
    document.documentElement.setAttribute('data-size', size);
    localStorage.setItem(FS_KEY, size);
    document.querySelectorAll('.fs-btn').forEach(b => {
        b.classList.toggle('fs-active', b.dataset.size === size);
    });
}

// 起動時に保存済みサイズを適用
(function () {
    const saved = localStorage.getItem(FS_KEY) || '中';
    setFontSize(saved);
})();

// ─── Admin Tab ───────────────────────────────────────────────────
function labelClass(label) {
    const map = { '新規': 'cyan', '翌週注文確認': 'red', '注文確認': 'red', '再注文': 'beige', '集金': 'yellow' };
    return map[label] || 'default';
}

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

        const moItems = dateItems.filter(({ record: rec, _effectiveRoute }) => rec.dataMonth === mo && (_effectiveRoute ?? rec.route) > 0);

        html += `<tr class="month-subtotal-row">`;
        html += `<th class="row-header clickable-row" data-toggle-id="${safeId}" onclick="toggleMonthDetail('${safeId}')">${moLabel} ▶</th>`;
        for (const r of routes) {
            const amt     = (routeMonthData[r]?.[mo]) || 0;
            moRowTotal   += amt;
            const rItems  = moItems.filter(({ _effectiveRoute, record: rec }) => (_effectiveRoute ?? rec.route) === r);
            const safeRId = `${safeId}r${r}`;
            if (amt > 0 && rItems.length > 0) {
                html += `<td class="has-value clickable-cell" data-toggle-id="${safeRId}" onclick="toggleRouteDetail('${safeRId}')">${fmt(amt)} ▶</td>`;
            } else {
                html += `<td class="${amt > 0 ? 'has-value' : 'empty-cell'}">${amt > 0 ? fmt(amt) : '-'}</td>`;
            }
        }
        html += `<td class="total-cell">${fmt(moRowTotal)}</td></tr>`;

        for (const r of routes) {
            const rItems = moItems.filter(({ _effectiveRoute, record: rec }) => (_effectiveRoute ?? rec.route) === r);
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
                        html += `<div class="detail-item" data-key="${escHtml(key)}">`;
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

    // 手持ち現金行（現金精査ボタン付き）
    let cashTotal = 0;
    const denomSt = loadDenomStorage();
    html += `<tr class="cash-row"><th class="row-header">手持ち現金</th>`;
    for (const r of routes) {
        const ck   = `${date}|${r}`;
        const ca   = changeAmounts[ck] !== undefined ? changeAmounts[ck] : 12220;
        const cash = (routeTotals[r] || 0) + ca;
        cashTotal += cash;
        let seisaHtml = '';
        if ((routeTotals[r] || 0) > 0) {
            const dd = denomSt[`${date}|${r}`] || null; // GAS同期済みデータをそのまま使用
            let seisaStatus = `<div class="seisa-status seisa-none">未実施</div>`;
            if (dd) {
                const denomTotal  = calcDenomTotal(dd.counts);
                // 精査保存時の expected を比較基準にする（スマホ入力時の手持ち現金と一致させるため）
                const seisaTarget = (dd.expected > 0) ? dd.expected : cash;
                const diff        = denomTotal - seisaTarget;
                const savedTimeStr = dd.savedAt
                    ? new Date(dd.savedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                    : '';
                if (diff === 0) {
                    seisaStatus = `<div class="seisa-status seisa-ok">合致 ✓<br><small class="seisa-time">${savedTimeStr}</small></div>`;
                } else {
                    const sign = diff > 0 ? '+' : '−';
                    seisaStatus = `<div class="seisa-status seisa-ng">合致せず<br><span class="seisa-diff">${sign}${fmt(Math.abs(diff))}円</span><br><small class="seisa-time">${savedTimeStr}</small></div>`;
                }
            }
            seisaHtml = `<button class="btn-seisa" onclick="openDenomDialog('${date}', ${r}, ${routeTotals[r] || 0}, ${ca})">現金精査</button>${seisaStatus}`;
        }
        // 精査済みの場合は保存時の expected（スマホの手持ち現金）を表示する
        const denomSaved = denomSt[`${date}|${r}`];
        const displayCash = (denomSaved?.expected > 0) ? denomSaved.expected : cash;
        html += `<td class="cash-cell" data-cash-key="${ck}"><div class="cash-amount">${fmt(displayCash)}</div>${seisaHtml}</td>`;
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
                postToGas(url, {
                    action:    'updateAmount',
                    key,
                    amount:    raw,
                    oldAmount: current,
                    record:    { ...record, key },
                    updatedAt: new Date().toISOString(),
                });
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

    const routeFilter = parseInt(filters.route) || 0;
    const srcRecords = storeVal ? allData.filter(r => r.store === storeVal) : allData;
    const allRoutes = [...new Set(srcRecords.map(r => r.route).filter(r => r > 0))].sort((a, b) => a - b);
    const routes = routeFilter > 0 ? [routeFilter] : allRoutes;

    // 集金データを日付でグループ化
    const checkedItems = [];
    for (const [key, state] of Object.entries(checked)) {
        if (!state?.checkedAt) continue;
        // allData に存在しない場合はスナップショットで代替（data.js 更新後も履歴を保持）
        const record = allData.find(r => getKey(r) === key) || state.snapshot || null;
        if (!record) continue;
        if (storeVal && record.store !== storeVal) continue;
        const effectiveRte = state.routeOverride || currentRouteMap[record.store + '|' + record.name] || record.route;
        if (routeFilter > 0 && effectiveRte !== routeFilter) continue;
        checkedItems.push({ key, record, state });
    }

    const byDateRouteMonth = {};
    const byDate = {};
    for (const item of checkedItems) {
        const { key, record, state } = item;
        const d  = toJSTDate(state.checkedAt) || '不明';
        const effectiveRte = state.routeOverride || currentRouteMap[record.store + '|' + record.name] || record.route;
        const r  = effectiveRte > 0 ? effectiveRte : null;
        const mo = record.dataMonth || '不明';
        if (!r) continue;
        if (!byDateRouteMonth[d]) byDateRouteMonth[d] = {};
        if (!byDateRouteMonth[d][r]) byDateRouteMonth[d][r] = {};
        byDateRouteMonth[d][r][mo] = (byDateRouteMonth[d][r][mo] || 0) + effectiveAmount(key, record);
        if (!byDate[d]) byDate[d] = [];
        byDate[d].push({ ...item, _effectiveRoute: r });
    }

    // 連絡事項を日付でグループ化
    const allMsgs = loadAllMessages();
    let filteredMsgs = storeVal ? allMsgs.filter(m => m.store === storeVal) : allMsgs;
    if (routeFilter > 0) filteredMsgs = filteredMsgs.filter(m => parseInt(m.route) === routeFilter);
    const msgsByDate = {};
    filteredMsgs.forEach(m => {
        const parsed = m.createdAt ? new Date(m.createdAt) : null;
        const dk = (parsed && !isNaN(parsed)) ? parsed.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }) : 'unknown';
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

    // 明細行ダブルタップ → row-edit-dialog
    let _adminLastTapKey = null, _adminLastTapTime = 0;
    content.querySelectorAll('.detail-item[data-key]').forEach(item => {
        item.addEventListener('dblclick', e => {
            if (e.target.closest('input, button')) return;
            openRowEdit(item.dataset.key);
        });
        item.addEventListener('click', e => {
            if (e.target.closest('input, button, .editable-amount')) return;
            const now = Date.now();
            if (_adminLastTapKey === item.dataset.key && now - _adminLastTapTime < 400) {
                openRowEdit(item.dataset.key);
                _adminLastTapKey = null;
            } else {
                _adminLastTapKey = item.dataset.key;
                _adminLastTapTime = now;
            }
        });
    });

    // 連絡事項チェックボックス
    content.querySelectorAll('.admin-msg-check').forEach(cb => {
        cb.addEventListener('change', () => {
            const s = loadMsgRead();
            if (cb.checked) s.add(cb.dataset.msgId); else s.delete(cb.dataset.msgId);
            saveMsgRead(s);
            // GAS に既読状態を同期
            const url = getGasUrl();
            if (url) {
                fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'text/plain' },
                    body: JSON.stringify({ action: 'saveMsgRead', ids: [...s], savedAt: new Date().toISOString() }),
                }).catch(() => {});
            }
            cb.closest('.admin-msg-item').classList.toggle('admin-msg-item-read', cb.checked);
        });
    });
}

// ─── Denomination Check Dialog ───────────────────────────────────
function openDenomDialog(date, route, base, ca) {
    currentDenomDate  = date;
    currentDenomRoute = route;

    // 手持ち現金の目標額を決定
    // ① 保存済みの expected があればそれを使用（スマホ・PC 間で一致させる）
    // ② 未保存なら引数 base（集金合計）＋ ca（釣銭）で計算
    const cashKey  = `${date}|${route}`;
    const saved    = loadDenomStorage()[cashKey];
    const _ca      = (ca !== undefined) ? ca : (getChangeAmounts()[cashKey] !== undefined ? getChangeAmounts()[cashKey] : 12220);
    const expected = (saved?.expected > 0) ? saved.expected : ((base || 0) + _ca);

    const [, m, day] = date.split('-');
    document.getElementById('denom-title').textContent = `💰 現金精査（${parseInt(m)}月${parseInt(day)}日　R${route}）`;
    document.getElementById('denom-expected-amount').textContent = '¥' + fmt(expected);
    document.getElementById('denom-expected-val').value = expected;

    const counts = saved?.counts || {};

    // 紙幣・硬貨パネルを描画
    const renderPanel = (containerId, values) => {
        document.getElementById(containerId).innerHTML = values.map(v => {
            const d = DENOMINATIONS.find(d => d.value === v);
            return `<div class="denom-item">
                <span class="denom-lbl">${d.label}</span>
                <input type="text" inputmode="numeric" class="denom-input"
                    data-value="${v}" value="${counts[v] || ''}" placeholder="0">
                <span class="denom-sub" id="denom-sub-${v}">${counts[v] ? '¥' + fmt(v * counts[v]) : '—'}</span>
            </div>`;
        }).join('');
    };
    renderPanel('denom-bills', [10000, 5000, 1000]);
    renderPanel('denom-coins', [500, 100, 50, 10, 5, 1]);

    document.querySelectorAll('.denom-input').forEach(inp => {
        inp.addEventListener('input', updateDenomCalc);
        inp.addEventListener('focus', () => { if (inp.value === '0') inp.value = ''; });
    });

    updateDenomCalc();
    document.getElementById('denom-dialog').showModal();
}

function updateDenomCalc() {
    let total = 0;
    document.querySelectorAll('.denom-input').forEach(inp => {
        const count = parseInt(inp.value.replace(/[^\d]/g, '')) || 0;
        const denom = parseInt(inp.dataset.value);
        const sub   = count * denom;
        total += sub;
        const subCell = document.getElementById(`denom-sub-${denom}`);
        if (subCell) subCell.textContent = count > 0 ? '¥' + fmt(sub) : '—';
    });
    const expected = parseInt(document.getElementById('denom-expected-val').value) || 0;
    const diff     = total - expected;
    document.getElementById('denom-total').textContent = '¥' + fmt(total);
    const diffEl = document.getElementById('denom-diff');
    if (diff === 0) {
        diffEl.textContent = '合致 ✓';
        diffEl.className   = 'denom-diff-ok';
    } else {
        const sign = diff > 0 ? '+' : '−';
        diffEl.textContent = `合致せず　${sign}${fmt(Math.abs(diff))}円`;
        diffEl.className   = 'denom-diff-ng';
    }
}

function closeDenomDialog() {
    document.getElementById('denom-dialog').close();
    currentDenomDate  = null;
    currentDenomRoute = null;
}

function saveDenomDialog() {
    const counts = {};
    document.querySelectorAll('.denom-input').forEach(inp => {
        const val = parseInt(inp.value.replace(/[^\d]/g, '')) || 0;
        if (val > 0) counts[inp.dataset.value] = val;
    });
    const storage  = loadDenomStorage();
    const expected = parseInt(document.getElementById('denom-expected-val').value) || 0;
    const key = `${currentDenomDate}|${currentDenomRoute}`;
    storage[key] = { counts, expected, savedAt: new Date().toISOString() };
    saveDenomStorage(storage);

    // GAS に送信して他端末と共有
    const url = getGasUrl();
    if (url) {
        postToGas(url, {
            action: 'saveDenom',
            key,
            data: { counts, expected, savedAt: storage[key].savedAt, date: currentDenomDate, route: currentDenomRoute }
        });
    }

    closeDenomDialog();
    renderAdmin();
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
        const k = getKey(r);
        if (filters.route && String(effectiveRoute(k, r)) !== filters.route) return false;
        return true;
    });
    // 重複除去（同名・同店・同ルート）— 月をまたいで同一顧客は1件のみ
    const seen = new Set();
    const unique = customers.filter(r => {
        const k = getKey(r);
        const dedupeKey = `${r.store}|${effectiveRoute(k, r)}|${r.name}`;
        if (seen.has(dedupeKey)) return false;
        seen.add(dedupeKey);
        return true;
    });

    // 集金リストと同じ順番（seqはallDataの並び順と一致）
    unique.sort((a, b) => (a.seq || 0) - (b.seq || 0));

    // 「その他」用に現在フィルター中の店舗・ルートを特定
    const storeForOther = filters.store || '';
    const routeForOther = filters.route || '';
    const otherLabel = routeForOther ? `R${routeForOther} その他` : 'その他';

    sel.innerHTML = '<option value="">顧客を選択してください</option>' +
        unique.map(r => {
            const k = getKey(r);
            const rte = effectiveRoute(k, r);
            return `<option value="${k}" data-store="${escHtml(r.store)}" data-route="${rte}" data-name="${escHtml(r.name)}">R${rte} ${r.name}（${r.store}）</option>`;
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
        const dk = m.createdAt ? new Date(m.createdAt).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }) : '';
        if (!groups[dk]) groups[dk] = [];
        groups[dk].push(m);
    });

    list.innerHTML = Object.keys(groups).sort((a, b) => b.localeCompare(a)).map(dk => {
        const label = new Date(dk + 'T12:00:00').toLocaleDateString('ja-JP',
            { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short' });
        const items = groups[dk].map(m => {
            const imgHtml = m.imageData
                ? `<img src="${m.imageData}" class="msg-image-thumb" alt="添付画像">`
                : '';
            return `
            <div class="msg-item">
                <div class="msg-item-meta">
                    <span class="msg-item-route">R${m.route}</span>
                    <span class="msg-item-name">${escHtml(m.customerName)}</span>
                    <span style="font-size:12px;color:var(--g500)">${escHtml(m.store)}</span>
                    <span class="msg-item-date">${fmtMsgTime(m.createdAt)}</span>
                </div>
                <div class="msg-item-text">${escHtml(m.text)}${imgHtml}</div>
                <button class="msg-item-del" onclick="deleteMessage('${m.id}')">削除</button>
            </div>`;
        }).join('');
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
    // 報告内容セレクトは常に表示
}

function onNoReportChange() {
    const checked = document.getElementById('msg-no-report-check').checked;
    document.getElementById('msg-detail-fields').classList.toggle('hidden', checked);
}

function submitDeliveryNoReport() {
    if (!document.getElementById('delivery-no-report-check').checked) {
        alert('「連絡事項なし」にチェックを入れてください');
        return;
    }
    const msg = {
        id:           Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        store:        filters.store || '',
        route:        parseInt(filters.route) || 0,
        customerKey:  '',
        customerName: 'なし',
        text:         '連絡事項なし',
        createdAt:    new Date().toISOString(),
    };
    const msgs = loadAllMessages();
    msgs.push(msg);
    saveMessages(msgs);
    const url = getGasUrl();
    if (url) postToGas(url, { action: 'addMessage', message: msg });
    document.getElementById('delivery-no-report-check').checked = false;
    showToast('連絡事項なしを送信しました', 'success');
}

function submitMessage() {
    const noReport = document.getElementById('msg-no-report-check').checked;
    const sel      = document.getElementById('msg-customer-select');
    const typeSel  = document.getElementById('msg-type-select');
    const freeText = document.getElementById('msg-textarea').value.trim();

    let store, route, name, typeVal;

    if (noReport) {
        store   = filters.store || '';
        route   = filters.route || '';
        name    = 'なし';
        typeVal = '連絡事項なし';
    } else {
        typeVal = typeSel.value;
        if (!typeVal && !freeText) { alert('報告内容を選択するか、自由入力欄に入力してください'); return; }
        if (!sel.value) { alert('顧客を選択してください'); return; }
        const opt = sel.selectedOptions[0];
        store = opt.dataset.store;
        route = opt.dataset.route;
        name  = opt.dataset.name;
    }

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

    document.getElementById('msg-no-report-check').checked = false;
    document.getElementById('msg-detail-fields').classList.remove('hidden');
    typeSel.value = '';
    document.getElementById('msg-textarea').value = '';

    // GAS 送信
    const url = getGasUrl();
    if (url) postToGas(url, { action: 'addMessage', message: msg });

    renderMsgTab();
}

function deleteMessage(id) {
    if (!confirm('この連絡事項を削除しますか？')) return;
    const msgs = loadAllMessages().filter(m => m.id !== id);
    saveMessages(msgs);

    const url = getGasUrl();
    if (url) postToGas(url, { action: 'removeMessage', messageId: id });

    renderMsgTab();
    if (typeof renderAdmin === 'function') renderAdmin();
}

// ─── 連絡事項 インライン編集 ──────────────────────────────────────
function handleMsgTouchEnd(e, el, id) {
    const now  = Date.now();
    const last = parseInt(el.dataset.lastTap || 0);
    if (now - last < 350) {
        e.preventDefault();
        startEditMessage(el, id);
    }
    el.dataset.lastTap = now;
}

function startEditMessage(el, id) {
    if (el.querySelector('textarea')) return; // 編集中なら無視
    const original = loadAllMessages().find(m => m.id === id)?.text || '';
    el.dataset.origHtml = el.innerHTML;
    el.innerHTML =
        `<textarea class="msg-edit-textarea">${escHtml(original)}</textarea>` +
        `<div class="msg-edit-actions">` +
        `<button class="msg-edit-save" onclick="saveEditMessage('${id}',this)">保存</button>` +
        `<button class="msg-edit-cancel" onclick="cancelEditMessage(this)">キャンセル</button>` +
        `</div>`;
    el.querySelector('textarea').focus();
}

function saveEditMessage(id, btn) {
    const el      = btn.closest('.admin-msg-item-text');
    const newText = el.querySelector('textarea').value.trim();
    if (!newText) return;

    const msgs = loadAllMessages();
    const msg  = msgs.find(m => m.id === id);
    if (!msg) return;
    msg.text = newText;
    saveMessages(msgs);

    // 保存ボタンをすぐ消して更新後テキストを表示
    el.innerHTML = escHtml(newText);

    const url = getGasUrl();
    if (url) postToGas(url, { action: 'updateMessage', messageId: id, text: newText });

    showToast('連絡事項を保存しました', 'success');
    renderMsgTab();
    if (typeof renderAdmin === 'function') renderAdmin();
}

function cancelEditMessage(btn) {
    const el = btn.closest('.admin-msg-item-text');
    el.innerHTML = el.dataset.origHtml || '';
}

function buildDailyMessages(date, msgs) {
    const parts = date.split('-');
    const dateLabel = (parts.length === 3 && parts[1] && parts[2])
        ? `${parseInt(parts[1])}月${parseInt(parts[2])}日`
        : '日時不明';
    const sorted = [...msgs].sort((a, b) =>
        (Number(a.route) - Number(b.route)) || a.createdAt.localeCompare(b.createdAt)
    );

    const msgRead = loadMsgRead();
    let html = `<div class="admin-section">`;
    html += `<h2 class="admin-title">&#128172; ${dateLabel}の連絡事項</h2>`;
    html += `<div class="admin-msg-store">`;
    sorted.forEach(m => {
        const isRead = msgRead.has(m.id);
        const imgHtml = m.imageData
            ? `<img src="${m.imageData}" class="msg-image-thumb" alt="添付画像" style="margin-top:6px">`
            : '';
        html += `<div class="admin-msg-item${isRead ? ' admin-msg-item-read' : ''}">
            <input type="checkbox" class="admin-msg-check" data-msg-id="${escHtml(m.id)}"${isRead ? ' checked' : ''}>
            <div class="admin-msg-item-body">
                <div class="admin-msg-item-meta">
                    <span class="admin-msg-item-route">R${m.route}</span>
                    <span class="admin-msg-item-name">${escHtml(m.customerName)}</span>
                    <span style="font-size:12px;color:var(--g500)">${escHtml(m.store)}</span>
                    <span class="admin-msg-item-date">${fmtMsgTime(m.createdAt)}</span>
                    <button class="msg-item-del" onclick="deleteMessage('${m.id}')">削除</button>
                </div>
                <div class="admin-msg-item-text" data-msg-id="${escHtml(m.id)}"
                    ondblclick="startEditMessage(this,'${m.id}')"
                    ontouchend="handleMsgTouchEnd(event,this,'${m.id}')"
                >${escHtml(m.text)}${imgHtml}</div>
            </div>
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
        const res  = await fetch(url + '?t=' + Date.now());
        const json = await res.json();
        if (json.ok === false) { console.error('GAS同期エラー', json.error); return; }
        // 新形式（checkedData）と旧形式（checkedKeys）の両方に対応
        if (!json.checkedData && !json.checkedKeys && json.transferData === undefined) return;

        // 期限切れのdirtyキーをクリア
        cleanDirty();

        if (json.checkedData) {
            // リモート優先でマージ（ただしdirtyキーはローカル変更を優先）
            const remote = json.checkedData;
            Object.entries(remote).forEach(([key, val]) => {
                if (dirtyKeys.has(key)) return; // 送信直後のキーは上書きしない
                if (!checked[key]) {
                    // リモートから追加（スナップショットなし）
                    // collectDate がある場合はそれを checkedAt の基準にする（今日同期しても正しい日付に表示される）
                    checked[key] = { checkedAt: val.collectDate || new Date().toISOString(), collectDate: val.collectDate || '', collectedAmount: val.collectedAmount || 0 };
                } else {
                    // 既存エントリはスナップショットを保持しつつ、collectDate・collectedAmount を補完
                    if (!checked[key].collectDate && val.collectDate) {
                        checked[key].collectDate = val.collectDate;
                    }
                    if (val.collectedAmount && !checked[key].collectedAmount) {
                        checked[key].collectedAmount = val.collectedAmount;
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

        // 振込入金の同期（スプレッドシート削除→アプリ側も取り消し）
        if (json.transferData !== undefined) {
            const remote = json.transferData;
            let changed = false;
            Object.entries(remote).forEach(([key, val]) => {
                if (!transferState[key]) {
                    transferState[key] = { date: val.date, recordedAt: '' };
                    changed = true;
                }
            });
            Object.keys(transferState).forEach(key => {
                if (!remote[key]) { delete transferState[key]; changed = true; }
            });
            if (changed) saveTransferState();
        }

        // 口座振替の同期（スプレッドシート削除→アプリ側の完了を取り消し）
        if (json.bankData !== undefined) {
            const remote = json.bankData;
            let changed = false;
            Object.keys(remote).forEach(key => {
                // 失敗マーク済み（bankFailedKeys または bankState）は絶対に上書きしない
                if (bankFailedKeys.has(key) || bankState[key]?.status === 'failed') return;
                if (!bankState[key] || bankState[key].status !== 'completed') {
                    bankState[key] = { status: 'completed', updatedAt: '' };
                    changed = true;
                }
            });
            Object.keys(bankState).forEach(key => {
                // failed はローカル専用状態なので保持、completed のみ削除対象
                if (bankState[key]?.status === 'completed' && !remote[key]) {
                    delete bankState[key]; changed = true;
                }
            });
            if (changed) saveBankState();
        }

        saveChecked();
        renderTable();
        // 集金状態が変わった場合に管理画面の集金合計・手持ち現金を最新化
        if (currentTab === 'admin') renderAdmin();

        // 連絡事項をリモートと完全同期（リモートを正とする）
        if (Array.isArray(json.messages)) {
            const localMsgs   = loadAllMessages();
            const remoteIds   = new Set(json.messages.map(m => m.id).filter(Boolean));
            const localIds    = new Set(localMsgs.map(m => m.id));
            let changed = false;

            // リモートにしかないものをローカルに追加
            json.messages.forEach(m => {
                if (m.id && !localIds.has(m.id)) {
                    localMsgs.push({ ...m, createdAt: m.createdAt || new Date().toISOString() });
                    changed = true;
                }
            });

            // ローカルにしかないもの（スプレッドシートから削除済み）を削除
            const synced = localMsgs.filter(m => remoteIds.has(m.id));
            if (synced.length !== localMsgs.length) changed = true;

            if (changed) {
                saveMessages(synced);
                if (currentTab === 'msg') renderMsgTab();
            }
        }

        // 現金精査データ: GAS を正として上書き（スマホ→GAS→PC の流れを保証）
        // ローカルにあってGASにないキーは削除しない（GAS POST 失敗時のデータ保護）
        if (json.denomData) {
            const local = loadDenomStorage();
            let denomChanged = false;
            Object.entries(json.denomData).forEach(([key, remote]) => {
                const localEntry = local[key];
                const remoteTime = new Date(remote.savedAt  || 0).getTime();
                const localTime  = new Date(localEntry?.savedAt || 0).getTime();
                if (!localEntry || remoteTime > localTime) {
                    local[key] = remote;
                    denomChanged = true;
                }
            });
            if (denomChanged) saveDenomStorage(local);
        }

        // 手動追加レコードをリモートとマージ（GAS を正として同期）
        if (Array.isArray(json.manualData)) {
            const remoteIds = new Set(json.manualData.map(r => r.id));
            const localIds  = new Set(manualRecords.map(r => r.id));
            let manualChanged = false;

            // リモートにあってローカルにないレコードを追加
            json.manualData.forEach(r => {
                if (localIds.has(r.id)) return;
                // monthStr（例: "4月"）を dataMonth（例: "2026-04"）に変換
                let dataMonth = r.dataMonth || '';
                if (!dataMonth && r.monthStr) {
                    const mn = parseInt(r.monthStr);
                    if (!isNaN(mn)) {
                        const now = new Date();
                        const yr  = (mn > now.getMonth() + 1) ? now.getFullYear() - 1 : now.getFullYear();
                        dataMonth = `${yr}-${String(mn).padStart(2, '0')}`;
                    }
                }
                const rec = {
                    id: r.id, store: r.store, route: r.route, name: r.name,
                    address: r.address, amount: r.amount, dataMonth,
                    paymentType: r.paymentType || 'cash',
                    code: 0, seq: 9999, isManual: true, sourceFiles: ['手動追加'],
                };
                manualRecords.push(rec);
                allData.push(rec);
                manualChanged = true;
            });

            // ローカルにあってリモートにないレコードを削除（他端末で削除済み）
            const before = manualRecords.length;
            manualRecords = manualRecords.filter(r => remoteIds.has(r.id));
            allData = allData.filter(r => !r.isManual || remoteIds.has(r.id));
            if (manualRecords.length !== before) manualChanged = true;

            if (manualChanged) {
                saveManualRecords();
                renderFilters();
            }
        }

        // 口振失敗キーをリモートとマージ（GAS を正として同期）
        if (Array.isArray(json.bankFailedKeys)) {
            const remote = new Set(json.bankFailedKeys);
            let bfChanged = false;

            // リモートにあってローカルにないキーを追加
            remote.forEach(key => {
                if (!bankFailedKeys.has(key)) {
                    bankFailedKeys.add(key);
                    bankState[key] = { status: 'failed', updatedAt: '' };
                    bfChanged = true;
                }
            });

            // ローカルにあってリモートにないキーを削除（他端末で解除済み）
            [...bankFailedKeys].forEach(key => {
                if (!remote.has(key)) {
                    bankFailedKeys.delete(key);
                    if (bankState[key]?.status === 'failed') delete bankState[key];
                    bfChanged = true;
                }
            });

            if (bfChanged) {
                saveBankFailedKeys();
                saveBankState();
            }
        }

        // 連絡事項既読をリモートとマージ（ユニオン：一度既読にしたら取り消さない）
        if (Array.isArray(json.msgReadIds) && json.msgReadIds.length > 0) {
            const local = loadMsgRead();
            let msgReadChanged = false;
            json.msgReadIds.forEach(id => {
                if (!local.has(id)) { local.add(id); msgReadChanged = true; }
            });
            if (msgReadChanged) {
                saveMsgRead(local);
                if (currentTab === 'admin') renderAdmin();
            }
        }

        // ルートオーバーライドをリモートと同期（GAS を正として常に上書き）
        if (json.routeOverrides) {
            const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
            let changed = false;
            Object.entries(json.routeOverrides).forEach(([gk, ov]) => {
                if (ov.date !== today) return;
                const local = deliveryRouteOverrides[gk];
                if (!local || local.route !== ov.route) {
                    deliveryRouteOverrides[gk] = ov;
                    changed = true;
                }
            });
            if (changed) {
                localStorage.setItem(DELIVERY_ROUTE_OVERRIDE_KEY, JSON.stringify(deliveryRouteOverrides));
                if (currentTab === 'delivery') renderDelivery();
            }
        }

        // 配達済みをリモート（今日分のみ）と同期
        if (json.deliveryData !== undefined) {
            const remote = json.deliveryData;
            const dataGenAt = window.DATA_META?.generatedAt || '';
            let changed = false;
            Object.entries(remote).forEach(([key, val]) => {
                if (dirtyKeys.has(key)) return; // 直後の操作は上書きしない
                // データ更新前に配達済みにされたレコードは取り込まない
                const checkedAt = val.checkedAt || '';
                if (dataGenAt && checkedAt && checkedAt < dataGenAt) return;
                if (!deliveryChecked[key]) {
                    deliveryChecked[key] = { checkedAt: checkedAt || new Date().toISOString() };
                    changed = true;
                }
            });
            // リモートにないキー（他端末で取消済み or 昨日分）を削除
            Object.keys(deliveryChecked).forEach(key => {
                if (!remote[key] && !dirtyKeys.has(key)) {
                    delete deliveryChecked[key];
                    changed = true;
                }
            });
            if (changed) {
                saveDeliveryChecked();
                if (currentTab === 'delivery') renderDelivery();
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

    manualRecords   = loadManualRecords();
    allData         = [...window.COLLECTION_DATA, ...manualRecords];
    deliveryData    = window.DELIVERY_DATA || [];
    currentRouteMap = buildCurrentRouteMap();
    deliveryChecked        = loadDeliveryChecked();
    deliveryRouteOverrides = loadDeliveryRouteOverrides();

    // 配達表タブの表示/非表示（フィーチャーフラグ）
    const navDeliveryBtn = document.getElementById('nav-delivery');
    if (navDeliveryBtn) {
        navDeliveryBtn.style.display = window.FEATURE_DELIVERY_ENABLED ? '' : 'none';
    }
    checked         = loadChecked();
    bankState       = loadBankState();
    bankFailedKeys  = loadBankFailedKeys();
    transferState   = loadTransferState();
    amountOverrides = loadAmountOverrides();
    recordOverrides = loadRecordOverrides();

    // 集金後にExcelが0にリセットされた場合を検出（リセット運用対応）
    updateCycleReset();

    // bankFailedKeys に記録されているキーは bankState の状態に関わらず 'failed' を保証する
    bankFailedKeys.forEach(key => {
        if (!bankState[key] || bankState[key].status !== 'failed') {
            bankState[key] = { status: 'failed', updatedAt: '' };
        }
    });

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
    switchTab('delivery');

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
        if (currentTab === 'msg')      renderMsgTab();
        if (currentTab === 'admin')    renderAdmin();
        if (currentTab === 'delivery') renderDelivery();
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
        if (currentTab === 'msg')      renderMsgTab();
        if (currentTab === 'admin')    renderAdmin();
        if (currentTab === 'delivery') renderDelivery();
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
            const base      = parseInt(cashCell.dataset.base) || 0;
            const amountDiv = cashCell.querySelector('.cash-amount');
            if (amountDiv) amountDiv.textContent = fmt(base + val);
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
            if (d === date) {
                const amountDiv = cell.querySelector('.cash-amount');
                cashSum += parseInt((amountDiv ? amountDiv.textContent : cell.textContent).replace(/,/g, '')) || 0;
            }
        });
        const cashTotal = adminContent.querySelector(`[data-cash-total="${date}"]`);
        if (cashTotal) cashTotal.textContent = fmt(cashSum);
    });

    // GAS 自動同期
    syncCheckboxes();
    setInterval(syncCheckboxes, 30000);

    // 起動時にリトライキューを送信、オンライン復帰時も自動リトライ
    flushRetryQueue();
    window.addEventListener('online', flushRetryQueue);
}

// startApp は initAuth → showApp から呼ばれる（直接 DOMContentLoaded では呼ばない）

// ─── Pull to Refresh ─────────────────────────────────────────────
(function initPullToRefresh() {
    const THRESHOLD = 65;
    let startY = 0;
    let currentY = 0;
    let active = false;

    const ind = document.createElement('div');
    ind.id = 'ptr-indicator';
    ind.innerHTML = '<span id="ptr-icon">↓</span><span id="ptr-text">引っ張って更新</span>';
    document.querySelector('.app-header').insertAdjacentElement('afterend', ind);

    document.addEventListener('touchstart', e => {
        if (window.scrollY === 0) {
            startY = e.touches[0].clientY;
            currentY = startY;
            active = true;
        }
    }, { passive: true });

    document.addEventListener('touchmove', e => {
        if (!active) return;
        currentY = e.touches[0].clientY;
        const delta = currentY - startY;
        if (delta <= 0) { ind.style.height = '0px'; return; }
        ind.style.height = Math.min(delta * 0.45, 56) + 'px';
        const ready = delta >= THRESHOLD;
        ind.classList.toggle('ptr-ready', ready);
        document.getElementById('ptr-icon').textContent = ready ? '↑' : '↓';
        document.getElementById('ptr-text').textContent = ready ? '離して更新' : '引っ張って更新';
    }, { passive: true });

    document.addEventListener('touchend', () => {
        if (!active) return;
        active = false;
        const delta = currentY - startY;
        if (delta >= THRESHOLD) {
            ind.style.height = '50px';
            ind.classList.add('ptr-loading');
            document.getElementById('ptr-icon').textContent = '↻';
            document.getElementById('ptr-text').textContent = '更新中...';
            syncCheckboxes().finally(() => {
                ind.style.transition = 'height 0.3s ease';
                ind.style.height = '0px';
                setTimeout(() => {
                    ind.style.transition = '';
                    ind.classList.remove('ptr-ready', 'ptr-loading');
                }, 320);
            });
        } else {
            ind.style.transition = 'height 0.3s ease';
            ind.style.height = '0px';
            setTimeout(() => { ind.style.transition = ''; }, 320);
        }
        currentY = 0;
    }, { passive: true });
})();

// ─── 連絡事項 日付複数選択カレンダー ─────────────────────────────
let _calYear  = 0;
let _calMonth = 0; // 0-based
let _calSelectedDates = new Set(); // 'YYYY-MM-DD'

function onMsgTypeChange() {
    const val = document.getElementById('delivery-msg-type').value;
    const picker = document.getElementById('msg-date-picker');
    const imageArea = document.getElementById('msg-image-area');

    if (val === '注文' || val === 'キャンセル') {
        _calSelectedDates.clear();
        const today = new Date();
        _calYear  = today.getFullYear();
        _calMonth = today.getMonth();
        renderMsgCal();
        picker.classList.remove('hidden');
        imageArea.classList.add('hidden');
        _deliveryMsgImageData = null;
    } else if (val === '画像添付') {
        picker.classList.add('hidden');
        _calSelectedDates.clear();
        imageArea.classList.remove('hidden');
        // カメラ起動
        document.getElementById('delivery-msg-image').click();
    } else {
        picker.classList.add('hidden');
        _calSelectedDates.clear();
        imageArea.classList.add('hidden');
        _deliveryMsgImageData = null;
    }
}

function resetMsgDatePicker() {
    document.getElementById('msg-date-picker').classList.add('hidden');
    _calSelectedDates.clear();
}

function calNavMonth(delta) {
    _calMonth += delta;
    if (_calMonth > 11) { _calMonth = 0; _calYear++; }
    if (_calMonth < 0)  { _calMonth = 11; _calYear--; }
    renderMsgCal();
}

function renderMsgCal() {
    const wdays = ['日','月','火','水','木','金','土'];
    document.getElementById('msg-cal-title').textContent =
        `${_calYear}年${_calMonth + 1}月`;

    const firstDay = new Date(_calYear, _calMonth, 1).getDay();
    const daysInMonth = new Date(_calYear, _calMonth + 1, 0).getDate();
    const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });

    let html = '<div class="msg-cal-row msg-cal-weekdays">';
    wdays.forEach((d, i) => {
        html += `<div class="msg-cal-wday${i===0?' sun':i===6?' sat':''}">${d}</div>`;
    });
    html += '</div><div class="msg-cal-row">';

    for (let i = 0; i < firstDay; i++) html += '<div class="msg-cal-cell empty"></div>';

    for (let d = 1; d <= daysInMonth; d++) {
        const key = `${_calYear}-${String(_calMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const dow = (firstDay + d - 1) % 7;
        const isSelected = _calSelectedDates.has(key);
        const isToday    = key === todayStr;
        let cls = 'msg-cal-cell';
        if (dow === 0) cls += ' sun';
        if (dow === 6) cls += ' sat';
        if (isSelected) cls += ' selected';
        if (isToday)    cls += ' today';
        html += `<div class="${cls}" data-date="${key}" onclick="toggleCalDate('${key}')">${d}</div>`;
    }
    html += '</div>';

    document.getElementById('msg-cal-grid').innerHTML = html;
    renderSelectedDates();
}

function toggleCalDate(key) {
    if (_calSelectedDates.has(key)) {
        _calSelectedDates.delete(key);
    } else {
        _calSelectedDates.add(key);
    }
    renderMsgCal();
}

function renderSelectedDates() {
    const el = document.getElementById('msg-selected-dates');
    if (_calSelectedDates.size === 0) {
        el.innerHTML = '<span class="msg-no-dates">日付を選択してください</span>';
        return;
    }
    const sorted = [..._calSelectedDates].sort();
    const chips = sorted.map(d => {
        const [, m, day] = d.split('-');
        return `<span class="msg-date-chip">${parseInt(m)}/${parseInt(day)}<button type="button" class="msg-date-chip-del" onclick="toggleCalDate('${d}')">×</button></span>`;
    }).join('');
    el.innerHTML = chips;
}
