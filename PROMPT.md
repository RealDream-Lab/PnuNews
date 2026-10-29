# PnuNews — Build Brief for the Coding Agent

You are building **PnuNews**, a Persian (RTL) news web application for Payame Noor University (PNU). Read this entire brief before writing code. Follow the process rules in section 0. Where the brief is silent, choose the simplest option that respects the constraints, and note the choice in `docs/DECISIONS.md`.

The owner (user) speaks Persian. **All UI text is Persian. All git commit messages must be written in Persian.** When you report progress, list only the files you changed. Code, identifiers and code comments are in English.

---

## 0. Process rules

1. Work in the milestones of section 18. After each milestone: run the tests, then report in a few lines (what works, changed files, what you need from the owner). Do not wait for approval between milestones unless a checkpoint says STOP.
2. **STOP checkpoints** (ask the owner to run commands and wait for their reply): GitHub repository (section 15.5), production DB creation (section 16.2), first production deployment (section 15.3/15.4), and reverse-proxy setup (section 17). Everything else you do yourself on the owner's Mac.
3. Never ask the owner for secrets (DB password, APP_SECRET). The owner writes them into `.autostart` themselves. You only provide `.autostart.example`.
4. Keep dependencies minimal (section 2.3). Every new dependency must be justified in `docs/DECISIONS.md`.
5. Do not invent facts about PNU. Where a value is unknown (logo, radio URL), build a clean configurable placeholder.

---

## 1. Product summary

A news web app that looks and feels like the news feed in the Google app (Discover) on iOS/Android:

- **Readers** (students and the public) need **no login**. They see news as **cards**, newest first, with **infinite scroll**, and open a card to read the full item.
- **Admins** (public-relations officers) publish news. Publishing follows the university hierarchy: central organization → provinces → cities (counties).
- Works on phones and desktops. There is a **mobile admin experience** (fast publishing) and a **desktop admin experience** (full management) with different capabilities, so officers naturally use both.
- Day/night (light/dark) mode everywhere.
- A slot for the university **internet radio player** (URL and an on/off switch are configurable on the admin Settings page; the URL is provided later).
- Must run well on **low-end phones and slow networks**.

---

## 2. Environment and hard constraints

### 2.0 Where the work happens (read first)

- **You run on the owner's Mac** (probably Apple Silicon, so arm64). You **cannot reach the production server**; never assume you can: no `docker exec nodejs ...`, no access to the production MariaDB.
- Flow: you develop and test locally on the Mac, commit (Persian messages), push to **GitHub**, and the owner **pulls on the server**. The repository must be self-contained so that a pull plus a few documented commands deploys it. Never commit secrets, `uploads/`, `.autostart`, `.env*` (except examples), or `node_modules/` on `main` (see 15.4 for how dependencies reach the server).
- **Local development environment (you set it up yourself, without asking):** Node >= 24 on the Mac (check `node -v`; if missing, tell the owner to install it with nvm or Homebrew), and a local MariaDB 12 (LTS) in Docker Desktop through a committed `docker-compose.dev.yml` (database `pnu_news`, user `pnu_news`, a dev-only password, port bound to `127.0.0.1:3306`, named volume). Local config lives in a git-ignored `.env.dev` loaded by `npm run dev` through a tiny loader of your own (no `dotenv`). Local migrations, seeding and tests run against this dev DB.
- The production facts below are what the code must stay compatible with. You cannot test against them from the Mac, so keep the production contract (2.1, 15) exact and verify it by simulation (for example, source a sample `.autostart` with bash and check the variables).

### 2.1 Server facts (already verified by the owner)

- Host: Ubuntu server, hostname `radio`, timezone `Asia/Tehran` (UTC+3:30, no DST), NTP synchronized.
- Docker + Compose. Shared Docker network **`proxy`**; DB network **`database-internal`**.
- Node runs inside the existing container **`nodejs`** (`node:24-bookworm`, Node v24.x, runs as the container default user). It is attached to both networks. The container's command is `bash /workspace/start-all.sh`.
- The host path `/opt/docker/nodejs/workspace` is mounted in the container as `/workspace`. **On the server the project will live at `/opt/docker/nodejs/workspace/PnuNews` (container path `/workspace/PnuNews`)**; an empty, writable `uploads/` directory already exists there.
- `start-all.sh` auto-starts every folder under `/workspace` that has a **`.autostart`** file by running, in that folder: `set -a; . ./.autostart; set +a; exec node server.js` — and restarts it 3 seconds after any exit. Therefore:
  - The entry point **must be `server.js`** in the project root.
  - `.autostart` is a **bash-sourced env file**: `KEY=value` lines, no spaces around `=`, single-quote values containing `$ & ; space`.
  - Another site (`PnuCard`) already uses port 3000. **This app uses `PORT=3010`.**
- Database: **MariaDB 12.3** in container `mariadb` (host name `mariadb`, port 3306, reachable from `nodejs` over `database-internal`; verified). phpMyAdmin exists.
- Reverse proxy: **Nginx Proxy Manager** (container `npm`), which resolves `nodejs`. TLS terminates there. Assumed public domain: **`https://news.pnu.ac.ir`** (make it `PUBLIC_URL` config; not hardcoded).
- Authelia also exists on the server. **Do not put this site behind Authelia** (the reader site is public; admin has its own 2FA).
- **The npm registry is currently unreachable from the server's container** (the owner is working on a proxy). Do not make production depend on `npm install` running there; see 15.4.
- The server's `PnuNews` folder will be a **git clone of the GitHub repo** (see 15.5). Server-side commands are always given to the owner to run, in the form `docker exec -w /workspace/PnuNews nodejs <cmd>`.

### 2.2 Runtime constraints

- ESM (`"type": "module"`), Node ≥ 24 built-ins preferred (`node:crypto`, `node:test`, `node:zlib`, `node:http`, `fetch`).
- MariaDB only through parameterized queries. Connection: `mysql2/promise` pool, session time zone forced to `+00:00`, `utf8mb4`.
- No build step for the frontend (keeps deployment simple). Hand-written ES modules, CSS, no bundler, no framework.
- No external network resources at runtime: **no CDNs, no Google Fonts, no external images/scripts**. Everything is served from the app.

### 2.3 Allowed dependencies (pinned in `package.json`)

`express`, `mysql2`, `busboy`, `sharp`, `sanitize-html`, `qrcode`. Nothing else for production. Implement yourself with built-ins: password hashing (`crypto.scrypt`), TOTP (RFC 6238, HMAC-SHA1, 6 digits, 30 s, ±1 step window, own Base32), session/device tokens (`crypto.randomBytes(32)`, only SHA-256 hashes stored), AES-256-GCM encryption of TOTP secrets, rate limiting, security headers, gzip/brotli static serving, Jalali date conversion. Test with `node:test`.

---

## 3. Roles and authorization (authoritative rules)

Hierarchy tree: **Country (root, 1 node) → Province (31) → City (county/شهرستان centers)**. Roles:

| Role | Bound to | Notes |
|---|---|---|
| `super_admin` | country root | Central organization PR. Created only by CLI script (and by other super admins is **not** allowed). |
| `province_admin` | one province | Created by `super_admin`. |
| `city_admin` | one city | Created by a `province_admin` of the parent province (or by `super_admin`). **Exactly one active `city_admin` per city** (see User management). |

Terms: a user's *subtree* = their region and all descendants. `origin_region` of a news item = the publisher's region (country root for super_admin). `targets` = the regions that should see the news.

**Publishing (`canPublishTo(user, targetRegion)`):**
- `super_admin`: any region (country = whole nation).
- `province_admin`: their province, or any city whose parent is their province. Never the country.
- `city_admin`: only their own city.
- A news item may have several targets (e.g. a province admin picks 3 cities). Validate every target server-side.
- **No approval workflow.** Whoever is allowed publishes immediately (or schedules).

**Viewing in the admin panel:**
- `super_admin`: everything.
- `province_admin` and `city_admin`: all news whose `origin_region` is in **their province's subtree** (so a city admin sees news of other cities in the same province), plus country-level news. Read-only for items they cannot edit.

**Editing/deleting (soft delete):**
- `super_admin`: any news.
- `province_admin`: news they created themselves, and news created by `city_admin` users of their province (moderation). Not news of another province admin of the same province unless `peer_edit_enabled=1`.
- `city_admin`: only news **they created** (`created_by = user`). Peers never edit each other's news. With exactly one admin per city this equals "their city's news", and it stays safe if a city later gets more than one admin. The setting `peer_edit_enabled` (default `0`) lets the owner relax this later without code changes; when `1`, a city admin may also edit news of other active admins of the same city. Always audited.
- Superiors (province/super admin) keep moderation rights over their subordinates' news as listed above; nobody else can edit anything, regardless of the UI.

**User management:**
- `super_admin` creates and manages **only province admins** directly in normal operation (to keep the workload manageable) but retains the technical ability to view, deactivate, reset any user nationwide (supervision).
- `province_admin` creates and manages `city_admin` users for cities in their province only; supervises exactly those users.
  - **One admin per city:** creating a second *active* `city_admin` for the same city is rejected with a clear Persian message (check inside a transaction that locks the region row). The limit is the setting `max_city_admins` (default `1`), so the owner can raise it later without a migration. To replace a city's admin, deactivate the old one, then create the new one.
- `city_admin` manages no users.
- No one can create a user of equal or higher role; no one edits their own role/region.
- Users are **never hard-deleted** (news reference them) — only deactivated. Deactivation revokes all sessions and trusted devices immediately.
- A superior can reset a subordinate's password (temporary password, `must_change_password=1`) and reset their 2FA (forces re-enrollment).

**Enforce all of this in one policy module** (`src/auth/policy.js`) used by every route; unit-test it thoroughly. Never rely on the UI hiding buttons.

**Reader-visible regions (city list):** readers end up choosing **a city**. The picker is two-step (province first, as navigation only, then the cities of that province); a province is never the stored choice, the stored choice is always a city. A city appears in the public city picker only when it has an active `city_admin` (i.e. a province admin created a user for it). `regions.visibility_override ENUM('auto','show','hide') DEFAULT 'auto'` lets super_admin force a city visible or hidden. A reader who picked city C sees news targeted at the country root, at C's parent province, or at C itself (news a province admin publishes for the whole province reaches every selectable city of that province).

---

## 4. Data model (MariaDB, InnoDB, `utf8mb4_unicode_ci`, all DATETIME in UTC)

Create versioned, idempotent migrations (`migrations/001_init.sql`, …) tracked in a `schema_migrations` table, applied by `scripts/migrate.js`. Core tables (add sensible indexes/FKs):

- `regions(id, parent_id NULL, type ENUM('country','province','city'), name, code NULL, sort_order, visibility_override, created_at)`
- `users(id, username UNIQUE, password_hash, full_name, role, region_id, created_by, is_active, must_change_password, totp_secret_enc NULL, totp_enabled, password_changed_at, last_login_at, created_at)`
- `sessions(token_hash PK, user_id, created_at, expires_at, ip, user_agent)`
- `trusted_devices(id, user_id, token_hash UNIQUE, user_agent, ip, created_at, last_used_at, expires_at)`
- `backup_codes(id, user_id, code_hash, used_at)`
- `login_attempts` (or equivalent) for throttling
- `categories(id, name, sort_order, is_active)` — seed: آموزشی، امتحانات، ثبت‌نام و پذیرش، فرهنگی و دانشجویی، پژوهشی، اطلاعیه‌های عمومی
- `news(id, title, summary, body_html, search_text, category_id NULL, status ENUM('draft','scheduled','published'), published_at NULL, expires_at NULL, is_pinned, is_urgent, cover_attachment_id NULL, view_count, origin_region_id, published_by_user_id, publisher_name, publisher_unit, created_by, updated_by, created_at, updated_at, deleted_at NULL)` with index on `(status, published_at, id)`.
  - **Publisher metadata is mandatory.** On first publish store `published_by_user_id` **and snapshots** `publisher_name` (user's full name) and `publisher_unit` (e.g. «روابط عمومی استان تهران»). These never change if the user is later renamed or deactivated. Also keep `created_by/updated_by` and an audit trail of edits.
- `news_targets(news_id, region_id, PRIMARY KEY(news_id, region_id), INDEX(region_id, news_id))`
- `attachments(id, news_id, kind ENUM('cover','image','file'), original_name, stored_name, mime, size_bytes, width NULL, height NULL, dominant_color NULL, created_at)`
- `settings(k PK, v TEXT)` — keys: `radio_enabled` (`1`/`0`, default `0`), `radio_title`, `radio_stream_url`, `radio_nowplaying_url`, `byline_show_person` (default `1`), `site_title`, `max_city_admins` (default `1`), `peer_edit_enabled` (default `0`)
- `audit_log(id, user_id, action, entity, entity_id, meta JSON NULL, ip, created_at)` — log logins, failures, user create/deactivate/reset, news create/edit/delete/publish, settings change.

**Text normalization** (`src/lib/fa.js`): normalize Arabic `ي/ك` → `ی/ک`, Arabic-Indic and Persian digits → one canonical form for search, strip tatweel; build `search_text` from title+summary+plain body. Search uses a normalized `LIKE` (v1).

---

## 5. Authentication (admins only; readers never log in)

**Two-factor is mandatory for every admin.** Use TOTP (authenticator app) + 10 one-time backup codes. Two separate cookies:

| Cookie | Purpose | Lifetime |
|---|---|---|
| `__Host-pnu_session` | proves a password login happened | **24 hours, absolute** (not extended by activity) |
| `__Host-pnu_device` | "this device already passed 2FA" | **30 days**, fixed from issue |

Both: `HttpOnly; Secure; SameSite=Lax; Path=/`, random 256-bit opaque tokens, **only SHA-256 hashes stored in DB**. **A password is never stored in a cookie.** (When `NODE_ENV!=='production'` use plain cookie names and omit `Secure`, so it also works on `http://localhost` in Safari.)

**Login flow**
1. `POST /api/auth/login {username,password}`. Wrong → generic error, throttled (per IP and per username).
2. Password OK:
   - 2FA not enrolled → issue a short-lived (10 min) HttpOnly "pending" cookie and require **enrollment**: `GET /api/auth/totp/setup` (secret + QR as inline SVG via `qrcode`) → `POST /api/auth/totp/enable {code}` → show backup codes **once** → create session.
   - 2FA enrolled and a **valid device cookie for this user** exists → create the session immediately (no code). Update `last_used_at`.
   - otherwise → "pending" cookie, ask for the code: `POST /api/auth/totp {code, remember}` (or a backup code). On success create the session; if `remember` (checkbox, **default checked**, label «این دستگاه را یک ماه به خاطر بسپار») also issue the 30-day device cookie.
3. After 24 h the session expires: the user retypes only the password; the trusted device skips the code. After 30 days the code is asked again.
4. If `must_change_password=1`, force a password change before anything else.

**Hardening:** 5 wrong codes → 15-minute lock for that user+IP; TOTP replay protection (reject a time-step already used); password min length 10, not equal to username; scrypt with per-user salt; TOTP secrets AES-256-GCM encrypted with a key derived from `APP_SECRET`; on password change / 2FA reset / deactivation → revoke **all** sessions and trusted devices of that user; profile page lists trusted devices with "log out everywhere". CSRF: SameSite cookies + require `Content-Type: application/json` and a same-origin `Origin`/`Sec-Fetch-Site` check on every state-changing request.

`scripts/create-super-admin.js`: interactive prompt for username/full name/password (no defaults, never printed). The first login enrolls 2FA like everyone else. Also provide `scripts/reset-2fa.js <username>` for the case where a super admin loses their phone.

---

## 6. API (JSON, prefix `/api`)

**Public (no auth, rate-limited, short in-memory micro-cache ≤15 s, invalidated on publish):**
- `GET /api/public/config` → site title, a `radio` object (`{enabled:false}` when switched off, otherwise title + stream URL), and the provinces that have at least one visible city, each with its list of **visible cities** (id, name).
- `GET /api/public/feed?city=<city id>&scope=all|country|province|city&cursor=<opaque>&limit=12` (`scope` only filters the *level* of the news; the city is always required) → `{items:[…], next_cursor}`; first page also returns `pinned` (pinned + urgent items for that scope).
- `GET /api/public/news/:id` → full item (sanitized body, attachments, publisher metadata, view counter incremented with simple per-IP dedupe).
- `GET /media/...` images (immutable cache), `GET /files/:id` downloads (`Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`).
- `GET /n/:id` → the app shell **with server-injected Open Graph/Twitter meta tags** (title, summary, cover image URL) so links shared in Telegram/Eitaa/Bale show a preview. `GET /sitemap.xml` is optional.

**Feed rule:** show a news item iff `status='published' AND published_at<=now AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at>now)` AND one of its targets is in `{country root, the selected city's parent province, the selected city}`. Order `published_at DESC, id DESC`. **Keyset pagination only** (cursor = `published_at`+`id`), never OFFSET. De-duplicate items that match several targets.

**Admin (cookie session required):**
- `POST /api/auth/login|totp|logout`, `GET/POST /api/auth/totp/setup|enable`, `POST /api/auth/change-password`, `GET /api/auth/me`, `GET/DELETE /api/auth/devices`
- `GET /api/admin/news` (filters: status, region, category, text, mine/scope; keyset), `POST`, `GET/PUT/DELETE /api/admin/news/:id`, `POST /api/admin/news/:id/publish|unpublish|pin|urgent`, `POST /api/admin/news/:id/attachments` (multipart), `DELETE /api/admin/attachments/:id`
- `GET/POST/PATCH /api/admin/users` (+ `/reset-password`, `/reset-2fa`, `/deactivate`, `/activate`), scoped by policy
- `GET /api/admin/regions` (allowed targets for the current user), `PATCH /api/admin/regions/:id` (super_admin: rename, visibility override), `POST` region create (super_admin)
- `GET/PUT /api/admin/settings` (super_admin), `GET /api/admin/audit` (scoped), `GET /api/admin/stats` (views per news, counts)

**Scheduler:** an in-process timer (every 30 s) publishes due `scheduled` items and is idempotent (`UPDATE … WHERE status='scheduled' AND published_at<=UTC_TIMESTAMP()`); expired items simply stop matching the feed rule.

---

## 7. Reader app (public, `/`)

- **Header:** title «اخبار پیام نور», selected-city button, theme toggle (auto/light/dark), font-size control (A−/A+).
- **City picker (two steps):** bottom sheet on mobile / modal on desktop. **Step 1** lists the provinces (alphabetical with Persian collation, only provinces that have at least one visible city), searchable with normalized Persian search. Tapping a province goes to **step 2**: the visible cities of that province (alphabetical, searchable) with a back button to return to step 1. Only tapping a city completes the choice; a province is navigation only and is never stored as the selection. The header button shows the chosen city and its province. Choice persisted in `localStorage` (`pnu.city`, the city id); the first visit opens the picker and the feed stays empty until a city is chosen; when reopened later, start directly at step 2 of the stored city's province. If the stored city is no longer visible, reopen at step 1.
- **Scope chips:** همه · کشوری · استان · شهر (these only filter by the *level* of the news).
- **Pinned/urgent strip** at the top of the first page; urgent items get a distinct accent.
- **Card:** fixed-aspect cover (16:9, `aspect-ratio` + dominant-color placeholder, `loading="lazy"`, `srcset`), category, title (max 3 lines), summary (max 2 lines), scope badge (کشوری / استان X / شهر Y), relative time in Persian («۱۰ دقیقه پیش», «دیروز»), full Jalali date for older items.
- **Infinite scroll:** `IntersectionObserver` sentinel, 12 items per request, skeleton placeholders, "خبر جدید" banner (no auto-jump) when newer items exist, **DOM recycling** (keep ≈60 items live; replace far-off ones with fixed-height spacers), scroll position restored on back navigation, end-of-feed message.
- **News page** (`/n/:id`, client-routed with `history`): cover, title, **byline directly under the title**: «منتشرکننده: {publisher_name} — {publisher_unit}» (respect `byline_show_person`; if off, show unit only), then Jalali date+time (Iran time), category, view count; sanitized body; image gallery; attachments list (icon by type, original name, size); share button (Web Share API, fallback copy link).
- **Radio player (controlled from admin Settings, section 8):** rendered **only when `radio_enabled=1` and a valid stream URL is set**; when switched off, the bar is not rendered at all, nothing is requested from the stream, and playback stops at the next config refresh. When on, a slim sticky bar (bottom on mobile, side/footer on desktop): play/pause, volume, station name, optional "now playing" text. `<audio preload="none">`, nothing downloads until the user presses play, playback continues across in-app navigation, Media Session API for lock-screen controls, remembers volume. If `radio_nowplaying_url` is set, the **server** fetches it (AzuraCast-style JSON) with a 15–30 s cache and exposes `GET /api/public/radio` — the browser never calls other origins.
- **PWA:** manifest (RTL, `fa`), service worker caching the app shell + last feed page + images (stale-while-revalidate), offline fallback page. No push notifications in v1 (see section 19).

---

## 8. Admin app (`/dashboard`, formerly `/admin`) — mobile vs desktop

One codebase, two layouts chosen by viewport, with **intentionally different capabilities**:

**Mobile (≤ 767 px) — "fast publishing":** login + 2FA; **quick-compose** (title, short text, take/choose photos via `<input type=file accept=image/* capture>`, pick scope, publish now); my recent news (edit/unpublish/delete within policy); read the feed; profile & trusted devices. Large touch targets, one-handed layout.

**Desktop — "full management":** dashboard (counts, latest, views); news table with filters/search; full editor (small built-in rich-text toolbar: bold/italic/headings/lists/links; multiple images; file attachments; category; pin/urgent; **schedule publishing and expiry with a Jalali date-time picker**, Iran time); **user management** as a tree (province → cities) with create / deactivate / reset password / reset 2FA; region management (super_admin); settings (**radio on/off switch, title, stream URL, optional now-playing URL**; byline option; `max_city_admins`; `peer_edit_enabled`); audit log; stats.

Both layouts show a clear banner of the user's **scope** («شما برای … منتشر می‌کنید») and only offer permitted targets. The target selector for province admins: «کل استان» or a multi-select of cities. Build the Jalali picker yourself (no library): month grid, Persian digits, week starting Saturday, Friday highlighted.

**Radio settings (super_admin only, desktop Settings page):** a toggle labelled «رادیو فعال باشد», a title, the stream URL, an optional now-playing URL, and a "test" button that plays the URL inside the admin page. Validate `http(s)` URLs and refuse an `http:` stream when `PUBLIC_URL` is `https:` (mixed content) with a clear Persian error. Saving writes to `audit_log` and invalidates the public micro-cache so the change shows within seconds.

---

## 9. Visual design (beautiful, but light)

The owner cares that it looks **beautiful**. Calm, modern, editorial, trustworthy; university **blue** as the identity color (the owner believes PNU's color is blue; if a logo file is placed in `public/brand/` later, derive colors from it — keep all colors as CSS custom properties so re-branding is a 5-minute change).

- **Typography:** Vazirmatn (self-hosted `woff2`, `font-display: swap`, only needed weights 400/500/700, Persian+Latin subset). The owner's existing project in `/workspace/PnuCard` already uses Vazirmatn — check it and **copy the font file** from there; if absent, ask the owner to provide the files. System-font fallback stack. Line-height ≥1.8 for body text, comfortable measure for reading.
- **Tokens (suggested start, refine as needed):** light — background `#F4F7FB`, surface `#FFFFFF`, text `#0E1A2B`, muted `#5B6B80`, border `#E2E8F0`, primary `#1F5FBF`; dark — background `#0B1220`, surface `#121B2D`, text `#E8EEF8`, muted `#9AA9BF`, border `#22304A`, primary `#6FA3F5`. Scope badge colors: country = primary blue, province = teal, city = amber (all meeting WCAG AA in both themes).
- **Style:** generous whitespace, 14–16 px radius, 1 px borders instead of shadows, bold clear hierarchy, cards that read well at a glance, urgent items with a colored right-edge accent. RTL-correct icons/arrows. Respect `safe-area-inset-*` on notched phones.
- **Theme:** default follows `prefers-color-scheme`; manual toggle (auto/light/dark) saved in `localStorage`; apply the theme with a tiny **external** blocking script in `<head>` so there is no flash (CSP forbids inline scripts).
- **Icons:** a small inline SVG sprite you write yourself (no icon library).

## 10. Performance rules (low-end phones are a first-class target)

- **No** `backdrop-filter`/blur, big or stacked `box-shadow`s, heavy gradients, parallax, or JS-driven animation. Only short (≤150 ms) `opacity`/`transform` transitions; disable all motion under `prefers-reduced-motion`.
- First page weight (HTML+CSS+JS+font, excluding images) **< 150 KB gzip**. Split JS by page (reader vs admin); admin code never loads for readers.
- Precompress static assets (gzip + brotli via `node:zlib`) at startup and serve with `Accept-Encoding` negotiation, `ETag`, and long `Cache-Control` with content-hashed or versioned filenames.
- Images: explicit width/height to prevent layout shift, `srcset`/`sizes`, lazy loading, dominant-color placeholders.
- Feed requests are small (12 items), keyset-paginated, micro-cached; avoid N+1 queries (fetch cover/attachments with joins or batched queries).
- Event handlers delegated; avoid large DOM; recycle far-off cards.

## 11. Dates and time (Iran)

- Store and transmit **UTC** (ISO 8601). Display **Jalali (Persian) calendar, Asia/Tehran, Persian digits** everywhere, using `Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', … })`. Month names in Persian (فروردین … اسفند).
- Relative time for recent items, absolute Jalali date+time for older ones (e.g. «۳ آبان ۱۴۰۵ — ۱۴:۳۰»).
- Admin pickers take Jalali input in Iran time and convert to UTC server-side. Provide `src/lib/jalali.js` (Gregorian⇄Jalali conversion, shared by server and client) with unit tests including leap years and month boundaries. Set `TZ=Asia/Tehran` for log readability only; never rely on it for stored data.

## 12. Images and files

- **Images (processed at upload time, synchronously with a concurrency limit of 2):** accept JPEG/PNG/WebP/HEIC-if-supported, max 12 MB and 40 MP (`limitInputPixels`), max 10 images per news. With `sharp`: `rotate()` from EXIF, **strip all metadata (including GPS)**, convert to **WebP** (quality ≈75) in widths **400 / 800 / 1280**; covers are cropped to 16:9 (400×225, 800×450, 1280×720); compute `dominant_color`; **discard the original**. Reject SVG. Detect type by magic bytes, never by client MIME/extension.
- **Files:** allowlist PDF, DOC/DOCX, XLS/XLSX, PPT/PPTX, ZIP, TXT, CSV; max 15 MB each, max 8 per news; validate magic bytes (`%PDF`, `PK\x03\x04` for OOXML/ZIP, `D0CF11E0` for legacy Office); store under a random name (original name only in DB); serve only through `/files/:id` as attachment with `nosniff`; never from an executable path.
- Layout: `uploads/img/YYYY/MM/<random>-<w>.webp`, `uploads/files/<random>`. Images get `Cache-Control: public, max-age=31536000, immutable`.
- Multipart parsing with `busboy` and hard size limits (streams, abort on overflow).

## 13. Security checklist

Parameterized SQL only; sanitize all rich text with `sanitize-html` (allowlist: p, br, strong, em, h2, h3, ul, ol, li, blockquote, a[href,target,rel], img from our own `/media/` only); escape all output; strict CSP (`default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; frame-ancestors 'none'`), `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`; `trust proxy` configured (`TRUST_PROXY`) so `req.ip`/protocol are right behind NPM; rate limits on login/TOTP/uploads/public API; generic auth errors; secrets only in `.autostart` (`.gitignore` it and `uploads/`, `node_modules/`); audit log without secrets; graceful shutdown; `/healthz` endpoint (no auth, no data).

## 14. Seed data (regions)

Seed **all 31 provinces** and, for each province, its **counties (شهرستان)** as `city` nodes (the "main cities" of each province). Do **not** seed districts, rural districts, or villages.

- Primary source (GitHub): **`sajaddp/list-of-cities-in-Iran`** (provinces JSON + counties/شهرستان JSON). Fallback: **`ahmadazizi/iran-cities`** (tables `ostan`, `shahrestan`). Check each repo's license, record the source and license in `data/SOURCES.md`, download only provinces + counties, **normalize** Persian characters (ي/ك → ی/ک, fix half-spaces/ZWNJ, trim, dedupe), sort with Persian collation, and **vendor the cleaned result as `data/regions.json`** committed to the repo (so seeding never needs the internet again).
- If you cannot download (no internet), tell the owner exactly which two files to put in `data/raw/` and continue once they do.
- `scripts/seed.js` is **idempotent** (upsert by `code`/name+parent): creates the country root («جمهوری اسلامی ایران» / "کل کشور"), provinces, counties, categories, default settings. Re-running never duplicates or deletes data.
- All regions are created **hidden-by-default** (auto visibility) — they become public as province admins create users for them (section 3).
- Note in the docs that PNU's real organizational units may not map 1:1 to administrative counties; super_admin can rename/add regions in the desktop admin.

## 15. Project layout and deployment contract

### 15.1 Layout (suggested)

```
PnuNews/
  server.js                 # entry: loads config, runs migrations check, starts HTTP + scheduler
  package.json  package-lock.json
  .autostart.example  .env.dev.example  docker-compose.dev.yml  .gitignore  README.md  PROMPT.md
  src/ {config.js, db.js, app.js, routes/, auth/(policy.js,totp.js,sessions.js), lib/(fa.js,jalali.js,images.js,uploads.js,static.js,ratelimit.js), scheduler.js}
  migrations/  scripts/ (migrate.js, seed.js, create-super-admin.js, reset-2fa.js, restart.sh, make-deploy-branch.sh)
  data/ (regions.json, SOURCES.md)
  public/ (reader/, admin/, shared/, fonts/, icons/, manifest.webmanifest, sw.js)
  uploads/                  # runtime, git-ignored, already exists
  test/  docs/ (ARCHITECTURE.md, DECISIONS.md, OPERATIONS.md)
```

### 15.2 Environment variables (`.autostart.example`)

```
PORT=3010
NODE_ENV=production
TZ=Asia/Tehran
PUBLIC_URL=https://news.pnu.ac.ir
TRUST_PROXY=1
DB_HOST=mariadb
DB_PORT=3306
DB_NAME=pnu_news
DB_USER=pnu_news
DB_PASSWORD='CHANGE_ME'
APP_SECRET='CHANGE_ME_64_HEX_CHARS'
UPLOAD_DIR=/workspace/PnuNews/uploads
```

In the docs, tell the owner to generate `APP_SECRET` with `openssl rand -hex 32`. `.env.dev.example` mirrors these variables for the Mac (`DB_HOST=127.0.0.1`, `PUBLIC_URL=http://localhost:3010`, `NODE_ENV=development`, `UPLOAD_DIR=./uploads`). The app must refuse to start with a clear Persian+English message if required variables are missing or still `CHANGE_ME`.

### 15.3 Run modes

**Local (Mac):** `npm run dev` (loads `.env.dev`, connects to the dev MariaDB from `docker-compose.dev.yml`, restarts on file changes using Node's built-in `--watch`). `package.json` scripts: `dev`, `start`, `migrate`, `seed`, `create-admin`, `test`.

**Production:** started by `start-all.sh` through `.autostart`. For a manual test run on the server, give the owner: `docker exec -it nodejs bash -lc 'cd /workspace/PnuNews && set -a && . ./.autostart && set +a && node server.js'`.

`start-all.sh` only scans folders when the container starts, so the **very first** activation needs one `docker restart nodejs` (it briefly restarts PnuCard too; advise a quiet hour). **Later updates** (after `git pull`) restart only this site with `docker exec nodejs bash /workspace/PnuNews/scripts/restart.sh`: the script finds the `node server.js` process whose `/proc/<pid>/cwd` is `/workspace/PnuNews` and kills it, and `start-all.sh` respawns it after 3 seconds. It must never touch PnuCard's process.

### 15.4 Dependencies: local vs server

- **Local (Mac):** plain `npm install` (arm64 binaries for `sharp`). `node_modules/` is git-ignored on `main`.
- **Server:** Linux x86_64 (glibc), and its npm registry access is currently blocked, so production must not rely on `npm install` running there. Provide **both** options and document them in `docs/OPERATIONS.md`:
  1. *If the server's npm works* (the owner is fixing a proxy): `docker exec -w /workspace/PnuNews nodejs npm ci --omit=dev`.
  2. *Pull-only `deploy` branch (needs no registry access on the server):* `scripts/make-deploy-branch.sh`, run on the Mac, builds a branch **`deploy`** = current `main` + a production `node_modules/` installed for the server platform (`npm ci --omit=dev --os=linux --cpu=x64 --libc=glibc` into a temp dir, then force-added) and pushes it with `--force`. The server then just runs `git pull` on `deploy`. Document the trade-off (bigger repo; keep `deploy` out of normal work) and make the script verify that `sharp`'s linux-x64 binary is present.
- Pin exact versions and commit `package-lock.json`.

### 15.5 Git and GitHub (STOP checkpoint)

- Initialize git locally (default branch `main`) with a `.gitignore` (`.autostart`, `.env*` except the examples, `uploads/`, `node_modules/` on `main`, OS junk) and commit in small logical steps with **Persian** messages.
- The GitHub repository already exists: `https://github.com/RealDream-Lab/PnuNews`. **Use the SSH remote** `git@github.com:RealDream-Lab/PnuNews.git` (`git remote add origin ...`), never HTTPS with tokens. Before the first push run `ssh -T git@github.com`; if authentication fails, stop and tell the owner how to add an SSH key to his GitHub account. Never generate or upload keys on his behalf without telling him, and never print or commit private keys.
- The remote may already contain commits (README, license). `git fetch` first and merge or rebase them into local `main` before pushing; **never force-push `main`** (only the `deploy` branch may be force-pushed). Push to this remote only.
- The first deploy on the server must adopt the existing `PnuNews/` folder (it already holds a git-ignored `uploads/` directory, so a plain `git clone` into it would fail). Document exactly: `cd /opt/docker/nodejs/workspace/PnuNews && git init -b main && git remote add origin git@github.com:RealDream-Lab/PnuNews.git && git fetch && git checkout -t origin/main` (or `origin/deploy`), then create `.autostart` from `.autostart.example`.
- If the repository is private, the server needs read access through a **read-only deploy key**. Document how to create it on the server (`ssh-keygen -t ed25519`, then add the public key under the repo's Settings, Deploy keys, without write access) and how to test it (`ssh -T git@github.com`).
- Normal update flow to document: Mac, commit, `git push`; on the server `git pull`; migrations run automatically at startup; then `docker exec nodejs bash /workspace/PnuNews/scripts/restart.sh`.
- Database migrations are applied automatically by `server.js` at startup (guarded by `GET_LOCK` so concurrent restarts are safe) and can also be run with `node scripts/migrate.js`.

## 16. Database bootstrap

### 16.1 Local development (you do this yourself, without asking)

`docker compose -f docker-compose.dev.yml up -d`, then `npm run migrate`, `npm run seed`, `npm run create-admin` (interactive, local testing only). Seeding must be fully automatic and idempotent.

### 16.2 Production (STOP checkpoint)

The **owner** creates the production database and a dedicated user on the server; the app itself creates the tables and seeds the data (`migrate` + `seed`). Never use or ask for the MariaDB root password. Print exactly this for the owner, with instructions to choose a strong password and write it only into the server's `.autostart`:

```
docker exec -it mariadb mariadb -u root -p
```
```sql
CREATE DATABASE pnu_news CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'pnu_news'@'%' IDENTIFIED BY 'CHANGE_ME_STRONG_PASSWORD';
GRANT ALL PRIVILEGES ON pnu_news.* TO 'pnu_news'@'%';
FLUSH PRIVILEGES;
```

Ask the owner to verify with `docker exec -it mariadb mariadb -u pnu_news -p pnu_news -e "SELECT DATABASE(), CURRENT_USER();"` and wait. Then give the owner the production commands, run through the container: `docker exec -w /workspace/PnuNews nodejs node scripts/migrate.js`, `docker exec -w /workspace/PnuNews nodejs node scripts/seed.js`, and `docker exec -it -w /workspace/PnuNews nodejs node scripts/create-super-admin.js` (interactive), followed by the activation step in 15.3.

## 17. Reverse proxy instructions to give the owner (STOP checkpoint)

In Nginx Proxy Manager → Proxy Hosts → Add:
- Domain: `news.pnu.ac.ir` (or the real one), Scheme `http`, Forward Hostname `nodejs`, Port `3010`, Block Common Exploits **on**, Websockets off.
- SSL: request/attach a certificate, Force SSL, HTTP/2.
- **Access List / Authelia: none.**
- Advanced tab → add: `client_max_body_size 30m;` (NPM's default is 1 MB and would break uploads) and a reasonable `proxy_read_timeout 60s;`.

## 18. Milestones

- **M0** Scaffold, config validation, `.autostart.example`, `.env.dev.example`, `docker-compose.dev.yml`, docs skeleton, `.gitignore`; git init (Persian commit messages); local MariaDB up and migrated. → report.
- **M1** Migrations, seed (regions/categories/settings), CLI scripts. Tests for normalization.
- **M2** Auth: password, TOTP, backup codes, sessions, trusted device, throttling, must-change-password, devices page. Tests incl. RFC 6238 vectors and the cookie/lifetime logic.
- **M3** Policy module + user management API + region visibility + audit. Exhaustive policy tests (every role × action × region combination class).
- **M4** News CRUD, targets, scheduling/expiry scheduler, uploads/image pipeline/files, sanitization.
- **M5** Public API (feed, news, config, radio proxy, OG pages), micro-cache, keyset pagination tests.
- **M6** Reader UI (feed, picker, news page, radio bar, themes, PWA).
- **M7** Admin UI (mobile quick-compose + desktop management), Jalali picker.
- **M8** Polish: accessibility pass, performance budget check, README (Persian) + OPERATIONS (backups: `docker exec mariadb mariadb-dump …` and copying `uploads/`; restore; adding a province admin; resetting 2FA), final end-to-end checklist; `make-deploy-branch.sh` and `restart.sh` tested; then walk the owner through the STOP checkpoints for GitHub (15.5), production DB (16.2), first deployment (15.3/15.4) and reverse proxy (17).

## 19. Out of scope for v1 (leave clean extension points)

- **Push notifications** (not built). Emit an internal `news.published` event from one place so a later notifier (Web Push, and/or posting to messenger channels such as Telegram/Eitaa/Bale via bots) can subscribe without touching core code.
- Approval workflow, comments, user accounts for readers, multi-language.

## 20. Definition of done

- All tests green locally (`npm test`, Node's built-in runner against the dev DB).
- A province admin created by the super admin can create a city admin; that city appears in the public picker; a news item targeted at the province shows for readers of its cities; a city admin sees other cities' news read-only and cannot edit them; a second active city admin for the same city is rejected while `max_city_admins=1`; the radio bar disappears when `radio_enabled=0`; all verified by tests.
- 2FA flow verified: first-login enrollment; daily password re-entry with the device cookie skipping the code; code required again after 30 days (test with injected clock).
- Uploads: oversize/forbidden/spoofed-extension files rejected; images come out as WebP in three sizes with no EXIF/GPS.
- Reader page meets the performance budget and works in light and dark on a 360 px-wide viewport and on desktop.
- Every news item permanently shows and stores its publisher.
- Docs let a non-developer restart, back up and restore the system.
