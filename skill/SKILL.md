---
name: ardia
description: Open, check, inspect and drive web pages in the Ardia browser (Arc's replacement) via the Chrome DevTools Protocol, in the right Ardia profile ("per" = Personal, "work" = Work; Arc's spaces became Ardia profiles), reusing a tab that already shows the page instead of opening a duplicate (only after the user asks to open, look at, check, debug, or drive a page in Ardia; requires Ardia running with ARDIA_REMOTE_DEBUGGING_PORT and "Let the ardia command control Ardia" on).
---

# Ardia CDP

The `/arc` skill, ported to [Ardia](https://github.com/mantrakp04/ardia), the open-source Chromium browser with Arc's
sidebar. Same commands, same per/work behaviour. Arc's spaces import into Ardia as **profiles**, each with its own
logins, so "space" below means an Ardia profile.

The engine is `~/.claude/skills/ardia/scripts/ardia-cdp.mjs`, referred to as `ardia-cdp`; run it with
`node ~/.claude/skills/ardia/scripts/ardia-cdp.mjs <command>`.

## Prerequisites

Everything goes through Settings › "Let the ardia command control Ardia" (on; a small "ardia is controlling Ardia"
pill shows while a command runs). Check with `ardia windows`. It gives two channels:

- **CDP over the token path.** `ardia-cdp` reads `<data dir>/Chromium/ArdiaControl.json` (port, browser path,
  token) and connects to `ws://127.0.0.1:<port><browser>?token=…`. Ardia's engine policy refuses, on this path:
  cookies (`Network.getCookies`/`setCookie`…), emulation (viewport, device, UA, geo), `DOM.setFileInputFiles`
  (upload), download behaviour, tracing, screencast and HTML5 drag interception. Everything else here works.
- **The control socket**, for what CDP can't see: which profile each tab is in, and switching profiles.

The signed Ardia ignores `ARDIA_REMOTE_DEBUGGING_PORT` on the real profile (it opens a plain, unrestricted port only
for a scratch `ARDIA_DATA_DIR` or a self-built, non-team-signed app: `ArdiaHost+Launch.mm`, `port && mockKeychain`).
The `com.ardia.debug-env` LaunchAgent still sets it to 9224, which helps scratch instances; `ardia-cdp` tries that port
first and falls back to the token path. If a task truly needs a refused method on the user's real logins, say so;
don't work around the policy.

Node.js 22+. Override the port with `ARDIA_CDP_PORT` / `ARDIA_CDP_HOST`, and the data dir (for a scratch instance)
with `ARDIA_DATA_DIR`.

## Opening or checking a page: always `open --space`

```bash
ardia-cdp open <url> --space per     # per  -> the Personal profile
ardia-cdp open <url> --space work    # work -> the Work profile
```

- **Profile comes from the user.** They say "per" or "work"; pass it through as `--space`. If they didn't say which,
  ask ("per or work?") before opening anything. Other profile names work too (exact name).
- **Reuse, don't duplicate.** `open` looks through every Ardia tab (`ardia windows`). If the page is already open and
  loaded in that profile (same URL, ignoring http/https, a trailing slash and `#fragment`), it activates that tab,
  which pages the window to that profile. Otherwise it switches the window to the profile and opens a new tab there.
- **Other profile, other account.** A copy open only in the other profile is not reused; `open` opens the page in
  the requested profile and prints `Also open in <profile>`.
- A tab that's asleep (Ardia freezes background tabs past your latest few, and sleeps them after 30 min) has no CDP
  target, so `open` opens a fresh tab rather than waking it.
- **Quiet by default: the user's page and profile never move.** A new tab is created in the background (Ardia's
  `background` flag) and is not activated; a page already open is used where it is. When the page belongs to a
  profile that isn't in front, the window switches there, opens the tab, and switches straight back — the user may
  see a brief flip, but ends up on the page and profile they had. Pass `--foreground` only when the user asked to
  *see* the page in Ardia: it shows the tab and stays in its profile, the old behaviour.
- It prints the target to use for everything else, e.g. `Using open tab (left in the background) in Work: 2BAE3E8E
  Title  URL`. Drive it with `eval`/`snap`/`click` as usual: CDP reaches a background tab fine (this is also how
  `/ardia`'s pane shows one).
- `--new` forces a fresh tab. `ardia-cdp tabs` lists every tab by profile with its target prefix (`-` = asleep).

## Commands

The `<target>` is a unique targetId prefix from `list` or `open`.

```bash
ardia-cdp list                          # loaded pages
ardia-cdp shot    <target> [file]       # viewport screenshot; prints DPR
ardia-cdp snap    <target>              # accessibility tree (prefer over html)
ardia-cdp eval    <target> <expr>
ardia-cdp html    <target> [selector]
ardia-cdp nav     <target> <url>        # navigate and wait for load
ardia-cdp net     <target>              # resource timing entries
ardia-cdp click   <target> <selector>
ardia-cdp clickxy <target> <x> <y>      # CSS pixels
ardia-cdp type    <target> <text>       # Input.insertText; works in cross-origin iframes
ardia-cdp loadall <target> <selector> [ms]
ardia-cdp evalraw <target> <method> [json]   # raw CDP; on the real profile the token policy above applies
ardia-cdp open    <url> --space per|work
ardia-cdp tabs
ardia-cdp stop    [target]
```

Coordinates: `shot` saves image px = CSS px × DPR; CDP input takes CSS px, so divide screenshot coordinates by the
DPR it prints. Avoid index-based selection across several `eval` calls when the DOM can change between them.

The first command against a tab starts a daemon holding its CDP session (instant after that); it exits after 20 min
idle, when the tab closes, or with `ardia-cdp stop`.

## Handing a tab to the user (`wait`)

When a page needs the user — a login, a 2FA code, a payment — don't stop and ask them to report back. Open (or use)
the tab, then run `wait` **in the background** and tell them what to do; it returns when the page says they're done:

```bash
ardia-cdp wait <target> --hand --until "!!document.querySelector('#inbox')" --timeout 300
# prints: handed over… then: ready after 42.3s: true  https://mail.example.com/inbox
```

- `--until` is a JS expression evaluated in the page every `--interval` (500 ms); truthy ends the wait.
- `--hand` first puts the tab in front of the user (paging the window to its profile), so they can act on it.
- Exit 0 when ready, 1 on timeout (it prints the last value it saw, so you can tell what they're looking at).
- Pick a condition that only holds *after* the step, not one that is already true; `--until "location.pathname !== '/login'"`
  is the usual one. Check first with `eval` if unsure.

## MCP server (`mcp-server.mjs`)

For MCP clients that aren't Claude Code — Cursor, Codex, Zed, or anything that speaks MCP over stdio:

```bash
node ~/.claude/skills/ardia/scripts/mcp-server.mjs          # stdio, newline-delimited JSON-RPC
```

Tools: `open_page` (quiet, `profile`, `foreground`), `list_tabs`, `read_page`, `evaluate`, `navigate`, `click`,
`type_text`, `screenshot` (returns the image), `wait_for` (`until`, `timeout`, `hand`). Each is a call to the same
`ardia-cdp` command, so behaviour and policy are identical. Nothing is installed: point the client at this file.

## Ardia's own command line

Ardia ships the `ardia` command (in `~/.local/bin`), useful beyond `ardia-cdp`:

- `ardia windows [--json]`: every window and tab with its profile. `ardia run <command>`: run Ardia's own commands
  (`ardia commands` lists the 97 allowed: `newTab`, `nextProfile`, `toggleSidebar`, `cleanUpTabs`, splits…).
  `ardia events` / `ardia on tab.navigated -- prog`: react to browser events.
- `ardia browse <agent-browser args>`: agent-browser's command line on the running Ardia (`open`, `snapshot -i`,
  `click @e1`, `fill`, `screenshot`…), acting in the front window's profile, through the same token path and policy.
- `ardia config set KEY VALUE` edits `~/.config/ardia/config.json` (Ardia reads it live).

## Goal-driven browsing with Jev (`jev-browse.py`)

Same loop as the arc skill (observe the accessibility tree, ask Jev one typed question per step, act through
agent-browser):

```bash
B=~/.claude/skills/ardia/scripts/jev-browse.py
python3 $B "Open the Issues tab, then open the first issue" --start https://github.com/browser-use/jev-ultrafast
python3 $B "Find the pricing page and report the team plan price" --ardia   # the user's live Ardia, with logins
```

Default to the private session; use `--ardia` only when the task needs the user's logins, and watch it. It is
bounded (`--max-steps`, default 20); drive anything irreversible yourself.

## Tests

`node scripts/test_ardia_spaces.mjs` (profile/tab mapping, quiet open, handoff polling),
`node --test scripts/test_mcp_server.mjs` (the MCP protocol and tool mapping),
`node scripts/test_pane_render.mjs` (pane drawing and input) and `python3 scripts/test_jev_browse.py`.
End to end against a scratch instance (never the user's profile):

```bash
S=~/ardia-scratch/t1   # short path: the control socket's path must fit in 103 bytes
open -g -n --env ARDIA_BACKGROUND=1 --env ARDIA_DATA_DIR=$S --env ARDIA_REMOTE_DEBUGGING_PORT=9333 /Applications/Ardia.app
ARDIA_DATA_DIR=$S ARDIA_CDP_PORT=9333 node scripts/ardia-cdp.mjs tabs
```

A scratch instance's `session.json` needs `settings.cliControl: true` (edit it while that instance is quit);
`cliControl` is deliberately not settable from config.json.
