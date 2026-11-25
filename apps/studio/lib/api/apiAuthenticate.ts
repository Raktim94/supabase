import type { JwtPayload } from '@supabase/supabase-js'

import { getUserClaims } from '@/lib/gotrue'

async function fetchUserClaimsFromHeader(
  authorization: string | null | undefined
): Promise<JwtPayload> {
  const token = authorization?.replace(/bearer /i, '')
  if (!token) {
    throw new Error('missing access token')
  }
  const { claims, error } = await getUserClaims(token)
  if (error) {
    throw error
  }

  if (!claims) {
    throw new Error('The user does not exist')
  }

  return claims
}

/**
 * Authenticate an incoming Web Request using its Authorization header.
 * This method can only be used from the server side.
 */
export async function authenticateRequest(
  request: Request
): Promise<JwtPayload | { error: Error }> {
  try {
    return await fetchUserClaimsFromHeader(request.headers.get('authorization'))
  } catch (error) {
    return { error: error as Error }
  }
}
