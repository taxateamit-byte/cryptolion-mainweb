# ScreenShare Pro 🖥️

A secure, end-to-end encrypted screen sharing application using Firebase Realtime Database as the relay.

## Architecture

```
┌─────────────────────┐         ┌──────────────────────┐
│   Screen Sharer     │         │   Admin Panel        │
│   (index.html)      │         │   (admin.html)       │
│                     │         │                      │
│  ┌───────────────┐  │         │ ┌────────────────┐   │
│  │ getDisplayMedia│  │         │ │ Enter 4-digit  │   │
│  │ (capture)     │  │         │ │ connection code│   │
│  └──────┬────────┘  │         │ └───────┬────────┘   │
│         │           │         │         │             │
│  ┌──────▼────────┐  │         │ ┌───────▼─────────┐  │
│  │ Encrypt frame │  │         │ │ Decrypt frame   │  │
│  │ (AES-256-GCM) │  │         │ │ & display       │  │
│  └──────┬────────┘  │         │ └───────┬─────────┘  │
│         │           │         │         │             │
│  ┌──────▼────────┐  │         │ ┌───────▼─────────┐  │
│  │ Firebase RTDB │  │         │ │ Firebase RTDB   │  │
│  │ ──► upload    │──┼─────────┼──► listen         │  │
│  └───────────────┘  │         │ └─────────────────┘  │
└─────────────────────┘         └──────────────────────┘

              🔒 End-to-End Encrypted (AES-256-GCM)
```

## Features

- **End-to-end encryption**: Screen frames are encrypted with AES-256-GCM before leaving the client device
- **4-digit pairing code**: Simple code-based connection between sharer and viewer
- **Persistent across reloads**: Connection codes survive page refreshes
- **Real-time**: ~1 FPS frame updates via Firebase Realtime Database
- **Full-screen mode**: Auto-prompts for fullscreen on connect
- **Admin panel**: View any active screen by entering the pairing code
- **Recent codes**: Admin panel remembers previously used codes

## File Structure

```
/
├── index.html           (minimal — loads external CSS/JS)
├── admin.html           (minimal — loads external CSS/JS)
├── config.json          (Firebase config + XOR key — loaded at runtime)
├── css/
│   ├── client.css       (all styles for client page)
│   └── admin.css        (all styles for admin page)
├── js/
│   ├── client.js        (all logic for client page)
│   └── admin.js         (all logic for admin page)
├── old/
│   ├── index.html       (previous WebRTC-based version)
│   └── admin.html       (previous WebRTC-based version)
└── README.md
```

**Why separate files?** To keep sensitive configuration (Firebase credentials, XOR key) out of the HTML source code. The `config.json` is loaded at runtime and visible only in the Network tab, not in View Source. All JavaScript and CSS are external files for cleaner separation.

> ⚠️ **Note**: While this makes the configuration harder to find than plaintext in HTML source, it is **security through obscurity** — the data is still accessible via browser DevTools Network tab. True protection requires Firebase Security Rules (see below).

## Setup

### 1. Firebase Security Rules

> **⚠️ CRITICAL**: You must configure Firebase Realtime Database security rules before using the app in production.

Go to **Firebase Console → Realtime Database → Rules** and paste:

```json
{
  "rules": {
    "screens": {
      "$code": {
        ".read": true,
        ".write": true,
        "salt": {
          ".write": "!data.exists()",
          ".validate": "newData.isString()"
        },
        "active": {
          ".validate": "newData.isBoolean()"
        },
        "frame": {
          ".write": "data.exists() ? newData.hasChildren(['iv', 'data', 'ts']) : newData.hasChildren(['iv', 'data', 'ts'])",
          ".validate": "newData.hasChildren(['iv', 'data', 'ts']) && newData.child('ts').isNumber() && newData.child('iv').isString() && newData.child('data').isString()"
        }
      }
    },
    "_cfg": {
      ".read": false,
      ".write": false,
      "x": {
        ".read": true,
        ".write": false
      }
    }
  }
}
```

**Security notes:**
- Read/write is open by path (anyone with the 4-digit code can access that path) — the code serves as the shared secret
- **Write restrictions**: Salt can only be written once (prevents malicious overwrite). Frame data is validated for correct structure
- **Frame data is encrypted** (AES-256-GCM with 256-bit keys), so even with full database read access, frames cannot be decrypted without the PIN
- The 4-digit code acts as both the path key AND the encryption passphrase (defense in depth)
- Data is automatically cleaned up when sharing stops
- **Config path** (`_cfg/`): Read-protected at root level, only `_cfg/x` is readable (and never writable from client code)

### 2. Hosting

These are static files. Host them anywhere (you need to upload ALL files: index.html, admin.html, config.json, css/*.css, js/*.js):

#### Option A: Firebase Hosting (recommended)
```bash
npm install -g firebase-tools
firebase init hosting
# Set "Public" directory, "single-page app: No"
# Copy ALL files (including css/, js/, config.json) to public/
firebase deploy --only hosting
```

#### Option B: Any static host (GitHub Pages, Vercel, Netlify, etc.)
Upload the entire project folder (keep the structure intact — paths must match).

### 3. Discord Webhook Setup (Optional)

The app can send notifications to Discord when a screen share starts or an admin connects.
The webhook URL is **never hardcoded** in the source code — it's stored XOR-encrypted in Firebase.

To set it up:
1. Create a Discord webhook in your server (Server Settings → Integrations → Webhooks)
2. Visit the [Firebase Console → Realtime Database → Data](https://console.firebase.google.com/project/lionspdf-499b5/database/lionspdf-499b5-default-rtdb/data)
3. Add a new entry at path `_cfg/x` with the value being your webhook URL XOR-encoded with the key from `config.json`
4. Save — the webhook is now active

**How to encode:**
```javascript
// Run this in browser console (replace URL and KEY):
function xorEncode(url, key) {
  let result = '';
  for (let i = 0; i < url.length; i++) {
    result += String.fromCharCode(url.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return btoa(result);
}
console.log(xorEncode('https://discord.com/api/webhooks/...', 'YOUR_XOR_KEY'));
// Store the result in Firebase at _cfg/x
```

> **Security**: The XOR key is in `config.json`, the encrypted data is in Firebase. Without either one, the webhook URL cannot be recovered.

### 4. Usage

#### Sharing your screen (Client)
1. Open `index.html` in Chrome/Edge/Firefox (serve via HTTP server, not `file://`)
2. Click **"Connect & Share"**
3. Allow fullscreen when prompted
4. Select which screen/window to share
5. Share the displayed **4-digit code** with the admin
6. Screen sharing continues even if page reloads (code persists in localStorage)

#### Viewing a screen (Admin)
1. Open `admin.html`
2. Enter the 4-digit code provided by the sharer
3. Click **"Connect"**
4. The remote screen appears in real-time

## Security Architecture

```
PIN (4-digit) + Random Salt
         │
         ▼
    PBKDF2 (200,000 iterations, SHA-256)
         │
         ▼
    AES-256-GCM Key
         │
    ┌────┴────┐
    │         │
 Encrypt    Decrypt
 (Client)   (Admin)
```

- **Key derivation**: PBKDF2 with 200,000 iterations (SHA-256)
- **Encryption**: AES-256-GCM (authenticated encryption)
- **Salt**: 16 random bytes, unique per session, stored in Firebase
- **Frame rate**: ~1 FPS with JPEG compression at 45% quality
- **Max resolution**: Downscaled to 1280px wide for transmission efficiency

## Technical Details

### Data stored in Firebase
```
/screens/{4-digit-code}/
  ├── salt: "base64-encoded-random-salt"
  ├── active: true/false
  └── frame: {
        iv: "base64-iv",
        data: "base64-encrypted-frame",
        ts: 1234567890
      }
```

### Privacy & Data Retention
- Frame data is overwritten with each update (only the latest frame is stored)
- When sharing stops, the frame data is deleted from Firebase
- The salt remains (enables reconnection)
- localStorage is used only for UI convenience (storing codes)

## ⚠️ Important Requirements

### HTTPS Required
`getDisplayMedia()` (screen capture) and the Web Crypto API both require a **secure context** (HTTPS or localhost).
- **Do not** open from `file://` — it will not work
- Use a local server like `npx serve .`, Python's `http.server`, or deploy to a HTTPS host
- Both pages include feature detection and will show an error if not served securely

## Browser Compatibility

Requires browsers supporting:
- `navigator.mediaDevices.getDisplayMedia()` — Chrome, Edge, Firefox, Safari 15+
- `Web Crypto API` — All modern browsers
- `Fullscreen API` — All modern browsers

## License

MIT
