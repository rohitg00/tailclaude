# TailClaude

Claude Code on your Tailscale tailnet, powered by the [iii engine](https://github.com/iii-hq/iii).

TailClaude publishes a full Claude Code web interface to every device on your tailnet — or the public internet via Tailscale Funnel. Real-time streaming, session history, QR code access, and full Claude Code controls from any browser.

## Why TailClaude?

The popular "doom coding" approach uses SSH + tmux + Termius to access Claude Code from a phone. It works, but requires:

- Installing Termius (or another SSH client)
- Configuring SSH keys and auth
- Learning tmux shortcuts (`Ctrl+b d` to detach, `Ctrl+b c` for new window)
- Typing code on a tiny terminal keyboard

TailClaude takes a different approach: **open a browser, start chatting**.

| | SSH + tmux + Termius | TailClaude |
|---|---|---|
| **Client** | Termius app (SSH terminal) | Any browser |
| **Setup on phone** | Install Tailscale + Termius, configure SSH | Scan QR code |
| **Session persistence** | tmux keeps terminal alive | iii engine state store |
| **Interface** | Full terminal emulator | Web chat UI with Markdown |
| **Session sharing** | `tmux attach` (terminal only) | Browse ALL sessions (terminal + web) |
| **Model switching** | Edit CLI flags manually | Dropdown menu (Opus, Sonnet, Haiku) |
| **Mobile experience** | Tiny terminal, keyboard shortcuts | Touch-optimized responsive UI |
| **Streaming** | Real-time in terminal | Real-time SSE in browser |
| **Install time** | ~15 minutes | `npm install && iii -c iii-config.yaml` |

Both approaches use Tailscale for secure access. TailClaude just removes everything else.

## Architecture

```text
+-----------------------------------------------------------------+
|  Browser (any device — phone, tablet, laptop)                   |
|  https://your-machine.tail-abc.ts.net                           |
+---------------------------------+-------------------------------+
                                  | HTTPS (auto-cert via Tailscale)
                                  v
+-----------------------------------------------------------------+
|  tailscale serve/funnel :443 -> http://127.0.0.1:3110           |
+---------------------------------+-------------------------------+
                                  |
                                  v
+-----------------------------------------------------------------+
|  Node.js Proxy (port 3110)                                      |
|                                                                 |
|  GET  /              -> Chat UI (streaming, controls, QR)       |
|  GET  /health        -> Proxy health + Tailscale URL + sessions |
|  POST /chat          -> SSE streaming (claude --stream-json)    |
|  POST /chat/stop     -> Kill active claude process              |
|  GET  /sessions      -> Discover ALL sessions (~/.claude/)      |
|  GET  /sessions/:id  -> Load full conversation history          |
|  GET  /qr            -> QR code SVG (real Tailscale URL)        |
|  GET  /settings      -> MCP servers list                        |
|  *                   -> Proxy to iii engine (port 3111)          |
+---------------------------------+-------------------------------+
                                  |
                                  v
+-----------------------------------------------------------------+
|  iii engine (port 3111)                                         |
|                                                                 |
|  Event: engine::started -> auto-publish to Tailscale + QR       |
|  Cron:  */30 * * * *    -> cleanup stale sessions               |
|  Signal: SIGINT/SIGTERM  -> unpublish Tailscale + clean exit    |
+---------------------------------+-------------------------------+
                                  |
                                  v
+-----------------------------------------------------------------+
|  claude -p --output-format stream-json --verbose                |
|  (Claude Code CLI — works with Pro/Max plans)                   |
+-----------------------------------------------------------------+
```

## How It Works

1. **iii engine** runs the state store, event bus, and cron scheduler
2. **TailClaude worker** connects via WebSocket and registers event handlers
3. **Node.js proxy** (port 3110) serves the UI and handles all endpoints directly
4. `POST /chat` spawns `claude -p --output-format stream-json --verbose` and streams tokens via SSE
5. `GET /sessions` discovers all sessions from `~/.claude/projects/` with conversation metadata
6. `GET /sessions/:id` loads full conversation history (user messages, assistant responses, tool use)
7. On engine start, auto-publishes to your tailnet via `tailscale serve` and prints a terminal QR code
8. On shutdown (Ctrl+C), unpublishes from Tailscale and exits cleanly

## Prerequisites

- [iii engine](https://github.com/iii-hq/iii) installed and on your PATH
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- [Tailscale](https://tailscale.com) installed (optional — works locally without it)
- Node.js 20+

## Setup

```bash
git clone https://github.com/rohitg00/tailclaude.git
cd tailclaude
npm install
```

## Running

### Option A: iii manages everything (recommended)

```bash
iii -c iii-config.yaml
```

This starts the iii engine and automatically runs `npx tsx src/index.ts`.

### Option B: Run separately

```bash
# Terminal 1 — start iii engine
iii -c iii-config.yaml

# Terminal 2 — start the worker
npm run dev
```

### Option C: Proxy only (no iii engine)

For quick testing without the full iii engine:

```bash
npx tsx -e 'import{startProxy}from"./src/proxy.ts";startProxy()'
```

### Verify

```bash
# Proxy health check (includes Tailscale URL and session count)
curl http://localhost:3110/health

# Open the chat UI
open http://localhost:3110

# List all sessions with metadata
curl http://localhost:3110/sessions

# Load a specific session's conversation
curl http://localhost:3110/sessions/<session-id>

# QR code SVG
curl http://localhost:3110/qr
```

## Chat UI Features

### Streaming & Chat
- **Real-time SSE streaming** — tokens appear as Claude generates them
- **Stop button** — abort mid-response (kills the claude process)
- **Inline markdown** rendering (code blocks, bold, italic, lists)
- **Cost tracking** per message and cumulative
- **Tool use badges** on assistant responses

### Session Management
- **Session discovery** — browse ALL Claude Code sessions (terminal + web)
- **Conversation history** — click any session to load full chat history
- **Session naming** — double-click (or long-press on mobile) to rename
- **Auto-restore** — reopening the browser resumes your last session
- **Relative timestamps** — "2h ago", "3d ago" on each session
- **Slug names** — sessions display their Claude Code slug for identification

### Claude Code Controls
- **Model selector** — Opus (default), Sonnet, Haiku
- **Permission modes** — default, plan, acceptEdits, bypassPermissions, dontAsk
- **Effort levels** — low, medium, high
- **Budget control** — set max spend per message
- **System prompt** — append instructions to every message
- **MCP servers** — view configured MCP servers in settings

### Access & Mobile
- **QR code** — scan from phone to instantly access TailClaude
- **Tailscale Funnel** — public HTTPS access (no Tailscale app needed on phone)
- **Mobile-first** — hamburger menu, touch-optimized, responsive layout
- **Dark theme** with purple accents
- **Connection status** with auto-reconnect polling
- **Auth support** — set `TAILCLAUDE_TOKEN` env var to require bearer token

## Project Structure

```text
tailclaude/
├── iii-config.yaml              # iii engine configuration (180s timeout)
├── package.json                 # dependencies (iii-sdk, qrcode)
├── tsconfig.json
└── src/
    ├── iii.ts                   # SDK init (iii-sdk init() with OTel config)
    ├── hooks.ts                 # useApi, useEvent, useCron helpers
    ├── state.ts                 # State wrapper (scope/key API via iii.call)
    ├── proxy.ts                 # HTTP proxy: SSE chat, sessions, history, QR, settings, health
    ├── index.ts                 # Register health route + event + cron + proxy
    ├── ui.html                  # Chat UI (single file, inline CSS/JS, ~900 lines)
    └── handlers/
        ├── health.ts            # GET /health via iii (Tailscale + session status)
        ├── setup.ts             # Tailscale auto-publish with terminal QR code
        ├── shutdown.ts          # Graceful shutdown (SIGINT/SIGTERM + unpublish)
        └── cleanup.ts           # Cron: remove stale sessions
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `III_BRIDGE_URL` | `ws://localhost:49134` | iii engine WebSocket URL |
| `NODE_ENV` | - | Set to `production` to enable UI caching |
| `TAILCLAUDE_TOKEN` | - | Bearer token for proxy auth (recommended for Funnel) |

### iii Modules

The `iii-config.yaml` enables these modules:

| Module | Purpose |
|--------|---------|
| State (KV/file) | Persist sessions to `./data/state_store.db` |
| REST API | HTTP server on port 3111 with CORS (180s timeout) |
| Queue (builtin) | Internal task queue |
| PubSub (local) | Event bus for `engine::started` |
| Cron (KV) | Scheduled session cleanup |
| Otel (memory) | Observability and structured logging |
| Shell Exec | Auto-run the TypeScript worker (watches `src/**/*.ts`) |

## Tailscale Integration

TailClaude supports two Tailscale modes:

### Tailscale Serve (tailnet only)

Accessible only from devices on your tailnet:

```bash
tailscale serve --bg --yes --https=443 http://127.0.0.1:3110
```

### Tailscale Funnel (public internet)

Accessible from any device — ideal for phone access without installing Tailscale:

```bash
tailscale funnel --bg --yes --https=443 http://127.0.0.1:3110
```

When using Funnel, set `TAILCLAUDE_TOKEN` to prevent unauthorized access.

### Auto-publish on Engine Start

When Tailscale is available, TailClaude automatically:

1. Detects your Tailscale IP and DNS name
2. Checks for existing serve listeners (reuses if already active)
3. Publishes via `tailscale serve` with HTTPS on port 443
4. Verifies the proxy registered via status check (retries up to 3 times)
5. Prints a QR code to the terminal for instant mobile access
6. On shutdown, runs `tailscale serve --https=443 off` to unpublish

If Tailscale is not installed, it runs in local-only mode at `http://127.0.0.1:3110`.

## API Reference

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/` | GET | No | Serve chat UI |
| `/health` | GET | Yes | Proxy health, Tailscale URL, session counts |
| `/chat` | POST | Yes | SSE streaming chat (spawn claude CLI) |
| `/chat/stop` | POST | Yes | Stop active claude process by request ID |
| `/sessions` | GET | Yes | List all discovered sessions with metadata |
| `/sessions/:id` | GET | Yes | Load full conversation history for a session |
| `/qr` | GET | Yes | QR code SVG of the Tailscale URL |
| `/settings` | GET | Yes | MCP servers and Claude Code config |

### POST /chat Body

```json
{
  "message": "Hello Claude",
  "model": "opus",
  "mode": "default",
  "effort": "high",
  "sessionId": "optional-uuid-to-resume",
  "maxBudget": 5.00,
  "systemPrompt": "You are a helpful assistant"
}
```

## Inspiration

TailClaude was inspired by the "doom coding" movement — developers using Tailscale + SSH + tmux + Termius to code from their phones. Articles by [Pete Sena](https://medium.com/@petesena) and [Emre Isik](https://medium.com/@emreisik95), plus the [doom-coding](https://github.com/rberg27/doom-coding) repo by Ryan Bergamini, showed how powerful mobile coding can be.

TailClaude takes this further by removing the terminal layer entirely — just a browser and a URL.

## License

MIT
