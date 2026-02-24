# TailClaude

Claude Code on your Tailscale tailnet, powered by the [iii engine](https://github.com/iii-hq/iii).

TailClaude publishes a multi-session Claude Code interface to every device on your tailnet — accessible from any browser with zero port forwarding, zero tunnels, and automatic HTTPS via Tailscale.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (any device on your tailnet)                           │
│  https://your-machine.tail-abc.ts.net                           │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTPS (auto-cert via Tailscale)
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│  tailscale serve :443 → http://127.0.0.1:3111                    │
└──────────────────────────┬───────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│  iii REST API (port 3111)                                        │
│                                                                  │
│  GET  /              → Chat UI (dark theme, markdown, sessions)  │
│  GET  /health        → Health check                              │
│  GET  /sessions      → List all sessions                         │
│  POST /sessions      → Create new Claude session                 │
│  POST /sessions/chat → Send message to Claude                    │
│                                                                  │
│  Event: engine::started → auto-publish to Tailscale              │
│  Cron:  */30 * * * *    → cleanup sessions older than 24h        │
└──────────────────────────┬───────────────────────────────────────┘
                           │ WebSocket (ws://localhost:49134)
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│  iii engine                                                      │
│                                                                  │
│  ┌────────────┐ ┌──────────┐ ┌────────┐ ┌──────┐ ┌────────────┐  │
│  │   State    │ │  Queue   │ │ PubSub │ │ Cron │ │    Otel    │  │
│  │  (KV/file) │ │(builtin) │ │(local) │ │ (KV) │ │  (memory)  │  │
│  └────────────┘ └──────────┘ └────────┘ └──────┘ └────────────┘  │
└──────────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│  claude -p --resume <session-id> --output-format json            │
│  (Claude Code CLI — works with Pro/Max plans)                    │
└──────────────────────────────────────────────────────────────────┘
```

## How It Works

1. **iii engine** runs the REST API, state store, event bus, and cron scheduler
2. **TailClaude worker** connects via WebSocket and registers API handlers
3. `POST /sessions` spawns a new Claude session via `claude -p --session-id <uuid>`
4. `POST /sessions/chat` sends messages via `claude -p --resume <id>` for multi-turn context
5. On engine start, TailClaude auto-publishes to your tailnet via `tailscale serve`
6. A cron job cleans up stale sessions every 30 minutes

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

The `iii-config.yaml` includes a shell exec module that auto-starts the worker:

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

### Verify

```bash
# Health check
curl http://localhost:3111/health

# Create a session
curl -X POST http://localhost:3111/sessions

# Send a message
curl -X POST http://localhost:3111/sessions/chat \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"<id-from-above>","message":"What is 2+2?"}'

# Open the chat UI
open http://localhost:3111
```

## Project Structure

```
tailclaude/
├── iii-config.yaml              # iii engine configuration
├── package.json                 # dependencies (@iii-dev/sdk)
├── tsconfig.json
└── src/
    ├── bridge.ts                # WebSocket connection to iii engine
    ├── hooks.ts                 # useApi, useEvent, useCron, state helpers
    ├── index.ts                 # Register all routes + handlers
    ├── ui.html                  # Chat UI (single file, inline CSS/JS)
    └── handlers/
        ├── health.ts            # GET /health
        ├── create-session.ts    # POST /sessions
        ├── send-message.ts      # POST /sessions/chat
        ├── list-sessions.ts     # GET /sessions
        ├── serve-ui.ts          # GET / (serves ui.html)
        ├── setup.ts             # Tailscale auto-publish on engine start
        └── cleanup.ts           # Cron: remove stale sessions
```

## Chat UI Features

- Dark theme with purple accents
- Session management (create, switch, list)
- Inline markdown rendering (code blocks, bold, italic, lists)
- Loading animation while waiting for Claude
- Cost tracking per message and cumulative
- Tool use badges on assistant responses
- Responsive — works on mobile

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `III_BRIDGE_URL` | `ws://localhost:49134` | iii engine WebSocket URL |

### iii Modules

The `iii-config.yaml` enables these modules:

| Module | Purpose |
|--------|---------|
| State (KV/file) | Persist sessions to `./data/state_store.db` |
| REST API | HTTP server on port 3111 with CORS |
| Queue (builtin) | Internal task queue |
| PubSub (local) | Event bus for `engine::started` |
| Cron (KV) | Scheduled session cleanup |
| Otel (memory) | Observability and structured logging |
| Shell Exec | Auto-run the TypeScript worker |

## Tailscale Integration

When Tailscale is available, TailClaude automatically:

1. Detects your Tailscale IP on engine start
2. Runs `tailscale serve --bg --yes --https=443 http://127.0.0.1:3111`
3. Logs the published URL

If Tailscale is not installed, it runs in local-only mode at `http://127.0.0.1:3111`.

## License

MIT
