# JAM 🎵 — Listen Together in Real-Time
> Formerly "Wifi Jokey" (renamed 2026-09-05, see `docs/security-fixes/023-rename-to-jam.md`).

> **A synchronized, ephemeral, collaborative audio lounge platform.**  
> Listen together with friends in real-time with sub-100ms precision audio sync, collaborative queue voting, and 24-hour self-destructing rooms.

---

## 📖 Complete Technical Documentation

For the full architectural breakdown, system design diagrams, database schemas, and deep dives into our technical decisions, see the **[Architecture & System Design Guide](ARCHITECTURE.md)**.

---

## 🚀 Key Features

- **Dynamic Room Codes**: Unique 6-character room codes (`JAM402`, `MAIN01`) for instant room sharing.
- **Strict 5-Member Capacity**: Atomic PostgreSQL row-level locks prevent race conditions; automatically evicts stale members after 45s.
- **Zero-Leakage Private Rooms**: Private rooms protected by bcrypt-hashed passwords in isolated tables with zero client access.
- **Precision Audio Sync**:
  - **Cristian's Algorithm**: Calibrates client clocks against PostgreSQL microsecond timestamps ($\pm 25\text{ms}$).
  - **Hybrid Dual-Path Broadcasting**: 30–60ms WebSocket fast path for periodic ticks (zero DB writes) + durable Postgres persistence for state changes.
  - **3-Tier Adaptive Drift Engine**: Micro-rate adjustments ($1.05\times / 0.95\times$) preserve musical pitch without buffer drops or stutters.
  - **Background Tab Recovery**: Recovers from browser background throttling on tab wake-up.
- **Collaborative Song Queue**:
  - Community song requests with live thumbnails via zero-quota YouTube oEmbed.
  - Upvote songs; auto-sorted by vote count.
  - Rate limiting (max 3 active requests per session).
  - Host "Play Now" manual queue advancement and moderation.
- **Room-Scoped Real-time Chat**: Isolated live chat per room with display names.
- **24-Hour Ephemeral Lifecycles**: All room data (chat, queue, votes, members, secrets) automatically purged after 24 hours via `ON DELETE CASCADE`.

---

## 🛠️ Tech Stack

- **Frontend**: React 19, TypeScript, Vite, React Router v7, Lucide Icons, Impeccable Design System.
- **Backend & Database**: InsForge (PostgreSQL 16 + PostgREST + Realtime Socket.IO broker).
- **Audio**: YouTube IFrame Player API (`react-youtube`).

---

## ⚡ Quickstart

### 1. Clone and Install
```bash
npm install
```

### 2. Configure Environment
Create `.env` with your InsForge project credentials:
```bash
VITE_INSFORGE_URL=https://<your-project-id>.insforge.app
VITE_INSFORGE_ANON_KEY=ik_<your-anon-key>
```

### 3. Run Database Migrations
```bash
insforge -y db migrations up --all
```

### 4. Start Development Server
```bash
npm run dev
```

### 5. Build for Production
```bash
npm run build
```

---

## 🧪 Automated Test Suites

```bash
# Verify Phase 1 Capacity & Session Continuity
node scripts/test-multiroom-rpc.mjs

# Verify Phase 3 Collaborative Queue & Expiry
node scripts/test-phase3-queue.mjs

# Verify Phase 4 Precision Clock Sync & Channel Scoping
node scripts/test-phase4-sync.mjs
```

---

## 📄 License

MIT
