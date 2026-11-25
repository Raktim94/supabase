import * as Sentry from '@sentry/react'
import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'

import { IS_PLATFORM } from '../constants'
import { apiAuthenticate, authenticateRequest } from './apiAuthenticate'
import { InvalidJsonError, methodNotAllowed } from './apiHelpers'
import { isStudioError } from '@/lib/errors/studio-errors'
import type { ResponseFailure } from '@/types'

export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

export interface ApiHandlerContext {
  request: Request
  params: Record<string, string | undefined>
  claims?: JwtPayload
}

export type ApiHandler = (ctx: ApiHandlerContext) => Response | Promise<Response>

export type ApiMethodHandlers = Partial<Record<ApiMethod, ApiHandler>>

type ServerRouteHandler = (ctx: {
  request: Request
  params?: Record<string, string | undefined>
}) => Promise<Response>

export type WrappedApiHandlers<THandlers extends ApiMethodHandlers> = {
  [K in keyof THandlers & ApiMethod]: ServerRouteHandler
} & {
  ANY: ServerRouteHandler
}

export function isResponseOk<T>(response: T | ResponseFailure | undefined): response is T {
  if (response === undefined || response === null) {
    return false
  }

  if (isStudioError(response)) {
    return false
  }

  if (typeof response === 'object' && 'error' in response && Boolean(response.error)) {
    return false
  }

  return true
}

/**
 * Wrap native TanStack Start API route handlers with optional platform JWT authentication,
 * malformed-JSON 400 handling, Sentry error reporting, and an `ANY` fallback that returns
 * 405 Method Not Allowed with an `Allow` header derived from the registered methods.
 */
export function createApiHandlers<THandlers extends ApiMethodHandlers>(
  handlers: THandlers,
  options?: { withAuth?: boolean }
): WrappedApiHandlers<THandlers> {
  const allowedMethods = (Object.keys(handlers) as ApiMethod[]).filter(
    (method) => handlers[method] !== undefined
  )

  const wrapped: Partial<Record<ApiMethod | 'ANY', ServerRouteHandler>> = {}

  for (const method of allowedMethods) {
    const handler = handlers[method]!
    wrapped[method] = async ({ request, params = {} }) => {
      try {
        let claims: JwtPayload | undefined

        if (IS_PLATFORM && options?.withAuth) {
          const authResult = await authenticateRequest(request)
          if (!isResponseOk(authResult)) {
            return Response.json(
              { error: { message: `Unauthorized: ${authResult.error.message}` } },
              { status: 401 }
            )
          }
          claims = authResult
        }

        return await handler({ request, params, claims })
      } catch (error) {
        if (error instanceof InvalidJsonError) {
          return new Response('Invalid JSON', { status: 400, statusText: 'Invalid JSON' })
        }
        Sentry.captureException(error)
        return Response.json({ error: { message: 'Internal Server Error' } }, { status: 500 })
      }
    }
  }

  wrapped.ANY = async ({ request }) => methodNotAllowed(request, allowedMethods)

  return wrapped as WrappedApiHandlers<THandlers>
}

// Purpose of this apiWrapper is to function like a global catchall for ANY errors
// It's a safety net as the API service should never drop, nor fail

export async function apiWrapper(
  req: NextApiRequest,
  res: NextApiResponse,
  handler: (
    req: NextApiRequest,
    res: NextApiResponse,
    claims?: JwtPayload
  ) => Promise<NextApiResponse | Response | void>,
  options?: { withAuth: boolean }
): Promise<NextApiResponse | Response | void> {
  try {
    const { withAuth } = options || {}
    let claims: JwtPayload | undefined

    if (IS_PLATFORM && withAuth) {
      const response = await apiAuthenticate(req, res)
      if (!isResponseOk(response)) {
        return res.status(401).json({
          error: {
            message: `Unauthorized: ${response.error.message}`,
          },
        })
      }
      claims = response
    }

    return await handler(req, res, claims)
  } catch (error) {
    Sentry.captureException(error)
    return res.status(500).json({ error })
  }
}
