# ardia-cdp

**Let your coding agent — Claude Code, Codex — drive the [Ardia](https://github.com/mantrakp04/ardia) browser, in the right profile, without opening duplicates.**

Coding agents speak the Chrome DevTools Protocol; that's how Claude Code's `/chrome-cdp` drives Chrome. Ardia is
Chromium too — but it's a different browser, with **profiles** that each hold their own logins, and with a control
channel of its own. `ardia-cdp` is a small, dependency-free client that talks to it: the same commands as `/arc`
(arc-cdp), plus Ardia's profiles and a live view of a tab inside a terminal pane.

The CLI is plain Node (22+) and has been used on macOS; the live pane is macOS + Ghostty + tmux.

## Quickstart

1. In Ardia: **Settings › Advanced › Let the ardia command control Ardia** — on.
2. Point your agent at it:

```bash
node ardia-cdp.mjs list                                   # open tabs, with the profile each is in
node ardia-cdp.mjs open https://example.com --space work  # reuse the tab already showing it, or open it in Work, quietly
node ardia-cdp.mjs eval <target> "document.title"
node ardia-cdp.mjs shot <target> shot.png
```

`<target>` is a unique prefix of a target id from `list` or `open`. In Claude Code, run **`/ardia`** — see
[Use it with your coding agent](#use-it-with-your-coding-agent).

---

## Why this exists

Ardia is Arc's successor: the same sidebar, the same idea that tabs belong to a *profile* (Arc's spaces), each with
its own logins. Two things make it different to automate than Chrome or Arc:

1. **There is no launch flag to set.** Chrome tooling launches Chrome with `--remote-debugging-port`; `arc-cdp` had to
   keep a launch agent re-adding that flag after Arc's auto-updates. Ardia doesn't need any of that: turn on *Let the
   ardia command control Ardia* and Ardia itself serves a CDP endpoint, gated by a token, for as long as it runs.
   The port and token live in `Chromium/ArdiaControl.json` inside Ardia's data folder, and `ardia-cdp` reads them
   from there. Nothing to install, nothing to heal.

2. **CDP can't tell you which profile a page is in.** Every profile's tabs appear as one flat list of targets, so
   "open this page in Work" would either land in the wrong profile (another account, another set of logins) or open
   a second copy of a page you already have. `ardia-cdp` asks Ardia for its own window/tab list over the control
   socket, maps targets to profiles, and switches windows when it needs to.

3. **An agent working shouldn't move your page.** The usual way to open a tab for automation — activate it, or switch
   the window to its profile — takes the user off whatever they were reading. `ardia-cdp open` is **quiet by
   default**: the tab is created with Ardia's `background` flag, never activated, and an already-open page is used
   where it is. When the page belongs to a profile that isn't in front, the window goes there, opens the tab and
   switches straight back (a brief flip, then exactly where you were). `--foreground` asks for the visible
   behaviour when you actually want to look at the page.

## How it works

- **Engine** — `scripts/ardia-cdp.mjs`, raw CDP over WebSocket. No Puppeteer, no Playwright. Node's own `WebSocket`
  and `fetch`, Node 22+.
- **Profiles** — `scripts/ardia-spaces.mjs` maps what you ask for (`per`, `work`, or an exact profile name) to the
  Ardia profile and the window that shows it, and decides whether a page is already open there.
- **Discovery** — reads `Chromium/ArdiaControl.json` for the token path. If `ARDIA_REMOTE_DEBUGGING_PORT` was set for
  GUI apps (a LaunchAgent, or a scratch data dir), it tries that plain port first. Chromium's `DevToolsActivePort`
  file is only a hint: it can be stale.
- **Daemons** — the first command against a tab starts a tiny daemon that keeps the CDP session open, so repeated
  commands are instant. It exits after 20 minutes idle, when the tab closes, or with `ardia-cdp stop`.
- **The pane** — `scripts/ardia-pane.mjs` draws the tab with the kitty graphics protocol, from frames either streamed
  by a ScreenCaptureKit helper (`scripts/ardia-frames.swift`, GPU-scaled, shared memory) or taken as CDP screenshots
  when the tab is in the background.

What Ardia's policy refuses on the token path: cookies, emulation (viewport, device, user agent, geolocation),
`DOM.setFileInputFiles` (uploads), download behaviour, tracing, screencast and HTML5 drag interception. Everything
else in the command list works. `ardia-cdp` doesn't work around this — a task that needs one of those methods on your
real logins is a task to do by hand.

## Install

```bash
git clone https://github.com/immathanr/ardia-cdp.git
cd ardia-cdp && ./install.sh
```

`install.sh` copies the skill into `~/.claude/skills/ardia` (only if Claude Code is present, and it never overwrites
an existing skill unless you pass `--force`), and builds the pane's ScreenCaptureKit helper with `swiftc` if Swift is
available. Nothing else is installed, no launch agents, no background processes.

Without `install.sh`, the scripts run straight from the clone.

## Use it with your coding agent

- **Claude Code** — after `install.sh`, run **`/ardia`**: "open the PR and screenshot CI", "check what the dashboard
  says in my Work profile", "find the tab with the issue and translate the summary". `skill/SKILL.md` is the skill.
- **Codex, or any other agent/tool** — point it at the clone. The client is a working, dependency-free example:

  ```bash
  node scripts/ardia-cdp.mjs list                       # tabs by profile (id · title · url)
  node scripts/ardia-cdp.mjs open  <url> --space per|work [--foreground]
  node scripts/ardia-cdp.mjs snap  <target>             # accessibility tree (compact page structure)
  node scripts/ardia-cdp.mjs eval  <target> "document.title"
  node scripts/ardia-cdp.mjs click <target> "button.submit"
  node scripts/ardia-cdp.mjs type  <target> "hello"
  node scripts/ardia-cdp.mjs shot  <target> shot.png
  node scripts/ardia-cdp.mjs nav   <target> https://example.com
  node scripts/ardia-cdp.mjs net   <target>             # resource timing
  node scripts/ardia-cdp.mjs html  <target> [selector]
  node scripts/ardia-cdp.mjs loadall <target> <selector> [ms]   # click "load more" until it's gone
  node scripts/ardia-cdp.mjs evalraw <target> <method> [json]   # any CDP method
  node scripts/ardia-cdp.mjs wait  <target> --until "<js>" [--hand] [--timeout 300]
  node scripts/ardia-cdp.mjs stop [target]
  ```

  Run `node scripts/ardia-cdp.mjs` for the full help.

### A tab, live, in a terminal pane

Shows **one Ardia tab** — not the whole window — inside a tmux pane, and keeps showing it while the tab is in the
background behind other tabs. Clicks, scrolls and keys in the pane go to the page.

```bash
node scripts/ardia-pane.mjs <url> --space work --split   # open (or reuse) the page and show it in a new pane
node scripts/ardia-pane.mjs --target <prefix>            # a tab that's already open
```

Requires **Ghostty** (kitty graphics through tmux `allow-passthrough on`) and **tmux** for `--split`; the live path
needs **Screen Recording** permission for the terminal. Keys: `^L` go to URL, `^R` reload, `^O` back, `^Q` quit —
everything else goes to the page.

A background tab only draws when it's screenshotted, so its video plays at the screenshot rate (about five a second
while the picture changes, back to back right after input). Set `ARDIA_PANE_LIVE=0` to always use screenshots.

### Handing a tab to the user

When a page needs the user — a login, a 2FA code, a payment — an agent shouldn't stop and wait for a report back.
`wait` blocks in the background until the page says the user is done, and `--hand` puts the tab in front of them:

```bash
node scripts/ardia-cdp.mjs wait <target> --hand \
  --until "!!document.querySelector('#inbox')" --timeout 300
# waiting up to 300s for: !!document.querySelector('#inbox')
# handed over: the tab is in front for the user
# ready after 42.3s: true  https://mail.example.com/inbox
```

`--until` is a JS expression, evaluated in the page every `--interval` (500 ms); it ends when the result is truthy.
Exit 0 means ready, 1 means the timeout passed (and it prints the last value it saw).

### MCP server (any MCP client)

`scripts/mcp-server.mjs` speaks MCP over stdio, so Cursor, Codex, Zed and anything else that supports MCP can drive
Ardia with no extension and nothing installed:

```bash
node scripts/mcp-server.mjs        # newline-delimited JSON-RPC on stdio
```

Tools: `open_page` (quiet; takes `profile`, `foreground`), `list_tabs`, `read_page` (accessibility tree),
`evaluate`, `navigate`, `click`, `type_text`, `screenshot` (returns the image), `wait_for` (`until`, `timeout`,
`hand`). Each one is a call to the matching `ardia-cdp` command, so behaviour and Ardia's policy are identical.

In Claude Code, register it with:

```bash
claude mcp add ardia -- node ~/.claude/skills/ardia/scripts/mcp-server.mjs
```

### Goal-driven browsing (optional)

`scripts/jev-browse.py "<goal>" --start <url>` lets [Jev](https://typesafe.ai) decide each step from the
accessibility tree and acts through `agent-browser`; it needs the `jev` Claude Code skill. `--ardia` acts on your
live Ardia, with your logins — use it only when the task needs them, and watch it. It is bounded (`--max-steps`,
default 20).

## Configuration

| Env var | Default | Notes |
| --- | --- | --- |
| `ARDIA_CDP_HOST` | `127.0.0.1` | Host the client connects to. |
| `ARDIA_CDP_PORT` | discovered | Pin a plain debugging port (scratch instances). Unset: the token path. |
| `ARDIA_CDP_PORT_FILE` | — | Path to a `DevToolsActivePort` file to read ports from. |
| `ARDIA_DATA_DIR` | installed app's | Ardia data folder, for a scratch instance. |
| `ARDIA_PANE_LIVE` | `1` | `0` makes the pane use screenshots only. |
| `ARDIA_PANE_LOG` | — | Write the pane's frame timeline to this file. |

## Tests

```bash
node scripts/test_ardia_spaces.mjs          # profiles, quiet open, handoff polling
node --test scripts/test_mcp_server.mjs     # the MCP protocol and tool mapping
node scripts/test_pane_render.mjs
python3 scripts/test_jev_browse.py
```

End to end against a scratch Ardia (never your real profile):

```bash
S=~/ardia-scratch/t1   # short path: the control socket's path must fit in 103 bytes
open -g -n --env ARDIA_BACKGROUND=1 --env ARDIA_DATA_DIR=$S --env ARDIA_REMOTE_DEBUGGING_PORT=9333 /Applications/Ardia.app
ARDIA_DATA_DIR=$S ARDIA_CDP_PORT=9333 node scripts/ardia-cdp.mjs tabs
```

## Uninstall

```bash
./uninstall.sh
```

Removes `~/.claude/skills/ardia`. Your Ardia profile, history and settings are untouched.

## Security note

The control endpoint listens on **loopback only**, gated by a token that Ardia generates. But like Chrome's own
remote-debugging port, anything that can already run code as your user can drive your browser through it. Turn the
setting off when you're not using it if that trade-off isn't one you want. The token is read at runtime and never
stored by this repo.

## License

MIT © immathanr. `ardia-cdp.mjs` is ported from [arc-cdp](https://github.com/immathanr/arc-cdp), which is adapted
from [pasky/chrome-cdp-skill](https://github.com/pasky/chrome-cdp-skill) (MIT © pasky); all notices are in
[LICENSE](LICENSE).
