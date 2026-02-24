import type { ApiRequest, ApiResponse } from '@iii-dev/sdk'
import { state } from '../hooks.js'

type Session = {
  id: string
  model: string
  createdAt: string
  lastUsed: string
  messageCount: number
}

export const handleListSessions = async (_req: ApiRequest): Promise<ApiResponse> => {
  const sessions = await state.list<Session>('sessions')

  return {
    status_code: 200,
    headers: { 'content-type': 'application/json' },
    body: {
      sessions: sessions.sort(
        (a, b) => new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime()
      ),
      count: sessions.length,
    },
  }
}
