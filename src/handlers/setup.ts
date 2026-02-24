import { execFile } from 'node:child_process'
import type { Context } from '@iii-dev/sdk'
import { state } from '../hooks.js'

export const handleEngineStarted = async (_data: unknown, ctx: Context): Promise<void> => {
  ctx.logger.info('Engine started — checking Tailscale status')

  try {
    const ip = await runCommand('tailscale', ['ip', '-4'])
    ctx.logger.info(`Tailscale IP: ${ip.trim()}`)

    await state.set('config', 'tailscale', {
      ip: ip.trim(),
      connectedAt: new Date().toISOString(),
    })

    await publishToTailscale(ctx)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.logger.warn(`Tailscale not available: ${msg}`)
    ctx.logger.info('Running in local-only mode at http://127.0.0.1:3111')
  }
}

async function publishToTailscale(ctx: Context): Promise<void> {
  try {
    await runCommand('tailscale', ['serve', '--bg', '--yes', '--https=443', 'http://127.0.0.1:3111'])
    const status = await runCommand('tailscale', ['status', '--json'])
    const parsed = JSON.parse(status)
    const hostname = parsed.Self?.HostName ?? 'unknown'
    const url = `https://${hostname}.tail${parsed.Self?.DNSName?.split('.').slice(-3, -1).join('.') ?? 'net'}`

    await state.set('config', 'published_url', { url, publishedAt: new Date().toISOString() })
    ctx.logger.info(`Published to Tailscale: ${url}`)
    ctx.logger.info(`Access TailClaude from any device on your tailnet`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.logger.warn(`Failed to publish via tailscale serve: ${msg}`)
  }
}

function runCommand(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15_000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message))
        return
      }
      resolve(stdout)
    })
  })
}
