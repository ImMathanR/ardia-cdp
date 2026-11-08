---
name: ardia
description: Open, check, inspect and drive web pages in the Ardia browser via the Chrome DevTools Protocol, in the right Ardia profile ("per" = Personal, "work" = Work; Arc's spaces became Ardia profiles), reusing a tab that already shows the page instead of opening a duplicate; also show a tab live inside a terminal pane (only after the user asks to open, look at, check, debug, or drive a page in Ardia; requires Ardia's "Let the ardia command control Ardia" setting on).
---

# Ardia CDP

Lightweight Chrome DevTools Protocol CLI for the [Ardia](https://github.com/mantrakp04/ardia) browser, the open-source
Chromium browser with Arc's sidebar. Same commands and the same per/work behaviour as `/arc` (arc-cdp). Arc's spaces
import into Ardia as **profiles**, each with its own logins, so "space" below means an Ardia profile.

The engine is `~/.claude/skills/ardia/scripts/ardia-cdp.mjs`, referred to as `ardia-cdp`; run it with
`node ~/.claude/skills/ardia/scripts/ardia-cdp.mjs <command>`.

## Prerequisites

Everything goes through Settings › **Let the ardia command control Ardia** (on; a small "ardia is controlling Ardia"
pill shows while a command runs). Check with `ardia windows`. It gives two channels:

- **CDP over the token path.** `ardia-cdp` reads `<data dir>/Chromium/ArdiaControl.json` (port, browser path,
  token) and connects to `ws://127.0.0.1:<port><browser>?token=…`. Ardia's engine policy refuses, on this path:
  cookies (`Network.getCookies`/`setCookie`…), emulation (viewport, device, UA, geo), `DOM.setFileInputFiles`
  (upload), download behaviour, tracing, screencast and HTML5 drag interception. Everything else here works.
- **The control socket**, for what CDP can't see: which profile each tab is in, and switching profiles.

A released, signed Ardia ignores `ARDIA_REMOTE_DEBUGGING_PORT` on the real profile; it opens a plain, unrestricted
port only for a scratch `ARDIA_DATA_DIR` or a self-built app. If that variable is set for GUI apps (for example by a
LaunchAgent), `ardia-cdp` tries that port first and falls back to the token path. If a task truly needs a refused
method on the user's real logins, say so; don't work around the policy.

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
- It prints the target to use for everything else, e.g. `Reused open tab in Work: 2BAE3E8E  Title  URL`.
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

## Ardia's own command line

Ardia ships the `ardia` command (in `~/.local/bin`), useful beyond `ardia-cdp`:

- `ardia windows [--json]`: every window and tab with its profile. `ardia run <command>`: run Ardia's own commands
  (`ardia commands` lists them: `newTab`, `nextProfile`, `toggleSidebar`, `cleanUpTabs`, splits…).
  `ardia events` / `ardia on tab.navigated -- prog`: react to browser events.
- `ardia browse <agent-browser args>`: agent-browser's command line on the running Ardia (`open`, `snapshot -i`,
  `click @e1`, `fill`, `screenshot`…), acting in the front window's profile, through the same token path and policy.
- `ardia exec '<python>'`: run Python against the running Ardia (top-level await; `tab`, `tabs`, `new_tab`, `js`,
  `history`, `windows`, `run`, `events` are in scope).
- `ardia config set KEY VALUE` edits `~/.config/ardia/config.json` (Ardia reads it live).

## A tab live inside a terminal pane (`ardia-pane.mjs`)

Shows one Ardia tab — not the whole window — inside a terminal pane, and works while the tab is in the **background**
behind other tabs. Clicks, scrolls and keys in the pane go back to the page over CDP.

```bash
ardia-pane.mjs <url> [--space per|work] [--split]   # open (or reuse) the page and show it here
ardia-pane.mjs --target <prefix>                    # a tab that is already open
```

- Needs **Ghostty** (kitty graphics, passed through tmux with `allow-passthrough on`) and **tmux** for `--split`.
- When the tab is in front, a small ScreenCaptureKit helper (`bin/ardia-frames`, built from `ardia-frames.swift`)
  streams the window: GPU-scaled, shared memory, near instant. It needs **Screen Recording** permission for the
  terminal.
- When the tab is in the background, Ardia's own policy refuses screencasts, so the pane takes CDP screenshots; a
  background tab only draws when screenshotted, so its video plays at the screenshot rate (about 5 a second while
  the picture changes, back to back right after input).
- Keys: `^L` go to URL, `^R` reload, `^O` back, `^Q` quit. Everything else goes to the page.
- `ARDIA_PANE_LIVE=0` forces the screenshot path; `ARDIA_PANE_LOG=<file>` writes a timeline of frames.

Use it when the user wants to watch or drive a page without leaving the terminal. Don't start it unprompted: it
takes a real pane and, on the screenshot path, a few percent of CPU.

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

```bash
node scripts/test_ardia_spaces.mjs    # profile/tab mapping
node scripts/test_pane_render.mjs     # pane drawing and input helpers
python3 scripts/test_jev_browse.py   # the Jev loop, with a fake browser
```

End to end against a scratch instance (never the user's profile):

```bash
S=~/ardia-scratch/t1   # short path: the control socket's path must fit in 103 bytes
open -g -n --env ARDIA_BACKGROUND=1 --env ARDIA_DATA_DIR=$S --env ARDIA_REMOTE_DEBUGGING_PORT=9333 /Applications/Ardia.app
ARDIA_DATA_DIR=$S ARDIA_CDP_PORT=9333 node scripts/ardia-cdp.mjs tabs
```

A scratch instance's `session.json` needs `settings.cliControl: true` (edit it while that instance is quit);
`cliControl` is deliberately not settable from config.json.
