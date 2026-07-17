// ============================================================
// SCREENSHARE PRO — ADMIN PANEL (Firebase Frame-Relay)
// ============================================================

(async function() {

// ============================================================
// LOAD CONFIG
// ============================================================
let CONFIG;
try {
    const res = await fetch('config.json');
    CONFIG = await res.json();
} catch (e) {
    document.body.innerHTML = '<div style="padding:40px;text-align:center;color:#ef4444;background:#0f172a;"><h2>Chyba načítání konfigurace</h2><p>Nelze načíst config.json</p></div>';
    return;
}

// ============================================================
// SECURITY CONTEXT CHECK
// ============================================================
if (!window.isSecureContext || !crypto.subtle) {
    document.body.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:40px;text-align:center;background:#0f172a;color:white;font-family:sans-serif;">' +
        '<div style="font-size:48px;margin-bottom:16px;">🔒</div>' +
        '<h2 style="color:#ef4444;margin:0 0 8px 0;">Требуется HTTPS / localhost</h2>' +
        '<p style="color:#94a3b8;max-width:420px;line-height:1.6;">Шифрование требует безопасного соединения. Откройте страницу через <strong>localhost</strong> или <strong>HTTPS</strong>.</p>' +
        '<code style="background:#1e293b;padding:10px 20px;border-radius:6px;color:#38bdf8;font-size:14px;margin-top:12px;">python -m http.server 8080</code>' +
        '<p style="color:#64748b;font-size:13px;margin-top:16px;">Затем откройте: <strong>http://localhost:8080/admin.html</strong></p>' +
        '</div>';
    return;
}

// ============================================================
// FIREBASE INIT
// ============================================================
firebase.initializeApp(CONFIG.firebase);
const db = firebase.database();

// ============================================================
// DOM REFS
// ============================================================
const roomInput = document.getElementById('roomInput');
const connectBtn = document.getElementById('connectBtn');
const statusBadge = document.getElementById('statusBadge');
const errorMsg = document.getElementById('errorMsg');
const screenImage = document.getElementById('screenImage');
const placeholder = document.getElementById('placeholder');
const overlay = document.getElementById('overlay');
const overlayInfo = document.getElementById('overlayInfo');

// ============================================================
// CRYPTO HELPERS
// ============================================================
function base64ToArrayBuffer(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
}
function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}

async function deriveKey(pin, saltB64) {
    const salt = base64ToArrayBuffer(saltB64);
    const enc = new TextEncoder();
    const km = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' },
        km,
        { name: 'AES-GCM', length: 256 },
        false,
        ['decrypt']
    );
}

async function decryptFrame(key, ivB64, dataB64) {
    const iv = base64ToArrayBuffer(ivB64);
    const encrypted = base64ToArrayBuffer(dataB64);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
}

// ============================================================
// STATE
// ============================================================
const S = {
    code: null,
    isConnected: false,
    isConnecting: false,
    aesKey: null,
    roomRef: null,
    frameRef: null,
    frameListener: null,
    frameVersion: 0,
};

// ============================================================
// UI
// ============================================================
function setStatus(text, type) {
    statusBadge.textContent = text;
    statusBadge.className = 'status-badge';
    if (type === 'active') statusBadge.classList.add('active');
    else if (type === 'error') statusBadge.classList.add('error');
}
function showError(msg) { errorMsg.textContent = msg; errorMsg.classList.add('visible'); }
function hideError() { errorMsg.classList.remove('visible'); errorMsg.textContent = ''; }

// ============================================================
// ROOM POLLING
// ============================================================
function pollForRoom(roomId, maxWait = 90000) {
    return new Promise((resolve) => {
        const start = Date.now();
        let timer;
        function check() {
            if (Date.now() - start > maxWait) { resolve(false); return; }
            db.ref('rooms/' + roomId).once('value').then(s => {
                if (s.exists()) { resolve(true); }
                else { timer = setTimeout(check, 1500); }
            }).catch(() => { timer = setTimeout(check, 1500); });
        }
        check();
        S.pollTimer = { cancel: () => { clearTimeout(timer); resolve(false); } };
    });
}

// ============================================================
// DISCONNECT
// ============================================================
function disconnect() {
    // Clean up frame listener
    if (S.frameListener && S.frameRef) {
        S.frameRef.off('value', S.frameListener);
    }
    if (S.pollTimer) {
        S.pollTimer.cancel();
        S.pollTimer = null;
    }

    // Reset state
    S.code = null;
    S.isConnected = false;
    S.isConnecting = false;
    S.aesKey = null;
    S.roomRef = null;
    S.frameRef = null;
    S.frameListener = null;
    S.frameVersion = 0;

    // Reset UI
    screenImage.src = '';
    screenImage.classList.remove('visible');
    connectBtn.textContent = 'Подключиться';
    connectBtn.classList.remove('connected');
    connectBtn.disabled = false;
    placeholder.classList.remove('hidden');
    overlay.classList.remove('visible');
    setStatus('Статус: Отключен', '');
    hideError();
}

// ============================================================
// CONNECT
// ============================================================
async function connectToCode(code) {
    if (S.isConnecting) return;
    if (!/^\d{4}$/.test(code)) { showError('Введите 4 цифры'); roomInput.focus(); return; }
    disconnect();
    hideError();
    S.isConnecting = true;
    S.code = code;
    connectBtn.disabled = true;
    connectBtn.textContent = 'Подключение...';
    setStatus('Проверка кода...', '');

    try {
        // Check if room exists
        const roomRef = db.ref('rooms/' + code);
        let roomSnap = await roomRef.once('value');
        let roomData = roomSnap.val();

        if (!roomSnap.exists()) {
            setStatus('Ожидание хоста...', '');
            const found = await pollForRoom(code);
            if (!found) throw new Error('Хост не найден. Убедитесь, что клиент запустил трансляцию.');
            roomSnap = await roomRef.once('value');
            roomData = roomSnap.val();
        }

        // Read salt for key derivation
        const saltB64 = roomData && roomData.salt;
        if (!saltB64) throw new Error('Ошибка: соль не найдена');

        S.roomRef = roomRef;

        // Derive AES decryption key from PIN + salt
        S.aesKey = await deriveKey(code, saltB64);
        console.log('[admin] AES key derived');

        // Start listening for frames
        S.frameRef = roomRef.child('frame');
        S.frameListener = S.frameRef.on('value', snap => {
            const data = snap.val();
            if (!data || !data.iv || !data.data) return;

            // Track frame version to discard stale decodes
            const thisVersion = ++S.frameVersion;

            decryptFrame(S.aesKey, data.iv, data.data).then(decrypted => {
                // If a newer frame has already arrived, skip this one
                if (thisVersion !== S.frameVersion) return;

                // Convert to base64 data URL and display
                const b64 = arrayBufferToBase64(decrypted);
                screenImage.src = 'data:image/jpeg;base64,' + b64;
                screenImage.classList.add('visible');
                placeholder.classList.add('hidden');
                overlay.classList.add('visible');
                overlayInfo.textContent = 'Код: ' + code;
                setStatus('Трансляция', 'active');

                if (!S.isConnected) {
                    S.isConnected = true;
                    S.isConnecting = false;
                    connectBtn.textContent = 'Отключиться';
                    connectBtn.classList.add('connected');
                    connectBtn.disabled = false;
                }
            }).catch(err => {
                console.error('[admin] decrypt error:', err);
            });
        });

        // Store recent codes
        const recent = JSON.parse(localStorage.getItem('admin_recent') || '[]');
        const filtered = recent.filter(c => c !== code);
        filtered.unshift(code);
        localStorage.setItem('admin_recent', JSON.stringify(filtered.slice(0, 4)));

        setStatus('Ожидание потока...', '');

    } catch (err) {
        console.error(err);
        S.isConnecting = false;
        connectBtn.disabled = false;
        connectBtn.textContent = 'Подключиться';
        connectBtn.classList.remove('connected');
        setStatus('Ошибка', 'error');
        showError(err.message || 'Ошибка подключения');
    }
}

// ============================================================
// EVENTS
// ============================================================
connectBtn.addEventListener('click', () => {
    if (S.isConnected) disconnect();
    else connectToCode(roomInput.value.trim());
});
roomInput.addEventListener('input', () => {
    roomInput.value = roomInput.value.replace(/\D/g, '').slice(0, 4);
    hideError();
});
roomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        const code = roomInput.value.trim();
        if (code.length === 4) connectToCode(code);
    }
});

// ============================================================
// INIT
// ============================================================
const recent = JSON.parse(localStorage.getItem('admin_recent') || '[]');
if (recent.length > 0) roomInput.placeholder = recent[0];
setStatus('Статус: Ожидание', '');
roomInput.focus();

})();
