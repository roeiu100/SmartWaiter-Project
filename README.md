# Smart Waiter

Welcome to **Smart Waiter** — a restaurant operating system that puts a digital waiter on every table and a live command center in every staff role.

Guests scan a **table QR code** and land in an AI-powered waiter chat (with a full menu and bill as backup). Kitchen, runners, and managers see the same ticket **update in real time** over Socket.IO. **Role-based access** keeps the guest experience completely separate from staff dashboards: opening the app normally goes to a PIN gate; a table deep link never exposes kitchen or manager screens.

Whether you are demoing a hospitality idea or running a student project, this repo is a complete guest-to-kitchen loop: order, cook, run, pay.

---

## What you can do

- **Scan a table QR (deep linking)** — `smartwaiter://table/5` or Expo Go’s `exp://…/--/table/5` opens the guest **AI Waiter** with that table already pinned.
- **AI waiter + menu + bill** — converse with Groq-backed waitstaff, browse the menu, request a runner, and settle the check.
- **Real-time operations** — new orders, item status, menu changes, “call manager”, and runner requests broadcast instantly.
- **RBAC staff boards** — four-digit PINs route you to **Manager**, **Kitchen**, or **Runner** only. Kitchen and Runner never see each other’s full toolset; Manager can open all boards plus analytics and a table map.

---

## Architecture

```
┌─────────────────────┐         HTTPS + Socket.IO          ┌──────────────────────┐
│  Expo / React Native│  ◄──────────────────────────────►  │  Express + Socket.IO │
│  Guest  │  Staff    │                                    │  backend/server.js   │
└─────────────────────┘                                    └──────────┬───────────┘
                                                                      │
                                                                      ▼
                                                           ┌──────────────────────┐
                                                           │  Supabase (Postgres) │
                                                           │  Groq (chat / tools) │
                                                           └──────────────────────┘
```

| Area | Responsibility |
|------|----------------|
| **Frontend** (`frontend/`) | Guest chat, menu, bill; staff PIN gate; Manager / Kitchen / Runner UIs |
| **Backend** (`backend/`) | REST API, Socket.IO hub, Groq tool-calling waiter, CORS for cloud hosts |
| **Supabase** | Menu, orders, order items, runner options, analytics source data |

---

## Tech stack

### Frontend

| Technology | Role |
|------------|------|
| [Expo](https://expo.dev/) ~54 | App runtime, linking (`scheme`: `smartwaiter`) |
| React 19 / React Native 0.81 | UI |
| React Navigation 7 | Root split: **Customer** vs **Staff**; deep links |
| Socket.IO Client | Live menus, orders, alerts |
| Zustand | Auth role + guest table session |
| Gifted Charts / Reanimated / Gesture Handler | Manager analytics and lists |
| TypeScript | Typed screens and API clients |

### Backend

| Technology | Role |
|------------|------|
| Node.js + Express | REST API (`/api/menu`, `/api/orders`, `/api/chat`, analytics, …) |
| Socket.IO | Real-time events (orders, menu, runner/manager alerts) |
| `@supabase/supabase-js` | Postgres persistence |
| Groq SDK | AI waiter (native tool calling: cart, order, runner, check) |
| cors + dotenv | Cross-origin access and secrets |

---

## How to run locally

You need **Node.js 18+**, **npm**, a **Supabase** project, and a **Groq** API key. Expo Go on a phone or simulator is enough for the UI.

### 1. Clone the repository

```bash
git clone https://github.com/roeiu100/SmartWaiter-Project.git
cd SmartWaiter-Project
```

### 2. Install dependencies

**Backend**

```bash
cd backend
npm install
```

**Frontend** (from the repo root, or `cd ..` then)

```bash
cd frontend
npm install
```

### 3. Environment variables

Do **not** commit real keys. Create the files below next to each `package.json`.

#### Backend — `backend/.env`

```env
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_KEY=YOUR_SUPABASE_ANON_OR_SERVICE_KEY
GROQ_API_KEY=gsk_YOUR_GROQ_KEY
```

| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` | Project URL from the Supabase dashboard |
| `SUPABASE_KEY` | API key the server uses to read/write tables |
| `GROQ_API_KEY` | Powers `POST /api/chat` (AI Waiter) |
| `PORT` | Optional. Render sets this automatically. Local default is **3000**. |

**Supabase schema:** in the SQL Editor, run the scripts in `backend/sql/` in a sensible order (orders first, then payment / menu extras):

- `backend/sql/orders_schema.sql`
- `backend/sql/orders_payment_schema.sql`
- `backend/sql/menu_items_subcategory.sql`

You also need tables the API already expects (for example `menu_items` and runner-options). Create or seed those in Supabase so `/api/menu` and `/api/runner-options` succeed.

#### Frontend — `frontend/.env`

```env
EXPO_NO_TELEMETRY=1
EXPO_PUBLIC_API_URL=http://YOUR_LAN_IP:3000
```

| Variable | Purpose |
|----------|---------|
| `EXPO_PUBLIC_API_URL` | **Plain URL only** (no markdown). All `fetch` calls and Socket.IO use this. |

**Examples**

```env
# Same Wi-Fi as the backend (phone / Expo Go)
EXPO_PUBLIC_API_URL=http://192.168.1.10:3000

# Public cloud API (Render, etc.)
EXPO_PUBLIC_API_URL=https://your-service.onrender.com
```

Replace `YOUR_LAN_IP` with your computer’s address (not `localhost` — a physical device cannot reach the host that way). After any `.env` change, restart Expo with `--clear` so Metro picks it up.

### 4. Start the Node.js backend

From `backend/`:

```bash
npm start
```

That runs `nodemon server.js`. You should see the API listening on `0.0.0.0:3000` (or `process.env.PORT`). Keep this terminal open.

Optional, without auto-reload:

```bash
node server.js
```

### 5. Start the Expo frontend (manual tunnel)

Do **not** use `npx expo start --tunnel`. Expo’s built-in tunnel uses a shared ngrok service that has been rate-limited / overloaded since February 2026, which often fails with `TypeError: Cannot read properties of undefined`. Until that is fixed, run an **independent ngrok tunnel** and point Expo at it.

#### Prerequisites

- Node.js installed
- [ngrok](https://ngrok.com/download) installed (`npm install -g ngrok`, or the downloaded `.exe`)
- A free ngrok account with an authtoken configured:

```powershell
ngrok config add-authtoken YOUR_TOKEN
```

#### Why a manual tunnel is needed

`npx expo start --tunnel` relies on Expo’s shared tunnel. Running your own ngrok process avoids that rate limit and still lets Expo Go load the UI from a phone that is not on the same LAN.

This tunnel (`EXPO_PACKAGER_PROXY_URL`) **only serves the Metro/UI bundle**. It is unrelated to the backend API. Keep `EXPO_PUBLIC_API_URL` pointed at your deployed server (or a LAN IP the phone can reach).

#### Step 1: Start your own ngrok tunnel

Open a **PowerShell** terminal and tunnel port **8081** (leave this terminal open):

```powershell
ngrok http 8081
```

If you downloaded the `.exe` directly, `cd` into that folder first:

```powershell
.\ngrok.exe http 8081
```

Copy the **Forwarding** URL it prints (for example `https://xxxx-xx-xx.ngrok-free.app`). Use the raw `https://…` value — not a markdown link.

#### Step 2: Start Expo using that tunnel

Open a **second PowerShell** terminal, go to `frontend`, inject the ngrok URL, and start Expo:

```powershell
cd frontend
$env:EXPO_PACKAGER_PROXY_URL="https://YOUR_COPIED_NGROK_URL.ngrok-free.app"
npx expo start
```

Replace `YOUR_COPIED_NGROK_URL` with the host from Step 1 (no trailing slash).

#### Step 3: Scan the QR code

Scan the QR code in **Terminal 2** with **Expo Go**.

#### Important notes

- Keep **both** terminals open while you develop (ngrok in Terminal 1, Expo in Terminal 2).
- The free ngrok tier issues a **new random URL** every time ngrok restarts. If you close Terminal 1, repeat Steps 1–2 with the new Forwarding URL.
- Cold start of a free Render API can take ~30 seconds on the first request. That is the backend waking up, not the Metro tunnel.

---

## Using the app (demo)

The root navigator defaults to **Staff**. A matching **table** deep link opens **Customer** instead. The two worlds do not share screens.

### Staff flow (PIN Auth Gate)

1. Open the app **without** a table URL (or use the Staff entry).
2. You should see **STAFF ACCESS** and a 4-digit keypad.
3. Enter one of the demo PINs (defined in `frontend/src/store/authStore.ts`):

| PIN | Role | What you see |
|-----|------|----------------|
| **1111** | Manager | Tabs: **Manager** (menu, runner options, call-manager alerts, analytics), **Kitchen**, **Runner**, **Tables** |
| **2222** | Kitchen | Kitchen board only — ticket queue and item status |
| **3333** | Runner | Runner board + table map — food-run tickets and guest requests (ketchup, napkins, …) |

4. Use **Log out** in the header to return to the PIN pad.

Wrong PINs flash an error and reset the dots. Kitchen and Runner roles **cannot** navigate to Manager-only screens; those routes are not registered for them.

**Suggested demo:** log in as Kitchen on one device (or keep the board open), Manager on another, then place a guest order and watch tickets appear without refresh.

### Customer flow (QR / deep link)

Guests should **not** use the PIN screen. Open a table URL so the AI Waiter starts with that table locked.

**Custom scheme** (dev build / configured app):

```text
smartwaiter://table/5
```

**Expo Go** (replace host, port, and path with what Metro prints — the important suffix is `/--/table/<id>`):

```text
exp://127.0.0.1:8081/--/table/5
exp://192.168.1.10:8081/--/table/5
```

With a manual ngrok tunnel, use the `exp://` URL Expo shows (or your ngrok host), then append `/--/table/5`.

| Step | What to try |
|------|-------------|
| 1 | Open the deep link → **AI Waiter** chat, table `5` pinned |
| 2 | Order in chat (or **Browse Menu**) → Kitchen/Runner boards update live |
| 3 | **Ask for Check** / bill screen → pay the table; staff see paid state |
| 4 | Call a runner or manager from the guest flow and confirm the matching staff alert |

Any table id that your backend accepts as `table_id` (for example `5`, `T12`) works in the path.

---

## Project layout

```text
SmartWaiter-Project/
├── backend/
│   ├── server.js          # Express + Socket.IO + Groq
│   ├── sql/               # Supabase bootstrap scripts
│   └── package.json
└── frontend/
    ├── AppEntry (Expo)
    ├── app.json           # scheme: smartwaiter
    ├── src/navigation/    # Customer vs Staff, deep linking
    ├── src/screens/       # Chat, menu, bill, dashboards
    ├── src/services/      # REST clients (EXPO_PUBLIC_API_URL)
    └── src/store/         # PIN map, guest table session
```

---

## Troubleshooting

| Symptom | What to check |
|---------|----------------|
| `Network request failed` | `EXPO_PUBLIC_API_URL` is a raw `http(s)://…` URL; restart Expo with `--clear`; device can reach that host |
| Socket `connect_error` / timeout | Same URL as the API; backend is up; first Render wake can be slow |
| `TypeError: fetch failed` **from the server** (HTTP 500) | `SUPABASE_URL` / `SUPABASE_KEY` on the **backend**; schema deployed |
| Chat does not answer | `GROQ_API_KEY` set on the backend and the service restarted |
| Deep link opens Staff PIN | Path must include `table/<id>` as documented above |
| `npx expo start --tunnel` / `Cannot read properties of undefined` | Skip Expo’s built-in tunnel. Use a manual `ngrok http 8081` process and `EXPO_PACKAGER_PROXY_URL` as in section 5. |

---

## License

Private student / final-project repository. All rights reserved unless the authors state otherwise.

Enjoy the floor — and may every table feel like it has a waiter who already knows the specials.
