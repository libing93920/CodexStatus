import type { AgentId, AuthMode, UsageWindow } from '../../shared/capsule.ts'
import type { PeerSnapshot } from './lan.ts'

const SNAPSHOT_AUTH_MODES: readonly AuthMode[] = ['chatgpt', 'api', 'none']
const SNAPSHOT_USAGE_WINDOWS: readonly UsageWindow[] = ['1d', '7d', '30d']
const SNAPSHOT_AGENT_IDS: readonly AgentId[] = ['codex', 'claude', 'opencode']

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value))
}

function validateWindow(value: unknown): boolean {
  if (!isRecord(value) || typeof value.label !== 'string') return false
  return (
    Object.keys(value).every((key) => key === 'label' || key === 'remainingPercent') &&
    isOptionalNumber(value.remainingPercent)
  )
}

function validateUsageTotals(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([window, total]) =>
        SNAPSHOT_USAGE_WINDOWS.some((item) => item === window) && isOptionalNumber(total)
    )
  )
}

function validateAgentTotals(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([agent, total]) =>
        SNAPSHOT_AGENT_IDS.some((item) => item === agent) && isOptionalNumber(total)
    )
  )
}

function validateUsageByAgent(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([window, totals]) =>
        SNAPSHOT_USAGE_WINDOWS.some((item) => item === window) &&
        (totals === undefined || validateAgentTotals(totals))
    )
  )
}

export function validatePeerSnapshot(value: unknown): value is PeerSnapshot {
  if (!isRecord(value)) return false
  // 只验证协议的有限层结构，避免对网络对象递归遍历或深比较后才发现异常。
  return Object.entries(value).every(([key, field]) => {
    switch (key) {
      case 'nickname':
      case 'weeklyResetsAt':
      case 'appVersion':
        return field === undefined || typeof field === 'string'
      case 'authMode':
        return field === undefined || SNAPSHOT_AUTH_MODES.some((mode) => mode === field)
      case 'remainingPercent':
      case 'resetCreditCount':
        return isOptionalNumber(field)
      case 'shortWindow':
      case 'longWindow':
        return field === undefined || validateWindow(field)
      case 'tokenUsage':
      case 'costUsage':
        return field === undefined || validateUsageTotals(field)
      case 'tokenUsageByAgent':
        return field === undefined || validateUsageByAgent(field)
      default:
        return false
    }
  })
}
