# NanoClaw UI

A local web console for NanoClaw. Every action is an `ncl` command underneath —
the UI adds no logic of its own, so it can't drift from the CLI.

```bash
nanoclaw-ui           # → http://127.0.0.1:7799
```

Bound to `127.0.0.1` only, by design: this is the admin plane (it can add
mounts, install skills and wire channels).

## What it does

- **Bots** — create from a plain-English mission, run on demand, watch the
  result in the page, switch runtime (Claude / Codex / Ollama), restart, delete.
- **Keys** — per bot. Give a key an *API host* and it goes to the OneCLI vault,
  injected into requests to that host; the bot never sees the value. Without a
  host it's a plain setting in `groups/<bot>/bot.env`.
- **Skills** — add per-bot from a GitHub URL or a dropped `.zip`; the bot
  restarts to pick them up.
- **Runs** — every run from every bot in one scrollable feed, newest first, with
  the agent's markdown rendered (headings, lists, links, code). Filter by bot or
  search the text; long runs clip with a Show more. Thumbnails a bot wrote are
  rendered inline — bare paths, backticked paths and markdown images all work,
  served only from the mount allowlist and the groups directory.
- **Channels** — connect a Discord channel to a bot.
- **Schedules** — run / pause / resume, last result and full run history.

Light and dark themes; the toggle sits in the host-status box.

## Layout

- `server.mjs` — zero-dependency Node HTTP server, shells out to `bin/ncl --json`
- `index.html` — the whole front end, no build step
- `design/` — the design canvas the UI was built from (`.dc.html` artboards)

## Install (any NanoClaw v2 checkout)

```bash
pnpm run ui
```

No build step and no dependencies beyond what NanoClaw already has. It shells
out to this checkout's `bin/ncl`, so it manages whatever install it sits in.

Optional environment:

| Variable | Default | Purpose |
|---|---|---|
| `NANOCLAW_UI_PORT` | `7799` | Port to listen on (localhost only) |
| `NANOCLAW_UI_ONECLI_BIN` | `onecli` | Path to the OneCLI binary, if not on `PATH` |
| `NANOCLAW_UI_ONECLI_PROJECT` | *(CLI default)* | Override the vault project |

Vault-backed keys need a working OneCLI gateway — the same one NanoClaw already
uses for its own credentials. Everything else works without it.
