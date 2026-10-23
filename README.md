# Trakt to MyDramaList

A Tampermonkey userscript that syncs your **Trakt** watched history into your **MyDramaList (MDL)** list with one click.

MDL has no import feature and no public API. This script runs inside your logged-in MDL tab. It reads your history from the Trakt API, finds each title on MDL, and adds or updates it on your list using MDL's own save request.

> Unofficial. Not affiliated with Trakt or MyDramaList. Automated adding is against MDL's terms of use, so the script works slowly on purpose. Use it at your own risk.

---

## Features

- **One-click sync.** Click **⟳ Sync from Trakt** and the script fetches your history, matches titles, adds new ones, updates progress and checks the result.
- **Asian live-action only.** Titles are filtered by Trakt's `country` field (JP, KR, CN, TW, TH, HK, PH, SG, MY, ID, VN). Western shows and anime/animation are skipped, because MDL doesn't list anime.
- **Seasons split the way MDL does.** Trakt keeps a show as one entry with seasons. MDL lists each season as its own title. The script makes one row per season you watched and matches it by season number, year and episode count. Two seasons can never be matched to the same MDL entry.
- **Correct status.** A season is **Completed** only if you watched every episode *and* it has finished airing. Anything else is **Currently Watching**, with the last episode you watched.
- **Progress updates.** If you watched more episodes on Trakt, the MDL entry moves forward, and a "Watching" entry becomes "Completed" when you finish. Progress never goes backwards. Entries set to Completed, On Hold, Dropped or Plan to Watch are never changed.
- **Leaves your MDL data alone.** Updates send only the status and episode count. Rating, notes, start/finish dates and rewatch count are not sent.
- **Checked against your real list.** After each run the script asks MDL what is actually on your list. A row only shows **DONE** when the title is confirmed there.
- **Review panel.** Uncertain matches wait for you to choose. You can filter rows by status and export the results to CSV.

---

## Requirements

- A browser with [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Edge, Firefox, Brave, etc.)
- A MyDramaList account, logged in
- A Trakt account with a **public** profile
- A Trakt API **Client ID** (free; setup is below)

---

## Install

1. Install Tampermonkey.
2. Open the raw script and Tampermonkey will offer to install it:
   **https://raw.githubusercontent.com/akumaru1/trakt-to-mdl/main/trakt-to-mdl.user.js**
3. When Tampermonkey asks whether the script may connect to `api.trakt.tv`, click **Always allow**.

You get updates automatically if the script header has `@updateURL` / `@downloadURL` pointing at the raw link above.

---

## Setup (once)

### 1. Create a Trakt API app

1. Go to **developer.trakt.tv → My Apps → Create app**.
2. Fill in:

   | Field | Value |
   |---|---|
   | App name | `Trakt to MDL` (anything) |
   | App type | **Development** |
   | Redirect URIs | `http://localhost:8080/callback` (not used; just needs a valid value) |
   | Allowed origins | `https://mydramalist.com` |

3. Click **Create app** and copy the **Client ID**. You don't need the Client Secret.

### 2. Enter it in the script

1. Open [mydramalist.com](https://mydramalist.com) and click the **Trakt → MDL** button (bottom right).
2. Click **Settings**, paste the Client ID, and enter your Trakt username.

The Client ID is stored only in your browser's local storage. It is never written into the script file.

### 3. Teach the script how MDL saves a title

MDL's save request isn't documented, so the script learns it by watching you save one title yourself. You do this once for each status.

**Completed**
1. Click **Capture "Completed"** and type the full episode count of a drama you've finished that is **not on your list yet** (for example `11`).
2. Open that drama's MDL page, click **Add to List**, choose **Completed**, leave Episodes Watched at the full count, and click **Save**.
3. A green *Captured* message appears.

**Watching**
1. Click **Capture "Watching"** and type a number, for example `3`.
2. Open a drama you're partway through that is **not on your list yet**, choose **Currently Watching**, set Episodes Watched to `3`, and click **Save**.

The top of the panel should now show both captures with an episode field:

```
✔ completed: PATCH /v1/users/watchaction/…  | episode field: episode_seen
✔ watching:  PATCH /v1/users/watchaction/…  | episode field: episode_seen
```

> The script ignores MDL's page-load and analytics requests. It only accepts a request that contains the episode number you typed. If it sees other requests while waiting, they're listed with a **Use** button so you can pick the right one by hand.

---

## Usage

Open MDL → **Trakt → MDL** → **⟳ Sync from Trakt**.

That's all. Each sync:

1. Fetches your watched shows and movies from Trakt. If Trakt doesn't include per-season episode data, it rebuilds it from your episode history.
2. Searches MDL for anything new, about one search every 1.5 s.
3. Checks which titles are already on your MDL list.
4. Adds confident new matches and updates entries that are behind, one every ~4 s.
5. Checks every change against your real list.

Running it again when nothing has changed sends nothing.

### Row badges

| Badge | Meaning |
|---|---|
| **READY** | Matched, will be added on the next sync |
| **REVIEW** | Several possible matches; pick one from the dropdown |
| **NO MATCH** | Nothing found on MDL; paste the MDL URL via *Paste MDL URL…* or skip it |
| **UPDATE** | On your list but behind Trakt; will be moved forward |
| **DONE** | Added or updated, and confirmed on your list |
| **ON LIST** | Already on your list and up to date |
| **NOT ADDED** | MDL replied OK, but the title isn't on your list |
| **ERROR** | The request failed; the reason is shown under the badge |
| **SKIP** | You chose to skip this title |

Use the **Show:** dropdown to list only one badge type, for example only REVIEW or ERROR.

### Fixing a row

- **Wrong match:** choose another candidate in the dropdown, use **Paste MDL URL…**, or choose **Skip this title**. The ↗ link opens the selected MDL page.
- **Wrong status or episodes:** change them in the row. Manual changes stick and are not overwritten by later syncs.

### Other buttons

| Button | What it does |
|---|---|
| **Stop** | Stops after the current request |
| **Re-check my list** | Asks MDL again which titles are on your list |
| **Export CSV** | Downloads every row with its MDL match and result |
| **Clear captures & failed** | Deletes both captured requests and resets failed rows (matches are kept) |
| **Reset all** | Clears all rows, matches and captures (settings are kept) |

---

## How matching works

Each MDL search result gets a score:

- title similarity to the Trakt title (and to "Title Season N" / "Title N" for later seasons)
- release year (the season's own first-air year for multi-season shows)
- type (movie vs drama; specials score lower for shows)
- episode count vs the Trakt season
- season number in the MDL title (`Season 2`, `2nd Season`, `Part 2`, trailing `2` or `II`)

A match is chosen automatically only when the top score is high and clearly ahead of the runner-up. Everything else goes to **REVIEW**.

---

## Privacy

- Your Trakt Client ID and username are kept in your browser's `localStorage` on mydramalist.com.
- Requests go only to `api.trakt.tv` (to read your public history) and to mydramalist.com (search, your list, and saving entries using your logged-in session).
- Nothing is sent anywhere else.

---

## Limitations

- **Your Trakt profile must be public.** Private profiles would need Trakt OAuth, which isn't implemented.
- **MDL search is the weak spot.** Brand-new titles MDL hasn't listed yet, or titles with very different English names, end up in REVIEW / NO MATCH.
- **MDL season naming varies.** Entries like "Ryosangata Riko: Prototype" instead of "Season 2" may need a manual pick.
- **Not copied:** per-episode watch dates (MDL has none), Trakt ratings, rewatch counts.
- **Variety shows** with hundreds of episodes may be missing on MDL or split by year.
- **MDL changes can break it.** If MDL changes its save request, capture again with **Clear captures & failed** → Capture.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Trakt refused (401/403)` | Check the Client ID in **Settings** and that your Trakt profile is public |
| `Trakt user not found` | Check the username in **Settings** |
| Only movies appear, no shows | Check the `Trakt: … history entries` line. If it shows 0, Trakt returned no episode history for your account |
| `Could not read your MDL list` | Log in to MDL and reload the page |
| Capture never finishes | Make sure you actually click **Save** in the Add to List dialog, on a title **not** already on your list, using the same episode number you typed |
| `episode field: NOT FOUND` | Capture again; Episodes Watched must equal the number you typed |
| Many **NOT ADDED** / **ERROR** with 401/403/419 | Your MDL session or the captured request expired. Click **Clear captures & failed** and capture again |
| Two **Trakt → MDL** buttons | An older copy of the script is still installed; remove it in Tampermonkey |

---

## Disclaimer

This project uses unofficial, undocumented MyDramaList endpoints and may stop working at any time. Automated list changes may violate MyDramaList's terms of service. The script is rate-limited and only acts on your own account, but you use it at your own risk.
