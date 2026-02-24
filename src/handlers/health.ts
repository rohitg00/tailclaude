import type { ApiRequest, ApiResponse } from '@iii-dev/sdk'

export const handleHealth = async (_req: ApiRequest): Promise<ApiResponse> => {
  return {
    status_code: 200,
    headers: { 'content-type': 'application/json' },
    body: {
      status: 'ok',
      service: 'tailclaude',
      timestamp: new Date().toISOString(),
    },
  }
}
