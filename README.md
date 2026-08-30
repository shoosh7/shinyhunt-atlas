# a Pokémon Shiny Living Dex Optimizer — the ShinyHunt Atlas

https://shoosh7.github.io/shinyhunt-atlas/

A static website version of my *Ultimate Shiny Living Dex Guide* Google Sheet. It answers one question instantly: **what's the best game and method to hunt any shiny Pokémon**, personalized to the games you own and the methods you prefer — and it tracks your shiny living dex progress.

A tool to help you complete your shiny living dex as easily as possible.

**Features:** instant search (forms, accents, and Nidoran genders all handled) · filter by generation, caught status, or hunting method ("show me everything huntable in PLA outbreaks") · per-generation completion counters · a "Pick my next hunt" button for choice paralysis · a Hunts dashboard tab with per-Pokémon counters, odds presets per method, and cumulative-odds readouts · a mood-based hunt picker (easy & hands-off, nostalgic 3DS, beginner-friendly, colorblind-friendly) · living dex progress tracking · quick-mark mode for entering an existing collection fast · dex-number search · sort by dex, name, or best odds · keyboard counting (↑/↓ while a Pokémon is open) · caught-date stamping · catch celebrations · deep links (yoursite/#gible) · backup download/restore, CSV export, and a shareable progress-card image · optional accounts with cross-device sync.

No build step, no server, no dependencies. Four files:

| File | What it is |
|---|---|
| `index.html` | The page |
| `styles.css` | The look |
| `app.js` | The logic — a faithful reimplementation of the sheet's `BEST()` / `SECOND_BEST()` |
| `data.js` | All 1,081 Pokémon, their method memberships, odds, and the four ranking presets — extracted from the spreadsheet |
| `config.js` | Optional account/sync settings (see "Accounts & sync" below) — safe to leave empty |

## How the BEST engine works

Exactly like the sheet: the 14 hunting methods are walked in **your priority order**, and the first method whose pool contains the Pokémon wins (the second becomes the runner-up). Each pool entry keeps its tag from the sheet:

- `E·` — hunt the **pre-evolution** with this method, then evolve
- `$·` — **soft-reset** static/gift encounter in that game (legendaries, mostly)
- `·✦DLC` — requires that game's DLC

Turning a method off (you don't own the game) removes it from consideration everywhere.

This implementation was verified against the spreadsheet's cached `BEST()`/`SECOND_BEST()` outputs: **1,089 / 1,089 exact matches** (before removing the sheet's 8 'Gen' generation-separator rows) under the sheet's default ranking.


## Publish it free on GitHub Pages

1. Create a repository on GitHub (e.g. `shiny-living-dex`). Public repos get free Pages hosting.
2. Upload these four files to the repository root (drag-and-drop works in the GitHub web UI: **Add file → Upload files**).
3. In the repo: **Settings → Pages → Build and deployment** → Source: **Deploy from a branch** → Branch: `main`, folder `/ (root)` → **Save**.
4. Wait ~1 minute. Your site is live at `https://<your-username>.github.io/shiny-living-dex/`.

Any time you push a change to `main`, the site updates automatically.

## Updating the data

The data lives in `data.js` as one JSON blob (`DEX_DATA`). When you update the Google Sheet, either:

- edit `data.js` by hand for small changes (each Pokémon is `{"n": name, "d": dex, "m": {methodId: code}, "f": form, "c": comment, "s": spriteId}`), or
- re-export the sheet as `.xlsx` and re-run the extraction script (`generate_data.py`, included) to regenerate `data.js`.

Method ids: `pla, za, lg, sv, uw, g4, sos, h, ss, cf, dpr, dn, fs, pr`.

## What's saved where

Game ownership, method order, and caught progress are saved in the visitor's **browser localStorage** — private to them, no account needed, survives reloads. Clearing browser data clears it.

## Accounts & sync (optional)

The site ships with optional accounts powered by [Supabase](https://supabase.com) (free tier — no credit card). With it, visitors can create an email/password account and their caught list, owned games, and method order sync across devices. Without it, the site works exactly as before, saving in each visitor's browser.

**Setup, about 10 minutes:**

1. Create a free account at supabase.com and click **New project**. Pick any name and a strong database password (you won't need it day-to-day).
2. Once the project is ready, open the **SQL Editor**, paste this, and click **Run**:

```sql
create table public.dex_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null,
  updated_at timestamptz default now()
);

alter table public.dex_state enable row level security;

create policy "Users manage their own dex"
  on public.dex_state for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
```

This creates one table where each user's dex lives, with row-level security so users can only ever read and write their own row — even though the site's key is public.

3. Go to **Project Settings → API** (or **Data API**) and copy two values: the **Project URL** and the **anon public** key. Paste them into `config.js`:

```js
window.SUPABASE_CONFIG = {
  url: "https://yourproject.supabase.co",
  anonKey: "eyJhbGciOi…",   // the long anon public key
};
```

The anon key is designed to be public — it's safe to commit. It only grants what your row-level security policy allows.

4. Push to GitHub. The **Sign in** button appears in the top bar automatically.

**Optional polish:** by default Supabase sends a confirmation email on sign-up. In **Authentication → Providers → Email** you can turn "Confirm email" off for instant sign-ups, and in **Authentication → URL Configuration** set your Site URL to your GitHub Pages address so email links point to the right place.

**How syncing behaves:** signing in loads the account's saved setup (cloud settings win) and merges caught lists — a shiny marked caught on any device is never lost. Changes push automatically about a second after you make them; the colored dot next to the account button shows sync status (gold = saving, green = synced, red = a save failed but your browser copy is safe).

## Roadmap ideas

- **Full forms mode** — the sheet's `S-LivingForm` box/row/slot layout could render a visual PC-box dex with every form and gender difference, as a toggle for completionists.
- **Per-game detail pages** — the sheet's location notes (BDSP routes, ORAS DexNav info tab, SOS warnings) could become expandable detail inside each Pokémon's hunt list.
- **Installable app (PWA)** — a small service worker would make the site work offline and installable to a phone home screen.

## Credits

Data, method research, and rankings by **Shoosh**. Shiny sprites served from pokejungle.net. Website created with heavy help from Claude.
