import './bridge.js'
import { useApi, useEvent, useCron } from './hooks.js'
import { handleHealth } from './handlers/health.js'
import { handleCreateSession } from './handlers/create-session.js'
import { handleSendMessage } from './handlers/send-message.js'
import { handleListSessions } from './handlers/list-sessions.js'
import { handleServeUI } from './handlers/serve-ui.js'
import { handleEngineStarted } from './handlers/setup.js'
import { handleCleanup } from './handlers/cleanup.js'

useApi({ path: '/', method: 'GET', description: 'Serve chat UI' }, handleServeUI)
useApi({ path: 'health', method: 'GET', description: 'Health check' }, handleHealth)
useApi({ path: 'sessions', method: 'GET', description: 'List sessions' }, handleListSessions)
useApi({ path: 'sessions', method: 'POST', description: 'Create session' }, handleCreateSession)
useApi({ path: 'sessions/chat', method: 'POST', description: 'Send message' }, handleSendMessage)

useEvent('engine::started', handleEngineStarted, 'Check Tailscale and publish')

useCron('*/30 * * * *', handleCleanup, 'Cleanup stale sessions every 30 minutes')

console.log('TailClaude worker registered — waiting for iii engine connection')
