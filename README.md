# Hardpoint Planner

A self-hosted Star Citizen loadout optimizer for Unraid (or any Docker host).

- **Best loadout for any ship**: picks weapons, shields, power plants, coolers and quantum drives for your goal (PvE, PvP, stealth, travel), with per-slot overrides.
- **Where to buy it**: the fewest store stops to buy every part, with the store, place, planet or moon, and star system.
- **Ship profile**: what each ship is best at and its strengths and weaknesses, rated against ships of the same size.
- **Your Fleet**: add the ships you own, give them nicknames, pick their liveries, fit their parts (or fill with a PvE/PvP/Stealth/Travel preset), and see full stats: burst/sustained/alpha DPS, damage mix, shield HP and regen, quantum speed and travel times, power, cooling, flight performance, cargo and signature. Saved on the server in `/data/fleet.json`, so it's the same on every device.
- **Ask**: a general question tab ("which of my ships is best for bounty hunting?", "what should I buy next?") that knows every ship's stats and your fleet with its fitted parts. Each ship in the Planner also has its own question box. Answered by Google Gemini; if a model hits its free limit, the app switches to the next available one automatically, and you can pick a model from a dropdown.
- **Stays current**: refreshes game data and store prices on a schedule.

## Install on Unraid

### Option A: Docker template (recommended)

1. Copy `unraid/hardpoint-planner.xml` to `/boot/config/plugins/dockerMan/templates-user/` on your Unraid flash drive (for example with the File Manager, or `wget` from the raw GitHub URL).
2. In Unraid go to **Docker → Add Container**, choose **hardpoint-planner** from the **Template** list.
3. Paste your **Gemini API key** (free from <https://aistudio.google.com/apikey>), then **Apply**.
4. Open `http://YOUR-UNRAID-IP:8080`.

### Option B: Compose Manager plugin

Create a new stack, paste `docker-compose.yml`, fill in `GEMINI_API_KEY`, and **Compose Up**.

### If Unraid can't pull the image

GitHub publishes the image as **private** at first. Either:

- make it public: GitHub → your profile → **Packages** → `hardpoint-planner` → **Package settings** → **Change visibility** → Public, or
- log Unraid in to GitHub's registry once from the Unraid terminal: `docker login ghcr.io -u YSLBoatBoy` with a GitHub token that has `read:packages`.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `GEMINI_API_KEY` | empty | Turns on the question box. Leave empty to hide it. |
| `GEMINI_MODELS` | empty | Optional comma list to limit and order models, e.g. `gemini-3.6-flash,gemini-3.5-flash-lite`. Empty uses every text model your key can access, flash models first. |
| `GEMINI_MAX_OUTPUT_TOKENS` | `2048` | Longest answer allowed. |
| `ASK_LIMIT_PER_10MIN` | `30` | Questions per device per 10 minutes, to protect your quota. |
| `UPDATE_INTERVAL_HOURS` | `12` | How often to refresh game data and prices. `0` = never. |
| `PRICE_MAX_AGE_DAYS` | `180` | Ignore store prices older than this. |
| `UEX_API_TOKEN` | empty | Only needed if UEX starts requiring a token. |
| `GAME_DATA_BASE` | GitHub raw URL | Alternate location for `ships.json` and `ship-items.json`. |
| `PORT` | `8080` | Port inside the container. |

Data is stored in `/data` (map it to `/mnt/user/appdata/hardpoint-planner`): `data.json` holds the refreshed game data and prices, `fleet.json` holds your fleet. Back up `fleet.json` if you care about it.

## How model fallback works

When Gemini says a model is out of quota or overloaded, that model is put on hold and the next one answers:

- **Daily free limit reached**: on hold until midnight Pacific, when Google resets free daily quotas.
- **Per-minute limit or overloaded**: on hold for the delay Google suggests (usually under a minute).
- **Not available to your key**: on hold for 6 hours.

The dropdown shows each model's status. If the model you picked is on hold, the page switches to the first available one and tells you.

## Access from outside your home

Don't port-forward this to the internet; anyone who finds it could use up your Gemini quota. Use Tailscale or a Cloudflare Tunnel instead.

## Data sources

- Ship and part stats: [scunpacked-data](https://github.com/StarCitizenWiki/scunpacked-data) (unpacked game files)
- Store locations and prices: [UEX Corp](https://uexcorp.space) API (player-reported; confirm at the kiosk)
- The image ships with a snapshot from patch 4.10.2-LIVE so it works before the first refresh.

## Run without Docker

```sh
GEMINI_API_KEY=... DATA_DIR=./data node server/index.js
```

Requires Node 20 or newer; there are no npm dependencies.
