import { type ApiRequest, type ApiResponse, type Context, getContext } from '@iii-dev/sdk'
import { bridge } from './bridge.js'

type ApiConfig = {
  path: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  description?: string
}

export const useApi = <TBody = unknown>(
  config: ApiConfig,
  handler: (req: ApiRequest<TBody>, ctx: Context) => Promise<ApiResponse>
) => {
  const function_path = `api.${config.method.toLowerCase()}.${config.path}`

  bridge.registerFunction({ function_path, description: config.description }, (req) =>
    handler(req as ApiRequest<TBody>, getContext())
  )

  bridge.registerTrigger({
    trigger_type: 'api',
    function_path,
    config: { api_path: config.path, http_method: config.method, description: config.description },
  })
}

export const useEvent = <TData = unknown>(
  topic: string,
  handler: (data: TData, ctx: Context) => Promise<void>,
  description?: string
) => {
  const function_path = `event.${topic}.handler`

  bridge.registerFunction({ function_path, description }, (data) =>
    handler(data as TData, getContext())
  )

  bridge.registerTrigger({
    trigger_type: 'event',
    function_path,
    config: { topic },
  })
}

export const emit = async <TData = unknown>(topic: string, data: TData): Promise<void> => {
  await bridge.invokeFunction('emit', { topic, data })
}

export const useCron = (
  expression: string,
  handler: (ctx: Context) => Promise<void>,
  description?: string
) => {
  const sanitized = expression.replace(/\s+/g, '_').replace(/\*/g, 'x')
  const function_path = `cron.${sanitized}.${Date.now()}`

  bridge.registerFunction({ function_path, description }, () => handler(getContext()))

  bridge.registerTrigger({
    trigger_type: 'cron',
    function_path,
    config: { expression },
  })
}

export const state = {
  async set<T>(group: string, id: string, data: T): Promise<T> {
    return bridge.invokeFunction('state.set', { group_id: group, item_id: id, data }) as Promise<T>
  },
  async get<T>(group: string, id: string): Promise<T | null> {
    return bridge.invokeFunction('state.get', { group_id: group, item_id: id }) as Promise<T | null>
  },
  async delete(group: string, id: string): Promise<void> {
    await bridge.invokeFunction('state.delete', { group_id: group, item_id: id })
  },
  async list<T>(group: string): Promise<T[]> {
    const result = await bridge.invokeFunction('state.list', { group_id: group })
    return (result as { items: T[] })?.items ?? []
  },
}

export const streams = {
  async set<T>(stream: string, group: string, id: string, data: T): Promise<T> {
    return bridge.invokeFunction('streams.set', {
      stream_name: stream, group_id: group, item_id: id, data,
    }) as Promise<T>
  },
  async get<T>(stream: string, group: string, id: string): Promise<T | null> {
    return bridge.invokeFunction('streams.get', {
      stream_name: stream, group_id: group, item_id: id,
    }) as Promise<T | null>
  },
  async getGroup<T>(stream: string, group: string): Promise<T[]> {
    const result = await bridge.invokeFunction('streams.getGroup', {
      stream_name: stream, group_id: group,
    })
    return (result as { items: T[] })?.items ?? []
  },
}
