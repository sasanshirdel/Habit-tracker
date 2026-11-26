// Platform authentication surface (backlog P2-03, ADR-0019): route markers, the principal and
// owner-scoping helpers. The guard itself lives in the identity module.
export {
  AUTH_POLICY_METADATA,
  CurrentUser,
  Public,
  SESSION_RESOLVER,
  attachPrincipal,
  foundOr404,
  ownedBy,
  principalOf,
  routeAuthPolicy,
  type PublicOptions,
  type RequestPrincipal,
  type RouteAuthPolicy,
  type SessionResolver,
} from './auth.metadata.js';
export {
  SAFE_METHODS,
  checkRequestOrigin,
  isUnsafeMethod,
  type OriginRejection,
} from '../security/request-origin.js';
