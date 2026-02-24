import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { ApiRequest, ApiResponse, Context } from '@iii-dev/sdk'
import { state } from '../hooks.js'

type CreateSessionBody = {
  model?: string
}

type Session = {
  id: string
  model: string
  createdAt: string
  lastUsed: string
  messageCount: number
}

export const handleCreateSession = async (
  req: ApiRequest<CreateSessionBody>,
  ctx: Context
): Promise<ApiResponse> => {
  const sessionId = randomUUID()
  const model = req.body?.model ?? 'sonnet'

  ctx.logger.info(`Creating session ${sessionId} with model ${model}`)

  try {
    const initResponse = await runClaude(
      'You are a helpful assistant. Session initialized. Respond with: "Ready."',
      sessionId,
      model
    )

    const session: Session = {
      id: sessionId,
      model,
      createdAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
      messageCount: 0,
    }

    await state.set('sessions', sessionId, session)

    ctx.logger.info(`Session ${sessionId} created successfully`)

    return {
      status_code: 201,
      headers: { 'content-type': 'application/json' },
      body: { sessionId, model, status: 'ready', initResponse },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.logger.error(`Failed to create session: ${message}`)

    return {
      status_code: 500,
      headers: { 'content-type': 'application/json' },
      body: { error: 'Failed to create session', detail: message },
    }
  }
}

function runClaude(prompt: string, sessionId: string, model: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--session-id', sessionId,
      '--model', model,
    ]

    execFile('claude', args, { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message))
        return
      }

      try {
        const parsed = JSON.parse(stdout)
        resolve(parsed.result ?? parsed.text ?? stdout)
      } catch {
        resolve(stdout.trim())
      }
    })
  })
}
