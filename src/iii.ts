import { init } from 'iii-sdk'
import type { IIIConnectionState } from 'iii-sdk/telemetry'

const engineWsUrl = process.env.III_BRIDGE_URL ?? 'ws://localhost:49134'

export const iii = init(engineWsUrl, {
  otel: {
    enabled: true,
    serviceName: 'tailclaude',
    metricsEnabled: true,
    reconnectionConfig: {
      maxRetries: 10,
    },
  },
})

interface ExtendedSdk {
  getConnectionState(): IIIConnectionState
  onConnectionStateChange(cb: (s: IIIConnectionState) => void): () => void
}

const sdk = iii as unknown as Partial<ExtendedSdk>

export function getEngineConnectionState(): string {
  return typeof sdk.getConnectionState === 'function'
    ? sdk.getConnectionState()
    : 'unknown'
}

export function onEngineConnectionStateChange(
  cb: (s: string) => void,
): (() => void) | undefined {
  if (typeof sdk.onConnectionStateChange === 'function') {
    return sdk.onConnectionStateChange(cb as (s: IIIConnectionState) => void)
  }
  return undefined
}
