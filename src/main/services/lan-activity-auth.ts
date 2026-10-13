import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { isPeerId, parseTeamIdentity, type TeamRole } from '../../shared/team-role.ts'
import { ACTIVITY_PROTOCOL_VERSION } from '../../shared/activity.ts'

const AUTH_DOMAIN = 'codex-status:activity-auth:v1'
const NONCE_BYTES = 32
const HEX_DIGEST_PATTERN = /^[a-f0-9]{64}$/

export interface ActivityAuthHello {
  peerId: string
  role?: TeamRole
  activityVersion?: number
  activityEnabled?: boolean
  activityNonce?: string
  activityProof?: string
}

interface ConnectionAuth {
  nonce: string
  remoteNonce?: string
  remotePeerId?: string
  sentProof: boolean
  verified: boolean
}

export class ActivityConnectionAuth {
  private readonly connections = new WeakMap<object, ConnectionAuth>()

  decorateHello<T extends ActivityAuthHello>(socket: object, group: string, hello: T): T {
    const state = this.getState(socket)
    const result = { ...hello, activityNonce: state.nonce }
    if (state.remoteNonce && state.remotePeerId) {
      result.activityProof = this.proof(group, {
        ...result,
        challenge: state.remoteNonce,
        receiverPeerId: state.remotePeerId
      })
      state.sentProof = true
    }
    return result
  }

  receiveHello(
    socket: object,
    group: string,
    localPeerId: string,
    hello: ActivityAuthHello
  ): 'pending' | 'verified' | 'invalid' {
    const state = this.getState(socket)
    const wasVerified = state.verified
    state.verified = false
    if (
      !isPeerId(hello.peerId) ||
      hello.peerId === localPeerId ||
      typeof hello.activityNonce !== 'string' ||
      !HEX_DIGEST_PATTERN.test(hello.activityNonce) ||
      !['member', 'admin'].includes(hello.role ?? '') ||
      hello.activityVersion !== ACTIVITY_PROTOCOL_VERSION ||
      typeof hello.activityEnabled !== 'boolean' ||
      (state.remoteNonce !== undefined && state.remoteNonce !== hello.activityNonce) ||
      (state.remotePeerId !== undefined && state.remotePeerId !== hello.peerId)
    )
      return 'invalid'
    state.remoteNonce = hello.activityNonce
    state.remotePeerId = hello.peerId
    if (hello.activityProof === undefined) return wasVerified ? 'invalid' : 'pending'
    if (typeof hello.activityProof !== 'string' || !HEX_DIGEST_PATTERN.test(hello.activityProof))
      return 'invalid'
    const expected = this.proof(group, {
      ...hello,
      challenge: state.nonce,
      receiverPeerId: localPeerId
    })
    state.verified = timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(hello.activityProof, 'hex')
    )
    return state.verified ? 'verified' : 'invalid'
  }

  needsReply(socket: object): boolean {
    const state = this.connections.get(socket)
    return !!state?.remoteNonce && !state.sentProof
  }

  isVerified(socket: object | undefined, peerId: string): boolean {
    const state = socket ? this.connections.get(socket) : undefined
    return state?.verified === true && state.remotePeerId === peerId
  }

  private getState(socket: object): ConnectionAuth {
    let state = this.connections.get(socket)
    if (!state) {
      state = { nonce: randomBytes(NONCE_BYTES).toString('hex'), sentProof: false, verified: false }
      this.connections.set(socket, state)
    }
    return state
  }

  private proof(
    group: string,
    hello: ActivityAuthHello & { challenge: string; receiverPeerId: string }
  ): string {
    // 公开的groupHash不能作为密钥；证明同时绑定连接挑战、双方身份和声明的能力。
    return createHmac('sha256', parseTeamIdentity(group).group)
      .update(
        JSON.stringify([
          AUTH_DOMAIN,
          hello.challenge,
          hello.activityNonce,
          hello.peerId,
          hello.receiverPeerId,
          hello.role,
          hello.activityVersion,
          hello.activityEnabled
        ])
      )
      .digest('hex')
  }
}
