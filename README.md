# FORM SERVICES
### by Form Computer

A self-contained local infrastructure platform. Data storage, real-time P2P sync,
user auth, and project management — all running on your iMac.

---

## QUICK START

1. **Double-click `launch.command`**
   - First run installs everything automatically (Homebrew, Node, MySQL, coTURN)
   - Generates config, TLS certs, and admin credentials
   - Starts all services
   - Opens dashboard at http://localhost:2000

2. **Check `ADMIN_PASSWORD.txt`** for your first login credentials
   (delete it after logging in)

3. **Create a project** in the dashboard → Projects → New Project

4. **Approve the project** — click APPROVE

5. **Get the module** — click MODULE to get the JS snippet

6. **Drop the module** into any HTML file and call `Form.connect()`

---

## ARCHITECTURE

```
Your iMac (hub)
├── MySQL          — persistent data store
├── coTURN         — STUN/TURN server (NAT traversal, firewall bypass)
├── PeerJS Server  — WebRTC signaling
├── REST API       — data, auth, project management
└── Dashboard      — this UI, http://localhost:2000

Distributed HTML files (children)
└── form-module-[id].js — self-contained, points to your iMac
    ├── Tag (encrypted) — identifies the project
    ├── API calls       — data read/write
    ├── WebSocket       — real-time sync
    └── PeerJS          — direct P2P if available
```

---

## PORTS

| Port | Service | Protocol |
|------|---------|----------|
| 2000 | Form Services API + Dashboard | TCP |
| 2001 | PeerJS signaling | TCP |
| 3478 | coTURN STUN/TURN | TCP+UDP |
| 5349 | coTURN TLS | TCP |

Forward all of these on your router to this machine's local IP.

---

## THE MODULE API

After dropping `form-module-[id].js` into your HTML:

```javascript
// Initialize
Form.connect()
  .on('connected', ({ peerId }) => console.log('Connected:', peerId))
  .on('data:update', ({ collection, docId, data }) => { /* sync */ })
  .on('disconnected', () => { /* reconnecting... */ });

// Auth
await Form.register('username', 'password', 'email@school.edu');
await Form.login('username', 'password');
Form.logout();
Form.restoreSession(); // restore from localStorage

// Data
const articles = await Form.list('articles', { limit: 20, orderBy: 'updated_at' });
const article  = await Form.get('articles', 'article-id-123');
await Form.set('articles', 'article-id-123', { title: 'My Article', body: '...' });
await Form.del('articles', 'article-id-123');

// Real-time broadcast to all peers on this project
Form.broadcast({ type: 'new-article', id: 'article-id-123' });
Form.on('message', ({ from, data }) => console.log('Peer message:', data));

// Direct P2P (requires PeerJS script loaded separately)
const peer = Form.createPeer();
```

---

## FIREWALL NOTES

Form Services is designed to work through strict school/enterprise firewalls:

- All traffic uses standard ports (2000, which you can remap to 443 via port forward)
- TURN relay means even if direct P2P is blocked, data still flows through your iMac
- Connection fallback chain: Direct P2P → STUN P2P → TURN relay → REST polling

---

## IP MANAGEMENT

Your iMac's local IP is fixed via DHCP reservation on your router.
Your public IP is monitored — if it changes, the dashboard alerts you
and lets you regenerate + redistribute updated module files.

---

## PROJECT TAGS

Each project gets an encrypted tag baked into its module file.
- The tag identifies which project the client belongs to
- It's encrypted with AES-256 — not readable by inspecting the HTML
- Approval/revocation is instant — revoke a tag, all clients with it stop working
- You approve projects once; all files sharing that tag work automatically

---

## DIRECTORY STRUCTURE

```
form-services/
├── launch.command      ← double-click to start
├── package.json
├── ADMIN_PASSWORD.txt  ← delete after first login
├── bin/
│   └── setup.js        ← first-run initialization
├── server/
│   └── server.js       ← main server (API + WS + PeerJS)
├── public/
│   └── index.html      ← dashboard UI
├── config/
│   ├── form.json       ← generated config (do not edit manually)
│   ├── turnserver.conf ← generated coTURN config
│   └── tls/            ← generated TLS certificates
├── data/               ← reserved for local file storage
└── logs/               ← server, coTURN, launch logs
```

---

Astro Core v1.0 · Astro
