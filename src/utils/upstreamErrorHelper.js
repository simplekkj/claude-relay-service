const logger = require('./logger')

const TEMP_UNAVAILABLE_PREFIX = 'temp_unavailable'

// 默认 TTL（秒）
const DEFAULT_TTL = {
  server_error: 300, // 5xx: 5分钟
  overload: 600, // 529: 10分钟
  auth_error: 1800, // 401/403: 30分钟
  timeout: 300, // 504/网络超时: 5分钟
  rate_limit: 300 // 429: 5分钟（优先使用响应头解析值）
}

// 延迟加载配置，避免循环依赖
let _configCache = null
const getConfig = () => {
  if (!_configCache) {
    try {
      _configCache = require('../../config/config')
    } catch {
      _configCache = {}
    }
  }
  return _configCache
}

const getTtlConfig = () => {
  const config = getConfig()
  return {
    server_error: config.upstreamError?.serverErrorTtlSeconds ?? DEFAULT_TTL.server_error,
    overload: config.upstreamError?.overloadTtlSeconds ?? DEFAULT_TTL.overload,
    auth_error: config.upstreamError?.authErrorTtlSeconds ?? DEFAULT_TTL.auth_error,
    timeout: config.upstreamError?.timeoutTtlSeconds ?? DEFAULT_TTL.timeout,
    rate_limit: config.upstreamError?.rateLimitTtlSeconds ?? DEFAULT_TTL.rate_limit
  }
}

// 延迟加载 redis，避免循环依赖
let _redis = null
const getRedis = () => {
  if (!_redis) {
    _redis = require('../models/redis')
  }
  return _redis
}

// 根据 HTTP 状态码分类错误类型
const classifyError = (statusCode) => {
  if (statusCode === 529) {
    return 'overload'
  }
  if (statusCode === 504) {
    return 'timeout'
  }
  if (statusCode === 401 || statusCode === 403) {
    return 'auth_error'
  }
  if (statusCode === 429) {
    return 'rate_limit'
  }
  if (statusCode >= 500) {
    return 'server_error'
  }
  return null
}

const toPositiveSeconds = (value) => {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) {
    return null
  }
  return Math.ceil(num)
}

const parseSecondsFromDateString = (value) => {
  if (typeof value !== 'string') {
    return null
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  return toPositiveSeconds((date.getTime() - Date.now()) / 1000)
}

const parseDurationStringToSeconds = (value) => {
  if (typeof value !== 'string') {
    return null
  }
  const normalized = value.trim().toLowerCase()
  if (!normalized) {
    return null
  }

  const durationMatch = normalized.match(
    /^(\d+(?:\.\d+)?)\s*(ms|msec|millisecond|milliseconds|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/
  )
  if (!durationMatch) {
    return null
  }

  const amount = Number(durationMatch[1])
  const unit = durationMatch[2]
  if (!Number.isFinite(amount) || amount <= 0) {
    return null
  }

  if (unit === 'ms' || unit === 'msec' || unit.startsWith('millisecond')) {
    return toPositiveSeconds(amount / 1000)
  }
  if (unit === 'm' || unit === 'min' || unit === 'mins' || unit.startsWith('minute')) {
    return toPositiveSeconds(amount * 60)
  }
  if (unit === 'h' || unit === 'hr' || unit === 'hrs' || unit.startsWith('hour')) {
    return toPositiveSeconds(amount * 3600)
  }
  return toPositiveSeconds(amount)
}

const parseEpochToRemainingSeconds = (value) => {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) {
    return null
  }

  const nowMs = Date.now()
  const nowSeconds = nowMs / 1000

  // 13 位毫秒时间戳
  if (num > 1e12) {
    return toPositiveSeconds((num - nowMs) / 1000)
  }

  // 10 位秒级时间戳
  if (num > 1e9) {
    return toPositiveSeconds(num - nowSeconds)
  }

  return null
}

const normalizeHeaders = (headers) => {
  if (!headers || typeof headers !== 'object') {
    return {}
  }

  const normalized = {}
  for (const [key, value] of Object.entries(headers)) {
    if (!key) {
      continue
    }
    normalized[String(key).toLowerCase()] = Array.isArray(value) ? value[0] : value
  }
  return normalized
}

const parseDelayValue = (value, { absolute = false } = {}) => {
  if (value === undefined || value === null || value === '') {
    return null
  }

  if (absolute) {
    return parseEpochToRemainingSeconds(value) || parseSecondsFromDateString(String(value))
  }

  // 先按相对秒数解析（例如 retry-after: 120）
  const directSeconds = toPositiveSeconds(value)
  if (directSeconds !== null) {
    return directSeconds
  }

  // 支持类似 "8.64s"、"2500ms"
  const fromDuration = parseDurationStringToSeconds(String(value))
  if (fromDuration !== null) {
    return fromDuration
  }

  // retry-after 也可能是 HTTP 时间
  return parseSecondsFromDateString(String(value))
}

const collectDelayCandidates = (candidates) => {
  const valid = candidates.filter((value) => Number.isFinite(value) && value > 0)
  if (!valid.length) {
    return null
  }
  return Math.min(...valid)
}

const parseRateLimitDelayFromMessage = (message) => {
  if (typeof message !== 'string') {
    return null
  }

  const normalized = message.trim()
  if (!normalized) {
    return null
  }

  const patterns = [
    /(?:retry|try again|please try again|reset(?:s)?|available)\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec(?:onds?)?|m|min(?:utes?)?|h|hr(?:s)?|hours?)/i,
    /(?:in)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec(?:onds?)?|m|min(?:utes?)?|h|hr(?:s)?|hours?)/i
  ]

  for (const pattern of patterns) {
    const match = normalized.match(pattern)
    if (!match) {
      continue
    }
    const delay = parseDurationStringToSeconds(`${match[1]}${match[2]}`)
    if (delay !== null) {
      return delay
    }
  }

  const resetsMatch = normalized.match(/resets?_in_seconds["']?\s*[:=]\s*(\d+(?:\.\d+)?)/i)
  if (resetsMatch) {
    return toPositiveSeconds(resetsMatch[1])
  }

  return null
}

const parseRateLimitDelayFromError = (errorData) => {
  if (!errorData) {
    return null
  }

  if (typeof errorData === 'string') {
    return parseRateLimitDelayFromMessage(errorData)
  }

  if (typeof errorData !== 'object') {
    return null
  }

  const objectCandidates = [
    errorData,
    errorData.error,
    errorData.response,
    errorData.response?.error
  ].filter((item) => item && typeof item === 'object')

  const scalarFields = [
    'resets_in_seconds',
    'resets_in',
    'retry_after',
    'retry_after_seconds',
    'retryAfter',
    'reset_after_seconds'
  ]

  for (const candidate of objectCandidates) {
    for (const field of scalarFields) {
      const parsed = parseDelayValue(candidate[field], { absolute: false })
      if (parsed !== null) {
        return parsed
      }
    }

    const parsedFromMessage = parseRateLimitDelayFromMessage(
      candidate.message || candidate.detail || candidate.details
    )
    if (parsedFromMessage !== null) {
      return parsedFromMessage
    }
  }

  return parseRateLimitDelayFromMessage(JSON.stringify(errorData))
}

// 解析 429 响应头中的重置时间（返回秒数）
const parseRetryAfter = (headers) => {
  const normalized = normalizeHeaders(headers)
  if (!Object.keys(normalized).length) {
    return null
  }

  const candidates = []

  // 标准 Retry-After 头（秒数或 HTTP 日期）
  const retryAfter = parseDelayValue(normalized['retry-after'], { absolute: false })
  if (retryAfter !== null) {
    candidates.push(retryAfter)
  }

  // Anthropic 限流重置头（ISO 时间）
  const anthropicReset = parseDelayValue(normalized['anthropic-ratelimit-unified-reset'], {
    absolute: true
  })
  if (anthropicReset !== null) {
    candidates.push(anthropicReset)
  }

  // 常见的相对秒数头
  const relativeHeaders = [
    'x-ratelimit-reset-requests',
    'x-ratelimit-reset-tokens',
    'x-ratelimit-reset',
    'x-codex-ratelimit-reset',
    'x-codex-primary-reset-after-seconds',
    'x-codex-secondary-reset-after-seconds'
  ]
  for (const headerName of relativeHeaders) {
    const parsed = parseDelayValue(normalized[headerName], { absolute: false })
    if (parsed !== null) {
      candidates.push(parsed)
    }
  }

  // Codex 新的 reset-at 头族（绝对时间戳）
  const absoluteHeaders = ['x-codex-primary-reset-at', 'x-codex-secondary-reset-at']
  for (const headerName of absoluteHeaders) {
    const parsed = parseDelayValue(normalized[headerName], { absolute: true })
    if (parsed !== null) {
      candidates.push(parsed)
    }
  }

  // 兜底：匹配更多 x-*-primary/secondary-reset-at 头
  for (const [headerName, value] of Object.entries(normalized)) {
    const isRateLimitResetAt =
      /^x-[a-z0-9-]+-(primary|secondary)-reset-at$/.test(headerName) ||
      /^x-[a-z0-9-]+-reset-at$/.test(headerName)
    if (!isRateLimitResetAt) {
      continue
    }
    const parsed = parseDelayValue(value, { absolute: true })
    if (parsed !== null) {
      candidates.push(parsed)
    }
  }

  return collectDelayCandidates(candidates)
}

// 标记账户为临时不可用
const markTempUnavailable = async (accountId, accountType, statusCode, customTtl = null) => {
  try {
    const errorType = classifyError(statusCode)
    if (!errorType) {
      return { success: false, reason: 'not_a_pausable_error' }
    }

    const ttlConfig = getTtlConfig()
    const ttlSeconds = customTtl ?? ttlConfig[errorType]

    const redis = getRedis()
    const client = redis.getClientSafe()
    const key = `${TEMP_UNAVAILABLE_PREFIX}:${accountType}:${accountId}`
    await client.setex(
      key,
      ttlSeconds,
      JSON.stringify({
        statusCode,
        errorType,
        markedAt: new Date().toISOString()
      })
    )

    logger.warn(
      `⏱️ [UpstreamError] Account ${accountId} (${accountType}) marked temporarily unavailable for ${ttlSeconds}s (${statusCode} ${errorType})`
    )

    return { success: true, ttlSeconds, errorType }
  } catch (error) {
    logger.error(
      `❌ [UpstreamError] Failed to mark account ${accountId} temporarily unavailable:`,
      error
    )
    return { success: false }
  }
}

// 检查账户是否临时不可用
const isTempUnavailable = async (accountId, accountType) => {
  try {
    const redis = getRedis()
    const client = redis.getClientSafe()
    const key = `${TEMP_UNAVAILABLE_PREFIX}:${accountType}:${accountId}`
    return (await client.exists(key)) === 1
  } catch (error) {
    logger.error(
      `❌ [UpstreamError] Failed to check temp unavailable status for ${accountId}:`,
      error
    )
    return false
  }
}

// 清除临时不可用状态
const clearTempUnavailable = async (accountId, accountType) => {
  try {
    const redis = getRedis()
    const client = redis.getClientSafe()
    const key = `${TEMP_UNAVAILABLE_PREFIX}:${accountType}:${accountId}`
    await client.del(key)
  } catch (error) {
    logger.error(`❌ [UpstreamError] Failed to clear temp unavailable for ${accountId}:`, error)
  }
}

// 批量查询所有临时不可用状态（用于前端展示）
const getAllTempUnavailable = async () => {
  try {
    const redis = getRedis()
    const client = redis.getClientSafe()
    const pattern = `${TEMP_UNAVAILABLE_PREFIX}:*`
    const keys = await client.keys(pattern)
    if (!keys.length) {
      return {}
    }

    const pipeline = client.pipeline()
    for (const key of keys) {
      pipeline.get(key)
      pipeline.ttl(key)
    }
    const results = await pipeline.exec()

    const statuses = {}
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      // key format: temp_unavailable:{accountType}:{accountId}
      const parts = key.split(':')
      const accountType = parts[1]
      const accountId = parts.slice(2).join(':')
      const [getErr, value] = results[i * 2]
      const [ttlErr, ttl] = results[i * 2 + 1]
      if (getErr || ttlErr || !value) {
        continue
      }

      try {
        const data = JSON.parse(value)
        const compositeKey = `${accountType}:${accountId}`
        statuses[compositeKey] = {
          accountId,
          accountType,
          statusCode: data.statusCode,
          errorType: data.errorType,
          markedAt: data.markedAt,
          ttl: ttl > 0 ? ttl : 0
        }
      } catch {
        // ignore parse errors
      }
    }
    return statuses
  } catch (error) {
    logger.error('❌ [UpstreamError] Failed to get all temp unavailable statuses:', error)
    return {}
  }
}

// 清洗上游错误数据，去除内部路由标识（如 [codex/codex]）
const sanitizeErrorForClient = (errorData) => {
  if (!errorData || typeof errorData !== 'object') {
    return errorData
  }
  try {
    const str = JSON.stringify(errorData)
    const cleaned = str.replace(/ \[[^/\]]+\/[^\]]+\]/g, '')
    return JSON.parse(cleaned)
  } catch {
    return errorData
  }
}

module.exports = {
  markTempUnavailable,
  isTempUnavailable,
  clearTempUnavailable,
  getAllTempUnavailable,
  classifyError,
  parseRetryAfter,
  parseRateLimitDelayFromMessage,
  parseRateLimitDelayFromError,
  sanitizeErrorForClient,
  TEMP_UNAVAILABLE_PREFIX
}
