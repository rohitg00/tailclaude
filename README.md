<p align="center">
  <img src="assets/banner-v2.jpg" alt="TailClaude — Claude Code from any browser" width="100%" />
</p>

# TailClaude

<p align="center">
  <img src="assets/demo.gif" alt="TailClaude Demo" width="100%" />
</p>

**Claude Code from any browser. No SSH. No terminal. Just a URL.**

TailClaude publishes a full Claude Code web interface to every device on your Tailscale tailnet — or the public internet via [Tailscale Funnel](https://tailscale.com/kb/1223/funnel). Powered by the [iii engine](https://github.com/iii-hq/iii).

Scan a QR code from your phone, open the link, and start coding with Claude — **streaming responses, full session history, model switching, real-time cost & usage dashboards, system metrics, request traces, live activity feed, and every Claude Code control in a touch-optimized UI styled with Anthropic's brand guidelines**.

## Why TailClaude?

Every "doom coding" setup — SSH, mosh, tmux, Termius, Moshi — still puts you in a terminal. You're still typing on a tiny keyboard, memorizing shortcuts, and managing connections.

**TailClaude removes the terminal entirely.**

| | Terminal (SSH/mosh + tmux) | **TailClaude** |
|---|---|---|
| **Client** | Terminal app + SSH/mosh + tmux | **Any browser** |
| **Phone setup** | Install app, configure keys/auth | **Scan QR code** |
| **Network switch** | mosh helps, SSH drops | **Browser reconnects automatically** |
| **Interface** | Terminal emulator | **Web chat UI with Markdown rendering** |
| **Streaming** | Raw terminal output | **Real-time SSE, token-by-token** |
| **Session history** | `tmux attach` (terminal only) | **Browse ALL sessions (terminal + web)** |
| **Model switching** | Edit CLI flags, restart | **Dropdown: Opus, Sonnet, Haiku** |
| **Permission modes** | CLI flags | **One-click: default, plan, acceptEdits, bypassPermissions** |
| **Cost tracking** | None | **Live tokens + per-message cost ($0.01 · 4.5K in / 892 out)** |
| **Stop mid-response** | Ctrl+C in terminal | **Stop button with instant feedback** |
| **Mobile UX** | Tiny terminal, keyboard shortcuts | **Touch-optimized, responsive, dark theme** |
| **Setup time** | ~15 minutes | **`npm install && iii -c iii-config.yaml`** |

Tailscale handles the secure connection. TailClaude handles everything else.

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
|  GET  /                  -> Chat UI (Anthropic brand, tabs)     |
|  GET  /health            -> Engine state + worker metrics        |
|  POST /chat              -> OTel-traced SSE streaming chat       |
|  POST /chat/stop         -> Kill active process + lifecycle      |
|  GET  /chat/active       -> Active streaming request IDs         |
|  GET  /chat/replay/:id   -> Replay buffered chat events          |
|  GET  /sessions          -> State-indexed sessions (sub-ms)      |
|  GET  /sessions/:id      -> Full conversation history            |
|  GET  /activity          -> SSE live activity feed               |
|  GET  /usage             -> 7-day cost & token usage stats       |
|  GET  /metrics           -> System metrics timeline + alerts     |
|  GET  /traces            -> Request traces (cost/tokens/model)   |
|  GET  /qr                -> QR code SVG                          |
|  GET  /settings          -> MCP servers list                     |
|  *                       -> Proxy to iii engine (port 3111)      |
+---------------------------------+-------------------------------+
                                  |
                                  v
+-----------------------------------------------------------------+
|  iii engine (port 3111)                                         |
|                                                                 |
|  State    -> session_index, usage_daily, traces, metrics,       |
|             alert_cooldowns, alerts, backfill_state, config      |
|  Streams  -> chat event replay buffer (LRU, 100 groups max)    |
|  PubSub   -> chat::started/completed/stopped, session::indexed, |
|             cleanup::completed, alert::*                         |
|  Cron     -> */1 metrics snapshot, */5 session re-index +       |
|             backfill, */30 cleanup, */6h data retention          |
|  OTel     -> distributed tracing on every chat request          |
|  Logger   -> structured logging with trace correlation          |
|  Event: engine::started  -> auto-publish to Tailscale + QR      |
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

1. **iii engine** runs the state store, event bus, stream layer, and cron scheduler
2. **TailClaude worker** connects via WebSocket and registers functions, triggers, streams, and PubSub subscriptions
3. **Node.js proxy** (port 3110) serves the UI and handles all endpoints with OTel tracing
4. `POST /chat` spawns `claude -p --output-format stream-json --verbose`, wraps the request in an OTel span (model, cost, tokens, duration), writes events to the iii chat stream for replay, and emits lifecycle events via PubSub
5. **PubSub subscribers** react to chat events: increment daily usage stats, write request traces, push to the SSE activity feed, and update the session index
6. **Cron jobs** snapshot system metrics every minute (with overload alert detection), re-index sessions every 5 minutes (including backfilling real costs from Claude Code JSONL files), cleanup stale data every 30 minutes, and purge old usage/traces every 6 hours
7. **Session cost backfill** parses Claude Code's native JSONL session files (`~/.claude/projects/`) to extract real token counts, model names, and cache usage — then calculates accurate costs using Claude API pricing
8. On engine start, auto-publishes to your tailnet via `tailscale serve` and prints a terminal QR code
9. On shutdown (Ctrl+C), unpublishes from Tailscale, unsubscribes engine listeners, and exits cleanly

## Prerequisites

- [iii engine](https://github.com/iii-hq/iii) installed and on your PATH
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- [Tailscale](https://tailscale.com) installed (optional — works locally without it)
- Node.js 20+

## Quick Start

**3 commands. Under 60 seconds.**

```bash
git clone https://github.com/rohitg00/tailclaude.git
cd tailclaude
npm install
iii -c iii-config.yaml
```

That's it. Open the URL printed in your terminal (or scan the QR code from your phone).

If Tailscale is running, TailClaude auto-publishes to your tailnet with HTTPS. No config needed.

### Other Ways to Run

**Run worker separately** (if iii engine is already running):

```bash
npm run dev
```

**Proxy only** (quick testing, no iii engine):

```bash
npx tsx -e 'import{startProxy}from"./src/proxy.ts";startProxy()'
```

### Verify

```bash
curl http://localhost:3110/health    # Proxy health + Tailscale URL + sessions
open http://localhost:3110           # Open the chat UI
curl http://localhost:3110/sessions  # List all sessions with metadata
curl http://localhost:3110/usage     # 7-day cost & usage stats
curl http://localhost:3110/metrics   # System metrics timeline + alerts
curl http://localhost:3110/traces    # Request traces with cost/tokens/model
curl http://localhost:3110/qr        # QR code SVG
```

## Chat UI Features

### Streaming & Chat
- **Real-time SSE streaming** — tokens appear as Claude generates them
- **Stop button** — abort mid-response with visual feedback (kills the claude process)
- **Inline Markdown** rendering (code blocks, bold, italic, lists)
- **Live token counter** — input/output tokens update as Claude streams (`4,521 in / 892 out`)
- **Cost tracking** — per-message cost displayed on completion (`$0.0123 · 4,521 in / 892 out`)
- **Tool use badges** — appear in real-time as Claude invokes tools, even before text arrives

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

### Activity Feed (Live SSE)
- **Real-time events** — chat started, completed, stopped, session indexed, cleanup, alerts
- **SSE stream** at `GET /activity` — browser EventSource with auto-reconnect
- **Ring buffer** — last 200 events stored in memory, last 50 replayed on connect
- **PubSub bridge** — every iii PubSub event is bridged to the browser via SSE

### Cost & Usage Dashboard
- **Today's stats** — cost, requests, input tokens, output tokens
- **7-day cost trend** — CSS bar chart showing daily cost
- **Total accumulated cost** across all tracked days
- **Real pricing** — uses Claude API rates (Opus $15/$75, Sonnet $3/$15, Haiku $0.80/$4 per M tokens, plus cache read/write rates)
- **Session backfill** — parses Claude Code JSONL files for historical costs with real model and token data

### System Metrics
- **Gradient area charts** — memory RSS, CPU, event loop lag, worker uptime
- **Per-metric colors** — orange (memory), blue (CPU), gray (lag), green (uptime) using Anthropic brand palette
- **Min/Max/Avg stats** on each metric card
- **Time axis labels** and grid lines
- **30-second auto-refresh**
- **Overload alerts** — threshold-based detection for CPU >80%, memory >500MB, lag >100ms with 5-minute cooldown

### Request Traces
- **Full trace table** — timestamp, model, duration, cost, tokens in/out, exit status
- **Color-coded status** — green (success), orange (error), gray (stopped)
- **Summary stats** — average duration, average cost, today's request count
- **30-day retention** with automatic cleanup

### Access & Mobile
- **QR code** — scan from phone to instantly access TailClaude
- **Tailscale Funnel** — public HTTPS access (no Tailscale app needed on phone)
- **Mobile-first** — hamburger menu, touch-optimized, responsive layout
- **Anthropic brand design** — Dark #141413, Light #faf9f5, Orange #d97757 accent, Poppins/Lora typography
- **Blurred Tailscale URL** — hover to reveal, keeps the URL private by default
- **Connection status** with auto-reconnect polling
- **Auth support** — set `TAILCLAUDE_TOKEN` env var to require bearer token (`?token=` query param for EventSource)

## Project Structure

```text
tailclaude/
├── iii-config.yaml              # iii engine configuration (180s timeout)
├── package.json                 # dependencies (iii-sdk ^0.3.0, qrcode)
├── tsconfig.json
└── src/
    ├── iii.ts                   # SDK init + connection state helpers
    ├── hooks.ts                 # useApi, useEvent, useCron, emit (PubSub publish)
    ├── state.ts                 # State wrapper (scope/key API via iii.trigger)
    ├── streams.ts               # Chat event stream (LRU replay buffer)
    ├── sessions.ts              # State-backed session index with filesystem scan
    ├── metrics.ts               # WorkerMetricsCollector with 5s cached snapshots
    ├── activity.ts              # SSE activity feed — ring buffer + PubSub→SSE bridge
    ├── usage.ts                 # Daily usage aggregation (cost, tokens, requests)
    ├── traces.ts                # Request traces — write/query/cleanup (30-day retention)
    ├── metrics-timeline.ts      # 1-minute metric snapshots + overload alert detection
    ├── session-costs.ts         # JSONL parser — backfill real costs from Claude Code sessions
    ├── proxy.ts                 # HTTP proxy with OTel tracing (14 endpoints)
    ├── index.ts                 # Register all functions, streams, PubSub, crons, proxy
    ├── ui.html                  # Full UI — 4 tabs, activity sidebar, Anthropic brand (~1500 lines)
    └── handlers/
        ├── health.ts            # GET /health (engine state + worker metrics)
        ├── setup.ts             # Tailscale auto-publish with terminal QR code
        ├── shutdown.ts          # Graceful shutdown (SIGINT/SIGTERM + unpublish)
        └── cleanup.ts           # Multi-scope cleanup (sessions, chats, index, streams)
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
| State (KV/file) | 8 scopes for sessions, usage, traces, metrics, alerts, backfill (`./data/state_store.db`) |
| Streams | Chat event replay buffer with LRU eviction (100 groups, 30min TTL) |
| REST API | HTTP server on port 3111 with CORS (180s timeout) |
| Queue (builtin) | Internal task queue |
| PubSub (local) | Event bus with 7+ topics, bridged to browser SSE for real-time updates |
| Cron (KV) | */1 metrics, */5 sessions + backfill, */30 cleanup, */6h data retention |
| OTel (memory) | Distributed tracing — traces stored in State for the dashboard |
| Shell Exec | Auto-run the TypeScript worker (watches `src/**/*.ts`, auto-restarts on change) |

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
| `/` | GET | No | Serve chat UI (Anthropic brand, 4 tabs) |
| `/health` | GET | Yes | Engine state, worker metrics, session count |
| `/chat` | POST | Yes | OTel-traced SSE streaming chat (spawn claude CLI) |
| `/chat/stop` | POST | Yes | Stop active process + emit lifecycle event |
| `/chat/active` | GET | Yes | List active streaming request IDs |
| `/chat/replay/:id` | GET | Yes | Replay buffered chat events for reconnect |
| `/sessions` | GET | Yes | State-indexed sessions with metadata (sub-ms) |
| `/sessions/:id` | GET | Yes | Load full conversation history for a session |
| `/activity` | GET | Yes | SSE live activity feed (`?token=` for EventSource) |
| `/usage` | GET | Yes | Last 7 days of cost, tokens, and request stats |
| `/metrics` | GET | Yes | System metrics timeline (60 snapshots) + active alerts |
| `/traces` | GET | Yes | Last 100 request traces with cost/tokens/model |
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

## iii Integration

TailClaude deeply integrates every iii engine primitive, making it a real-world reference app for the [iii SDK](https://github.com/iii-hq/iii).

| Primitive | How TailClaude Uses It |
|---|---|
| **State** | 8 scopes: `session_index`, `usage_daily`, `traces`, `metrics_timeline`, `alerts`, `alert_cooldowns`, `active_chats`, `backfill_state` |
| **Streams** | Chat event replay buffer — reconnect and resume mid-chat from any device |
| **PubSub** | `chat::started/completed/stopped`, `session::indexed`, `cleanup::completed`, `alert::*` — bridged to browser via SSE |
| **Cron** | */1 metrics snapshot, */5 session re-index + cost backfill, */30 cleanup, */6h data retention |
| **OTel Tracing** | Every `POST /chat` wrapped in a span; traces stored in queryable State for the dashboard |
| **Logger** | Structured logging with trace correlation across all modules |
| **Connection Monitor** | Engine WebSocket state exposed in `/health` endpoint |
| **Worker Metrics** | CPU, memory, event loop lag cached with 5s TTL; 1-minute timeseries in State for sparkline charts |

## Background

The "doom coding" movement proved that coding from a phone is real — [Pete Sena](https://medium.com/@petesena), [Emre Isik](https://medium.com/@emreisik95), and [Ryan Bergamini's doom-coding repo](https://github.com/rberg27/doom-coding) showed what's possible with SSH + tmux + Termius. Others improved the connection layer with mosh and Moshi for persistent sessions through network switches.

But every approach still required a terminal client, key management, and tiny-keyboard typing.

TailClaude asks: **what if you didn't need a terminal at all?** One URL, any browser, full Claude Code — with streaming, session history, model switching, and cost tracking that no terminal setup can match.

## License

MIT
