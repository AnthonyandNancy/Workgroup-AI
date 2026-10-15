// Route registry. Each module in this directory owns one resource and exports a factory
// that receives the shared request authenticator; `buildRoutePlugins` is the single list the
// server registers, so a new module is added in one place and cannot become reachable
// without appearing here.
//
// The authenticator is injected rather than rebuilt per module: two copies of "who is
// calling" is how resource modules drift into different rules.

import { identityRoutes } from './identity.js'
import { makeRoomRoutes } from './rooms.js'
import { makeMessageRoutes } from './messages.js'
import { makeBotRoutes } from './bots.js'
import { makeTaskRoutes } from './tasks.js'
import { makeGrantRoutes } from './grants.js'
import { makeMemoryRoutes } from './memory.js'
import { makeArtifactRoutes } from './artifacts.js'
import { makeAuditRoutes } from './audit.js'

/**
 * @param {{ requireAuth: Function }} deps
 * @returns {Function[]} Fastify plugins, in registration order.
 */
export function buildRoutePlugins({ requireAuth }) {
  return [
    identityRoutes,
    makeRoomRoutes({ requireAuth }),
    makeMessageRoutes({ requireAuth }),
    makeBotRoutes({ requireAuth }),
    makeTaskRoutes({ requireAuth }),
    makeGrantRoutes({ requireAuth }),
    makeMemoryRoutes({ requireAuth }),
    makeArtifactRoutes({ requireAuth }),
    makeAuditRoutes({ requireAuth }),
  ]
}
