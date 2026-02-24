import { execFile } from 'node:child_process'
import type { ApiRequest, ApiResponse, Context } from '@iii-dev/sdk'
import { state } from '../hooks.js'

type ChatBody = {
  sessionId: string
  message: string
}

type Session = {
  id: string
  model: string
  createdAt: string
  lastUsed: string
  messageCount: number
}

export const handleSendMessage = async (
  req: ApiRequest<ChatBody>,
  ctx: Context
): Promise<ApiResponse> => {
  const { sessionId, message } = req.body ?? {}

  if (!sessionId || !message) {
    return {
      status_code: 400,
      headers: { 'content-type': 'application/json' },
      body: { error: 'Missing sessionId or message' },
    }
  }

  const session = await state.get<Session>('sessions', sessionId)
  if (!session) {
    return {
      status_code: 404,
      headers: { 'content-type': 'application/json' },
      body: { error: 'Session not found' },
    }
  }

  ctx.logger.info(`[${sessionId}] Sending message (${message.length} chars)`)
  const start = Date.now()

  try {
    const raw = await runClaude(message, sessionId, session.model)
    const duration = Date.now() - start
    const parsed = parseCloudeResponse(raw)

    await state.set('sessions', sessionId, {
      ...session,
      lastUsed: new Date().toISOString(),
      messageCount: session.messageCount + 1,
    })

    ctx.logger.info(`[${sessionId}] Response in ${duration}ms`)

    return {
      status_code: 200,
      headers: { 'content-type': 'application/json' },
      body: {
        response: parsed.text,
        toolsUsed: parsed.toolsUsed,
        cost: parsed.cost,
        duration,
        sessionId,
      },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.logger.error(`[${sessionId}] Error: ${message}`)

    return {
      status_code: 500,
      headers: { 'content-type': 'application/json' },
      body: { error: 'Claude invocation failed', detail: message },
    }
  }
}

function runClaude(prompt: string, sessionId: string, model: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--resume', sessionId,
      '--model', model,
    ]

    execFile('claude', args, { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message))
        return
      }
      resolve(stdout)
    })
  })
}

function parseCloudeResponse(raw: string): { text: string; toolsUsed: string[]; cost: string | null } {
  try {
    const parsed = JSON.parse(raw)
    return {
      text: parsed.result ?? parsed.text ?? raw,
      toolsUsed: parsed.tool_uses?.map((t: { name: string }) => t.name) ?? [],
      cost: parsed.cost_usd ?? parsed.cost ?? null,
    }
  } catch {
    return { text: raw.trim(), toolsUsed: [], cost: null }
  }
}
