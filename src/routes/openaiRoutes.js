const express = require('express')
const axios = require('axios')
const router = express.Router()
const logger = require('../utils/logger')
const config = require('../../config/config')
const { authenticateApiKey } = require('../middleware/auth')
const unifiedOpenAIScheduler = require('../services/unifiedOpenAIScheduler')
const openaiAccountService = require('../services/openaiAccountService')
const openaiResponsesAccountService = require('../services/openaiResponsesAccountService')
const openaiResponsesRelayService = require('../services/openaiResponsesRelayService')
const apiKeyService = require('../services/apiKeyService')
const redis = require('../models/redis')
const crypto = require('crypto')
const ProxyHelper = require('../utils/proxyHelper')
const { updateRateLimitCounters } = require('../utils/rateLimitHelper')
const { IncrementalSSEParser } = require('../utils/sseParser')
const { getSafeMessage } = require('../utils/errorSanitizer')
const upstreamErrorHelper = require('../utils/upstreamErrorHelper')

const DEFAULT_429_FAILOVER_ATTEMPTS = 3
const MAX_429_FAILOVER_ATTEMPTS = (() => {
  const raw = Number(config.openai?.max429FailoverAttempts)
  if (!Number.isFinite(raw)) {
    return DEFAULT_429_FAILOVER_ATTEMPTS
  }
  return Math.max(1, Math.floor(raw))
})()

// 创建代理 Agent（使用统一的代理工具）
function createProxyAgent(proxy) {
  return ProxyHelper.createProxyAgent(proxy)
}

// 检查 API Key 是否具备 OpenAI 权限
function checkOpenAIPermissions(apiKeyData) {
  return apiKeyService.hasPermission(apiKeyData?.permissions, 'openai')
}

const CODEX_BASE_INSTRUCTIONS = 'You are Codex, based on GPT-5.'
const OPENAI_CODEX_MODELS_ENDPOINT = 'https://chatgpt.com/backend-api/codex/models'
const DYNAMIC_OPENAI_MODELS_CACHE_PREFIX = 'openai_codex_models_catalog:'
const DYNAMIC_OPENAI_MODELS_CACHE_TTL_SECONDS = 600
const MODELS_CATALOG_UNAVAILABLE_CODE = 'models_catalog_unavailable'
const MODELS_FORWARD_HEADER_KEYS = [
  'version',
  'openai-version',
  'openai-beta',
  'x-codex-beta-features',
  'x-responsesapi-include-timing-metrics'
]

function buildReasoningLevels(modelId) {
  if (modelId.includes('mini')) {
    return [
      {
        effort: 'medium',
        description: 'Dynamically adjusts reasoning based on the task'
      },
      {
        effort: 'high',
        description: 'Maximizes reasoning depth for complex or ambiguous problems'
      }
    ]
  }

  return [
    {
      effort: 'low',
      description: 'Fast responses with lighter reasoning'
    },
    {
      effort: 'medium',
      description: 'Balances speed and reasoning depth for everyday tasks'
    },
    {
      effort: 'high',
      description: 'Greater reasoning depth for complex problems'
    },
    {
      effort: 'xhigh',
      description: 'Extra high reasoning depth for complex problems'
    }
  ]
}

function buildCodexModelDescription(modelId) {
  if (modelId.includes('codex-max')) {
    return 'Codex-optimized flagship for deep and fast reasoning.'
  }
  if (modelId.includes('codex-mini')) {
    return 'Optimized for coding. Cheaper and faster for iterative tasks.'
  }
  if (modelId.includes('codex')) {
    return 'Agentic coding model tuned for repository tasks.'
  }
  return 'General-purpose model for coding and reasoning.'
}

function buildCodexModelInfo(modelId, priority) {
  const supportedReasoningLevels = buildReasoningLevels(modelId)
  const defaultReasoningLevel = supportedReasoningLevels.some((item) => item.effort === 'medium')
    ? 'medium'
    : supportedReasoningLevels[0]?.effort || 'medium'
  return {
    slug: modelId,
    display_name: modelId,
    description: buildCodexModelDescription(modelId),
    default_reasoning_level: defaultReasoningLevel,
    supported_reasoning_levels: supportedReasoningLevels,
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority,
    upgrade: null,
    base_instructions: CODEX_BASE_INSTRUCTIONS,
    model_messages: null,
    supports_reasoning_summaries: false,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    truncation_policy: {
      mode: 'tokens',
      limit: 272000
    },
    supports_parallel_tool_calls: false,
    context_window: 272000,
    auto_compact_token_limit: null,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ['text', 'image'],
    prefer_websockets: false
  }
}

function buildModelsEtag(payload) {
  const digest = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  return `"${digest}"`
}

function shouldForceModelRefresh(query = {}) {
  const raw = query.refresh ?? query.force_refresh ?? query.forceRefresh
  if (raw === undefined || raw === null) {
    return false
  }
  const normalized = String(raw).trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes'
}

function getSessionIdFromRequest(req) {
  return (
    req.headers['session_id'] ||
    req.headers['x-session-id'] ||
    req.query?.session_id ||
    req.query?.conversation_id ||
    req.body?.session_id ||
    req.body?.conversation_id ||
    null
  )
}

function isCompactEndpointRequest(req) {
  return (
    req.path === '/responses/compact' ||
    req.path === '/v1/responses/compact' ||
    (typeof req.originalUrl === 'string' && /\/responses\/compact(?:\?|$)/.test(req.originalUrl))
  )
}

function normalizeCompactRequestBody(rawBody) {
  const body = rawBody && typeof rawBody === 'object' ? rawBody : {}
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  const hasInput = Array.isArray(body.input)
  const hasInstructions = typeof body.instructions === 'string'

  const missing = []
  if (!model) {
    missing.push('model')
  }
  if (!hasInput) {
    missing.push('input')
  }
  if (!hasInstructions) {
    missing.push('instructions')
  }

  if (missing.length > 0) {
    return { missing }
  }

  return {
    body: {
      model,
      input: body.input,
      instructions: body.instructions
    }
  }
}

function getModelIdentifier(model) {
  if (!model) {
    return ''
  }
  if (typeof model === 'string') {
    return model.trim()
  }
  if (typeof model !== 'object') {
    return ''
  }
  const candidates = [model.slug, model.id, model.model, model.name]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim()
    }
  }
  return ''
}

function normalizeReasoningLevels(levels, modelId) {
  if (!Array.isArray(levels) || levels.length === 0) {
    return buildReasoningLevels(modelId)
  }

  const normalized = levels
    .map((level) => {
      if (typeof level === 'string') {
        return {
          effort: level.toLowerCase(),
          description: ''
        }
      }
      if (!level || typeof level !== 'object') {
        return null
      }
      const effortCandidate = level.effort || level.level || level.name
      if (typeof effortCandidate !== 'string' || !effortCandidate.trim()) {
        return null
      }
      return {
        effort: effortCandidate.trim().toLowerCase(),
        description: typeof level.description === 'string' ? level.description : ''
      }
    })
    .filter(Boolean)

  if (normalized.length === 0) {
    return buildReasoningLevels(modelId)
  }

  return normalized
}

function normalizeUpstreamCodexModel(rawModel, priority) {
  const modelId = getModelIdentifier(rawModel)
  if (!modelId) {
    return null
  }

  const fallback = buildCodexModelInfo(modelId, priority)
  if (!rawModel || typeof rawModel !== 'object') {
    return fallback
  }

  const supportedReasoningLevels = normalizeReasoningLevels(
    rawModel.supported_reasoning_levels || rawModel.supported_reasoning_efforts,
    modelId
  )
  const defaultReasoningLevelCandidate = String(
    rawModel.default_reasoning_level || rawModel.default_reasoning_effort || ''
  )
    .trim()
    .toLowerCase()
  const defaultReasoningLevel = supportedReasoningLevels.some(
    (item) => item.effort === defaultReasoningLevelCandidate
  )
    ? defaultReasoningLevelCandidate
    : supportedReasoningLevels.some((item) => item.effort === 'medium')
      ? 'medium'
      : supportedReasoningLevels[0]?.effort || fallback.default_reasoning_level
  const numericPriority = Number(rawModel.priority)

  return {
    ...fallback,
    ...rawModel,
    slug: modelId,
    display_name:
      typeof rawModel.display_name === 'string' && rawModel.display_name.trim()
        ? rawModel.display_name
        : typeof rawModel.name === 'string' && rawModel.name.trim()
          ? rawModel.name
          : modelId,
    description:
      typeof rawModel.description === 'string' ? rawModel.description : fallback.description,
    supported_reasoning_levels: supportedReasoningLevels,
    default_reasoning_level: defaultReasoningLevel,
    priority: Number.isFinite(numericPriority) ? numericPriority : priority,
    visibility: typeof rawModel.visibility === 'string' ? rawModel.visibility : fallback.visibility,
    supported_in_api:
      typeof rawModel.supported_in_api === 'boolean' ? rawModel.supported_in_api : true,
    truncation_policy:
      rawModel.truncation_policy && typeof rawModel.truncation_policy === 'object'
        ? rawModel.truncation_policy
        : fallback.truncation_policy,
    input_modalities:
      Array.isArray(rawModel.input_modalities) && rawModel.input_modalities.length > 0
        ? rawModel.input_modalities
        : fallback.input_modalities
  }
}

function normalizeDynamicModelsPayload(payload) {
  const candidates = []

  if (Array.isArray(payload?.models)) {
    candidates.push(...payload.models)
  } else if (payload?.models && typeof payload.models === 'object') {
    for (const [modelId, modelInfo] of Object.entries(payload.models)) {
      if (modelInfo && typeof modelInfo === 'object') {
        candidates.push({ slug: modelId, ...modelInfo })
      } else {
        candidates.push(modelId)
      }
    }
  }

  if (Array.isArray(payload?.data)) {
    candidates.push(...payload.data)
  }

  if (Array.isArray(payload)) {
    candidates.push(...payload)
  }

  const deduped = new Map()
  for (let i = 0; i < candidates.length; i += 1) {
    const normalized = normalizeUpstreamCodexModel(candidates[i], i + 1)
    if (!normalized) {
      continue
    }
    if (!deduped.has(normalized.slug)) {
      deduped.set(normalized.slug, normalized)
    }
  }

  return Array.from(deduped.values()).sort((a, b) => {
    const priorityA = Number.isFinite(Number(a.priority))
      ? Number(a.priority)
      : Number.MAX_SAFE_INTEGER
    const priorityB = Number.isFinite(Number(b.priority))
      ? Number(b.priority)
      : Number.MAX_SAFE_INTEGER
    if (priorityA !== priorityB) {
      return priorityA - priorityB
    }
    return String(a.slug || '').localeCompare(String(b.slug || ''))
  })
}

function filterModelsByApiKeyRestriction(models, apiKeyData) {
  if (
    !apiKeyData?.enableModelRestriction ||
    !Array.isArray(apiKeyData.restrictedModels) ||
    apiKeyData.restrictedModels.length === 0
  ) {
    return models
  }

  const restricted = new Set(apiKeyData.restrictedModels)
  return models.filter((model) => !restricted.has(getModelIdentifier(model)))
}

function buildDynamicModelsCacheKey(accountType, accountId) {
  return `${DYNAMIC_OPENAI_MODELS_CACHE_PREFIX}${accountType}:${accountId}`
}

async function getCachedDynamicModelInfos(accountType, accountId) {
  try {
    const client = redis.getClientSafe()
    const raw = await client.get(buildDynamicModelsCacheKey(accountType, accountId))
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed?.models)) {
      return parsed.models
    }
  } catch (error) {
    logger.warn(
      `⚠️ Failed to read dynamic models cache for account ${accountType}:${accountId}:`,
      error.message
    )
  }
  return null
}

async function setCachedDynamicModelInfos(accountType, accountId, models) {
  try {
    const client = redis.getClientSafe()
    await client.setex(
      buildDynamicModelsCacheKey(accountType, accountId),
      DYNAMIC_OPENAI_MODELS_CACHE_TTL_SECONDS,
      JSON.stringify({
        models,
        updatedAt: new Date().toISOString()
      })
    )
  } catch (error) {
    logger.warn(
      `⚠️ Failed to write dynamic models cache for account ${accountType}:${accountId}:`,
      error.message
    )
  }
}

async function fetchCodexModelsFromOpenAIAccount(authContext, req, forceRefresh = false) {
  if (!authContext?.accessToken) {
    throw new Error('OpenAI account has no usable accessToken for models fetch')
  }

  if (!forceRefresh) {
    const cached = await getCachedDynamicModelInfos(authContext.accountType, authContext.accountId)
    if (Array.isArray(cached) && cached.length > 0) {
      return cached
    }
  }

  const headers = {}
  const incoming = req.headers || {}
  for (const key of MODELS_FORWARD_HEADER_KEYS) {
    if (incoming[key] !== undefined) {
      headers[key] = incoming[key]
    }
  }
  headers.authorization = `Bearer ${authContext.accessToken}`
  headers['chatgpt-account-id'] =
    authContext?.account?.accountId || authContext?.account?.chatgptUserId || authContext.accountId
  headers.host = 'chatgpt.com'
  headers.accept = 'application/json'

  const clientVersion =
    typeof req.query?.client_version === 'string' && req.query.client_version.trim()
      ? req.query.client_version.trim()
      : null
  const modelsUrl = clientVersion
    ? `${OPENAI_CODEX_MODELS_ENDPOINT}?client_version=${encodeURIComponent(clientVersion)}`
    : OPENAI_CODEX_MODELS_ENDPOINT

  const axiosConfig = {
    headers,
    timeout: config.requestTimeout || 600000,
    validateStatus: () => true
  }

  const proxyAgent = createProxyAgent(authContext.proxy)
  if (proxyAgent) {
    axiosConfig.httpAgent = proxyAgent
    axiosConfig.httpsAgent = proxyAgent
    axiosConfig.proxy = false
  }

  const upstream = await axios.get(modelsUrl, axiosConfig)
  if (upstream.status < 200 || upstream.status >= 300) {
    throw new Error(`OpenAI codex models endpoint returned status ${upstream.status}`)
  }

  const normalizedModels = normalizeDynamicModelsPayload(upstream.data)
  if (normalizedModels.length === 0) {
    throw new Error('No models returned from OpenAI codex models endpoint')
  }

  await setCachedDynamicModelInfos(authContext.accountType, authContext.accountId, normalizedModels)
  return normalizedModels
}

async function fetchCodexModelsFromOpenAIResponsesAccount(authContext, forceRefresh = false) {
  void authContext
  void forceRefresh
  const error = new Error(
    'OpenAI-Responses accounts do not expose authoritative Codex /models metadata'
  )
  error.code = MODELS_CATALOG_UNAVAILABLE_CODE
  error.statusCode = 503
  throw error
}

async function fetchDynamicCodexModelInfos(authContext, req, forceRefresh = false) {
  if (authContext.accountType === 'openai-responses') {
    return fetchCodexModelsFromOpenAIResponsesAccount(authContext, forceRefresh)
  }
  return fetchCodexModelsFromOpenAIAccount(authContext, req, forceRefresh)
}

function buildModelsCatalogUnavailablePayload(accountType, error) {
  const accountTypeLabel =
    typeof accountType === 'string' && accountType.trim() ? accountType.trim() : 'unknown'
  const reason = typeof error?.message === 'string' && error.message.trim() ? error.message : null
  const message =
    accountTypeLabel === 'openai-responses'
      ? 'The selected account type cannot provide Codex /models metadata required by /model. Bind an OpenAI ChatGPT account to use /model.'
      : reason
        ? `Failed to load authoritative Codex /models metadata: ${reason}`
        : 'Failed to load authoritative Codex /models metadata.'
  return {
    error: {
      message,
      type: 'service_unavailable',
      code: MODELS_CATALOG_UNAVAILABLE_CODE
    }
  }
}

async function handleCodexModels(req, res) {
  try {
    const apiKeyData = req.apiKey

    if (!checkOpenAIPermissions(apiKeyData)) {
      return res.status(403).json({
        error: {
          message: 'This API key does not have permission to access OpenAI',
          type: 'permission_denied',
          code: 'permission_denied'
        }
      })
    }

    const sessionId = getSessionIdFromRequest(req)
    const requestedModelHint =
      typeof req.query?.model === 'string' && req.query.model.trim() ? req.query.model.trim() : null
    const forceRefresh = shouldForceModelRefresh(req.query)
    let authContext = null

    let modelInfos = []
    try {
      authContext = await getOpenAIAuthToken(apiKeyData, sessionId, requestedModelHint)
      modelInfos = await fetchDynamicCodexModelInfos(authContext, req, forceRefresh)
      logger.info(
        `📋 Loaded dynamic OpenAI model catalog from ${authContext.accountType}:${authContext.accountId} (${modelInfos.length} models)`
      )
    } catch (dynamicError) {
      logger.warn(
        `⚠️ Failed to load authoritative OpenAI model catalog from ${authContext?.accountType || 'unknown'}:${authContext?.accountId || 'unknown'}: ${dynamicError.message}`
      )
      const statusCode = Number(dynamicError?.statusCode)
      const status = Number.isFinite(statusCode) ? Math.max(400, Math.trunc(statusCode)) : 503
      return res
        .status(status)
        .json(buildModelsCatalogUnavailablePayload(authContext?.accountType, dynamicError))
    }

    modelInfos = filterModelsByApiKeyRestriction(modelInfos, apiKeyData)
    const payload = { models: modelInfos }

    const etag = buildModelsEtag(payload)
    const ifNoneMatch = String(req.headers['if-none-match'] || '').trim()
    if (ifNoneMatch && ifNoneMatch === etag) {
      res.setHeader('ETag', etag)
      return res.status(304).end()
    }

    res.setHeader('ETag', etag)
    res.setHeader('Cache-Control', 'private, max-age=60')
    return res.json(payload)
  } catch (error) {
    logger.error('❌ OpenAI Codex models list error:', error)
    return res.status(500).json({
      error: 'Failed to get models list',
      message: error.message
    })
  }
}

function normalizeHeaders(headers = {}) {
  if (!headers || typeof headers !== 'object') {
    return {}
  }
  const normalized = {}
  for (const [key, value] of Object.entries(headers)) {
    if (!key) {
      continue
    }
    normalized[key.toLowerCase()] = Array.isArray(value) ? value[0] : value
  }
  return normalized
}

function toNumberSafe(value) {
  if (value === undefined || value === null || value === '') {
    return null
  }
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function toResetAfterSecondsFromResetAt(value) {
  const ts = toNumberSafe(value)
  if (ts === null) {
    return null
  }

  const nowMs = Date.now()
  const nowSeconds = nowMs / 1000

  if (ts > 1e12) {
    const remaining = Math.ceil((ts - nowMs) / 1000)
    return remaining > 0 ? remaining : null
  }

  if (ts > 1e9) {
    const remaining = Math.ceil(ts - nowSeconds)
    return remaining > 0 ? remaining : null
  }

  return null
}

function extractCodexUsageHeaders(headers) {
  const normalized = normalizeHeaders(headers)
  if (!normalized || Object.keys(normalized).length === 0) {
    return null
  }

  const primaryResetAfterSeconds =
    toNumberSafe(normalized['x-codex-primary-reset-after-seconds']) ??
    toResetAfterSecondsFromResetAt(normalized['x-codex-primary-reset-at'])

  const secondaryResetAfterSeconds =
    toNumberSafe(normalized['x-codex-secondary-reset-after-seconds']) ??
    toResetAfterSecondsFromResetAt(normalized['x-codex-secondary-reset-at'])

  const snapshot = {
    primaryUsedPercent: toNumberSafe(normalized['x-codex-primary-used-percent']),
    primaryResetAfterSeconds,
    primaryWindowMinutes: toNumberSafe(normalized['x-codex-primary-window-minutes']),
    secondaryUsedPercent: toNumberSafe(normalized['x-codex-secondary-used-percent']),
    secondaryResetAfterSeconds,
    secondaryWindowMinutes: toNumberSafe(normalized['x-codex-secondary-window-minutes']),
    primaryOverSecondaryPercent: toNumberSafe(
      normalized['x-codex-primary-over-secondary-limit-percent']
    )
  }

  const hasData = Object.values(snapshot).some((value) => value !== null)
  return hasData ? snapshot : null
}

async function parseRateLimitError(upstream, isStream) {
  let resetsInSeconds = null
  let errorData = null

  try {
    if (isStream && upstream.data && typeof upstream.data.on === 'function') {
      const chunks = []
      await new Promise((resolve, reject) => {
        upstream.data.on('data', (chunk) => chunks.push(chunk))
        upstream.data.on('end', resolve)
        upstream.data.on('error', reject)
        setTimeout(resolve, 5000)
      })

      const fullResponse = Buffer.concat(chunks).toString()
      if (fullResponse.includes('data: ')) {
        const lines = fullResponse.split('\n')
        for (const line of lines) {
          if (!line.startsWith('data: ')) {
            continue
          }
          const payload = line.slice(6).trim()
          if (!payload || payload === '[DONE]') {
            continue
          }
          try {
            const parsed = JSON.parse(payload)
            if (parsed?.error) {
              errorData = parsed
              break
            }
            if (parsed?.response?.error) {
              errorData = { error: parsed.response.error }
              break
            }
            if (!errorData) {
              errorData = parsed
            }
          } catch {
            // ignore line-level parse errors and continue scanning
          }
        }
      }

      if (!errorData) {
        try {
          errorData = JSON.parse(fullResponse)
        } catch (e) {
          logger.error('Failed to parse 429 error response:', e)
          logger.debug('Raw response:', fullResponse)
        }
      }
    } else {
      errorData = upstream.data
      if (typeof errorData === 'string') {
        try {
          errorData = JSON.parse(errorData)
        } catch {
          errorData = { error: { message: errorData } }
        }
      }
    }

    resetsInSeconds =
      upstreamErrorHelper.parseRateLimitDelayFromError(errorData) ||
      upstreamErrorHelper.parseRetryAfter(upstream.headers)

    if (resetsInSeconds !== null) {
      logger.info(
        `🕐 Codex rate limit will reset in ${resetsInSeconds} seconds (${Math.ceil(resetsInSeconds / 60)} minutes / ${Math.ceil(resetsInSeconds / 3600)} hours)`
      )
    } else {
      logger.warn(
        '⚠️ Could not extract reset time from 429 response, using scheduler default behavior'
      )
    }
  } catch (error) {
    logger.error('⚠️ Failed to parse rate limit error:', error)
  }

  return { resetsInSeconds, errorData }
}

function createRateLimitErrorResponse(errorData, resetsInSeconds) {
  return (
    errorData || {
      error: {
        type: 'usage_limit_reached',
        message: 'The usage limit has been reached',
        resets_in_seconds: resetsInSeconds
      }
    }
  )
}

function sendRateLimitResponse(res, isStream, errorResponse) {
  if (isStream) {
    res.status(429)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.write(`data: ${JSON.stringify(errorResponse)}\n\n`)
    res.end()
    return
  }

  res.status(429).json(errorResponse)
}

function extractStreamErrorPayload(eventData) {
  if (!eventData || typeof eventData !== 'object') {
    return null
  }

  if (eventData.error && typeof eventData.error === 'object') {
    return eventData.error
  }

  if (eventData.response?.error && typeof eventData.response.error === 'object') {
    return eventData.response.error
  }

  return null
}

function isRateLimitErrorPayload(errorPayload) {
  if (!errorPayload || typeof errorPayload !== 'object') {
    return false
  }

  const type = String(errorPayload.type || '').toLowerCase()
  const code = String(errorPayload.code || '').toLowerCase()
  const message = String(errorPayload.message || '').toLowerCase()

  if (
    type === 'usage_limit_reached' ||
    type === 'rate_limit_error' ||
    type === 'rate_limit_exceeded'
  ) {
    return true
  }

  if (code === 'rate_limit_exceeded') {
    return true
  }

  return message.includes('rate limit') || message.includes('too many requests')
}

async function applyRateLimitTracking(req, usageSummary, model, context = '', accountType = null) {
  if (!req.rateLimitInfo) {
    return
  }

  const label = context ? ` (${context})` : ''

  try {
    const { totalTokens, totalCost } = await updateRateLimitCounters(
      req.rateLimitInfo,
      usageSummary,
      model,
      req.apiKey?.id,
      accountType
    )

    if (totalTokens > 0) {
      logger.api(`📊 Updated rate limit token count${label}: +${totalTokens} tokens`)
    }
    if (typeof totalCost === 'number' && totalCost > 0) {
      logger.api(`💰 Updated rate limit cost count${label}: +$${totalCost.toFixed(6)}`)
    }
  } catch (error) {
    logger.error(`❌ Failed to update rate limit counters${label}:`, error)
  }
}

// 使用统一调度器选择 OpenAI 账户
async function getOpenAIAuthToken(apiKeyData, sessionId = null, requestedModel = null) {
  try {
    // 生成会话哈希（如果有会话ID）
    const sessionHash = sessionId
      ? crypto.createHash('sha256').update(sessionId).digest('hex')
      : null

    // 使用统一调度器选择账户
    const result = await unifiedOpenAIScheduler.selectAccountForApiKey(
      apiKeyData,
      sessionHash,
      requestedModel
    )

    if (!result || !result.accountId) {
      const error = new Error('No available OpenAI account found')
      error.statusCode = 402 // Payment Required - 资源耗尽
      throw error
    }

    // 根据账户类型获取账户详情
    let account,
      accessToken,
      proxy = null

    if (result.accountType === 'openai-responses') {
      // 处理 OpenAI-Responses 账户
      account = await openaiResponsesAccountService.getAccount(result.accountId)
      if (!account || !account.apiKey) {
        const error = new Error(`OpenAI-Responses account ${result.accountId} has no valid apiKey`)
        error.statusCode = 403 // Forbidden - 账户配置错误
        throw error
      }

      // OpenAI-Responses 账户不需要 accessToken，直接返回账户信息
      accessToken = null // OpenAI-Responses 使用账户内的 apiKey

      // 解析代理配置
      if (account.proxy) {
        try {
          proxy = typeof account.proxy === 'string' ? JSON.parse(account.proxy) : account.proxy
        } catch (e) {
          logger.warn('Failed to parse proxy configuration:', e)
        }
      }

      logger.info(`Selected OpenAI-Responses account: ${account.name} (${result.accountId})`)
    } else {
      // 处理普通 OpenAI 账户
      account = await openaiAccountService.getAccount(result.accountId)
      if (!account || !account.accessToken) {
        const error = new Error(`OpenAI account ${result.accountId} has no valid accessToken`)
        error.statusCode = 403 // Forbidden - 账户配置错误
        throw error
      }

      // 检查 token 是否过期并自动刷新（双重保护）
      if (openaiAccountService.isTokenExpired(account)) {
        if (account.refreshToken) {
          logger.info(`🔄 Token expired, auto-refreshing for account ${account.name} (fallback)`)
          try {
            await openaiAccountService.refreshAccountToken(result.accountId)
            // 重新获取更新后的账户
            account = await openaiAccountService.getAccount(result.accountId)
            logger.info(`✅ Token refreshed successfully in route handler`)
          } catch (refreshError) {
            logger.error(`Failed to refresh token for ${account.name}:`, refreshError)
            const error = new Error(`Token expired and refresh failed: ${refreshError.message}`)
            error.statusCode = 403 // Forbidden - 认证失败
            throw error
          }
        } else {
          const error = new Error(
            `Token expired and no refresh token available for account ${account.name}`
          )
          error.statusCode = 403 // Forbidden - 认证失败
          throw error
        }
      }

      // 解密 accessToken（account.accessToken 是加密的）
      accessToken = openaiAccountService.decrypt(account.accessToken)
      if (!accessToken) {
        const error = new Error('Failed to decrypt OpenAI accessToken')
        error.statusCode = 403 // Forbidden - 配置/权限错误
        throw error
      }

      // 解析代理配置
      if (account.proxy) {
        try {
          proxy = typeof account.proxy === 'string' ? JSON.parse(account.proxy) : account.proxy
        } catch (e) {
          logger.warn('Failed to parse proxy configuration:', e)
        }
      }

      logger.info(`Selected OpenAI account: ${account.name} (${result.accountId})`)
    }

    return {
      accessToken,
      accountId: result.accountId,
      accountName: account.name,
      accountType: result.accountType,
      proxy,
      account
    }
  } catch (error) {
    logger.error('Failed to get OpenAI auth token:', error)
    throw error
  }
}

// 主处理函数，供两个路由共享
const handleResponses = async (req, res) => {
  let upstream = null
  let accountId = null
  let accountType = 'openai'
  let sessionHash = null
  let account = null
  let proxy = null
  let accessToken = null

  try {
    if (!req.body || typeof req.body !== 'object') {
      req.body = {}
    }

    // 从中间件获取 API Key 数据
    const apiKeyData = req.apiKey || {}

    if (!checkOpenAIPermissions(apiKeyData)) {
      logger.security(
        `🚫 API Key ${apiKeyData.id || 'unknown'} 缺少 OpenAI 权限，拒绝访问 ${req.originalUrl}`
      )
      return res.status(403).json({
        error: {
          message: 'This API key does not have permission to access OpenAI',
          type: 'permission_denied',
          code: 'permission_denied'
        }
      })
    }

    // 从请求头或请求体中提取会话 ID
    const sessionId =
      req.headers['session_id'] ||
      req.headers['x-session-id'] ||
      req.body?.session_id ||
      req.body?.conversation_id ||
      null

    sessionHash = sessionId ? crypto.createHash('sha256').update(sessionId).digest('hex') : null

    // 从请求体中提取模型和流式标志
    const requestedModel = req.body?.model || null

    // 判断是否为 Codex CLI 的请求（基于 User-Agent）
    // 支持: codex_vscode, codex_cli_rs, codex_exec (非交互式/脚本模式)
    const userAgent = req.headers['user-agent'] || ''
    const codexCliPattern = /^(codex_vscode|codex_cli_rs|codex_exec)\/[\d.]+/i
    const isCodexCLI = codexCliPattern.test(userAgent)

    // 如果不是 Codex CLI 请求，则进行适配
    if (!isCodexCLI) {
      // 移除不需要的请求体字段
      const fieldsToRemove = [
        'temperature',
        'top_p',
        'max_output_tokens',
        'user',
        'text_formatting',
        'truncation',
        'text',
        'service_tier',
        'prompt_cache_retention',
        'safety_identifier'
      ]
      fieldsToRemove.forEach((field) => {
        delete req.body[field]
      })

      // 设置固定的 Codex CLI instructions
      req.body.instructions =
        "You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI on a user's computer.\n\n## General\n\n- When searching for text or files, prefer using `rg` or `rg --files` respectively because `rg` is much faster than alternatives like `grep`. (If the `rg` command is not found, then use alternatives.)\n\n## Editing constraints\n\n- Default to ASCII when editing or creating files. Only introduce non-ASCII or other Unicode characters when there is a clear justification and the file already uses them.\n- Add succinct code comments that explain what is going on if code is not self-explanatory. You should not add comments like \"Assigns the value to the variable\", but a brief comment might be useful ahead of a complex code block that the user would otherwise have to spend time parsing out. Usage of these comments should be rare.\n- Try to use apply_patch for single file edits, but it is fine to explore other options to make the edit if it does not work well. Do not use apply_patch for changes that are auto-generated (i.e. generating package.json or running a lint or format command like gofmt) or when scripting is more efficient (such as search and replacing a string across a codebase).\n- You may be in a dirty git worktree.\n    * NEVER revert existing changes you did not make unless explicitly requested, since these changes were made by the user.\n    * If asked to make a commit or code edits and there are unrelated changes to your work or changes that you didn't make in those files, don't revert those changes.\n    * If the changes are in files you've touched recently, you should read carefully and understand how you can work with the changes rather than reverting them.\n    * If the changes are in unrelated files, just ignore them and don't revert them.\n- Do not amend a commit unless explicitly requested to do so.\n- While you are working, you might notice unexpected changes that you didn't make. If this happens, STOP IMMEDIATELY and ask the user how they would like to proceed.\n- **NEVER** use destructive commands like `git reset --hard` or `git checkout --` unless specifically requested or approved by the user.\n\n## Plan tool\n\nWhen using the planning tool:\n- Skip using the planning tool for straightforward tasks (roughly the easiest 25%).\n- Do not make single-step plans.\n- When you made a plan, update it after having performed one of the sub-tasks that you shared on the plan.\n\n## Codex CLI harness, sandboxing, and approvals\n\nThe Codex CLI harness supports several different configurations for sandboxing and escalation approvals that the user can choose from.\n\nFilesystem sandboxing defines which files can be read or written. The options for `sandbox_mode` are:\n- **read-only**: The sandbox only permits reading files.\n- **workspace-write**: The sandbox permits reading files, and editing files in `cwd` and `writable_roots`. Editing files in other directories requires approval.\n- **danger-full-access**: No filesystem sandboxing - all commands are permitted.\n\nNetwork sandboxing defines whether network can be accessed without approval. Options for `network_access` are:\n- **restricted**: Requires approval\n- **enabled**: No approval needed\n\nApprovals are your mechanism to get user consent to run shell commands without the sandbox. Possible configuration options for `approval_policy` are\n- **untrusted**: The harness will escalate most commands for user approval, apart from a limited allowlist of safe \"read\" commands.\n- **on-failure**: The harness will allow all commands to run in the sandbox (if enabled), and failures will be escalated to the user for approval to run again without the sandbox.\n- **on-request**: Commands will be run in the sandbox by default, and you can specify in your tool call if you want to escalate a command to run without sandboxing. (Note that this mode is not always available. If it is, you'll see parameters for it in the `shell` command description.)\n- **never**: This is a non-interactive mode where you may NEVER ask the user for approval to run commands. Instead, you must always persist and work around constraints to solve the task for the user. You MUST do your utmost best to finish the task and validate your work before yielding. If this mode is paired with `danger-full-access`, take advantage of it to deliver the best outcome for the user. Further, in this mode, your default testing philosophy is overridden: Even if you don't see local patterns for testing, you may add tests and scripts to validate your work. Just remove them before yielding.\n\nWhen you are running with `approval_policy == on-request`, and sandboxing enabled, here are scenarios where you'll need to request approval:\n- You need to run a command that writes to a directory that requires it (e.g. running tests that write to /var)\n- You need to run a GUI app (e.g., open/xdg-open/osascript) to open browsers or files.\n- You are running sandboxed and need to run a command that requires network access (e.g. installing packages)\n- If you run a command that is important to solving the user's query, but it fails because of sandboxing, rerun the command with approval. ALWAYS proceed to use the `with_escalated_permissions` and `justification` parameters - do not message the user before requesting approval for the command.\n- You are about to take a potentially destructive action such as an `rm` or `git reset` that the user did not explicitly ask for\n- (for all of these, you should weigh alternative paths that do not require approval)\n\nWhen `sandbox_mode` is set to read-only, you'll need to request approval for any command that isn't a read.\n\nYou will be told what filesystem sandboxing, network sandboxing, and approval mode are active in a developer or user message. If you are not told about this, assume that you are running with workspace-write, network sandboxing enabled, and approval on-failure.\n\nAlthough they introduce friction to the user because your work is paused until the user responds, you should leverage them when necessary to accomplish important work. If the completing the task requires escalated permissions, Do not let these settings or the sandbox deter you from attempting to accomplish the user's task unless it is set to \"never\", in which case never ask for approvals.\n\nWhen requesting approval to execute a command that will require escalated privileges:\n  - Provide the `with_escalated_permissions` parameter with the boolean value true\n  - Include a short, 1 sentence explanation for why you need to enable `with_escalated_permissions` in the justification parameter\n\n## Special user requests\n\n- If the user makes a simple request (such as asking for the time) which you can fulfill by running a terminal command (such as `date`), you should do so.\n- If the user asks for a \"review\", default to a code review mindset: prioritise identifying bugs, risks, behavioural regressions, and missing tests. Findings must be the primary focus of the response - keep summaries or overviews brief and only after enumerating the issues. Present findings first (ordered by severity with file/line references), follow with open questions or assumptions, and offer a change-summary only as a secondary detail. If no findings are discovered, state that explicitly and mention any residual risks or testing gaps.\n\n## Frontend tasks\nWhen doing frontend design tasks, avoid collapsing into \"AI slop\" or safe, average-looking layouts.\nAim for interfaces that feel intentional, bold, and a bit surprising.\n- Typography: Use expressive, purposeful fonts and avoid default stacks (Inter, Roboto, Arial, system).\n- Color & Look: Choose a clear visual direction; define CSS variables; avoid purple-on-white defaults. No purple bias or dark mode bias.\n- Motion: Use a few meaningful animations (page-load, staggered reveals) instead of generic micro-motions.\n- Background: Don't rely on flat, single-color backgrounds; use gradients, shapes, or subtle patterns to build atmosphere.\n- Overall: Avoid boilerplate layouts and interchangeable UI patterns. Vary themes, type families, and visual languages across outputs.\n- Ensure the page loads properly on both desktop and mobile\n\nException: If working within an existing website or design system, preserve the established patterns, structure, and visual language.\n\n## Presenting your work and final message\n\nYou are producing plain text that will later be styled by the CLI. Follow these rules exactly. Formatting should make results easy to scan, but not feel mechanical. Use judgment to decide how much structure adds value.\n\n- Default: be very concise; friendly coding teammate tone.\n- Ask only when needed; suggest ideas; mirror the user's style.\n- For substantial work, summarize clearly; follow final‑answer formatting.\n- Skip heavy formatting for simple confirmations.\n- Don't dump large files you've written; reference paths only.\n- No \"save/copy this file\" - User is on the same machine.\n- Offer logical next steps (tests, commits, build) briefly; add verify steps if you couldn't do something.\n- For code changes:\n  * Lead with a quick explanation of the change, and then give more details on the context covering where and why a change was made. Do not start this explanation with \"summary\", just jump right in.\n  * If there are natural next steps the user may want to take, suggest them at the end of your response. Do not make suggestions if there are no natural next steps.\n  * When suggesting multiple options, use numeric lists for the suggestions so the user can quickly respond with a single number.\n- The user does not command execution outputs. When asked to show the output of a command (e.g. `git show`), relay the important details in your answer or summarize the key lines so the user understands the result.\n\n### Final answer structure and style guidelines\n\n- Plain text; CLI handles styling. Use structure only when it helps scanability.\n- Headers: optional; short Title Case (1-3 words) wrapped in **…**; no blank line before the first bullet; add only if they truly help.\n- Bullets: use - ; merge related points; keep to one line when possible; 4–6 per list ordered by importance; keep phrasing consistent.\n- Monospace: backticks for commands/paths/env vars/code ids and inline examples; use for literal keyword bullets; never combine with **.\n- Code samples or multi-line snippets should be wrapped in fenced code blocks; include an info string as often as possible.\n- Structure: group related bullets; order sections general → specific → supporting; for subsections, start with a bolded keyword bullet, then items; match complexity to the task.\n- Tone: collaborative, concise, factual; present tense, active voice; self‑contained; no \"above/below\"; parallel wording.\n- Don'ts: no nested bullets/hierarchies; no ANSI codes; don't cram unrelated keywords; keep keyword lists short—wrap/reformat if long; avoid naming formatting styles in answers.\n- Adaptation: code explanations → precise, structured with code refs; simple tasks → lead with outcome; big changes → logical walkthrough + rationale + next actions; casual one-offs → plain sentences, no headers/bullets.\n- File References: When referencing files in your response follow the below rules:\n  * Use inline code to make file paths clickable.\n  * Each reference should have a stand alone path. Even if it's the same file.\n  * Accepted: absolute, workspace‑relative, a/ or b/ diff prefixes, or bare filename/suffix.\n  * Optionally include line/column (1‑based): :line[:column] or #Lline[Ccolumn] (column defaults to 1).\n  * Do not use URIs like file://, vscode://, or https://.\n  * Do not provide range of lines\n  * Examples: src/app.ts, src/app.ts:42, b/server/index.js#L10, C:\\repo\\project\\main.rs:12:5\n"

      logger.info('📝 Non-Codex CLI request detected, applying Codex CLI adaptation')
    } else {
      logger.info('✅ Codex CLI request detected, forwarding as-is')
    }

    const hasDedicatedBinding =
      typeof apiKeyData.openaiAccountId === 'string' &&
      apiKeyData.openaiAccountId.length > 0 &&
      !apiKeyData.openaiAccountId.startsWith('group:')
    const triedAccounts = new Set()
    let lastRateLimitResult = null
    let failoverCount = 0
    let authContext = await getOpenAIAuthToken(apiKeyData, sessionId, requestedModel)

    // 基于白名单构造上游所需的请求头，确保键为小写且值受控
    const incoming = req.headers || {}
    const isCompactRoute = isCompactEndpointRequest(req)
    if (isCompactRoute) {
      const normalizedCompact = normalizeCompactRequestBody(req.body)
      if (normalizedCompact.missing) {
        return res.status(400).json({
          error: {
            message: `Invalid compact request: missing required field(s): ${normalizedCompact.missing.join(', ')}`,
            type: 'invalid_request_error',
            code: 'invalid_request_error'
          }
        })
      }
      req.body = normalizedCompact.body
      if (incoming['x-openai-subagent'] === undefined) {
        incoming['x-openai-subagent'] = 'compact'
      }
    } else {
      req.body['store'] = false
    }
    const isStream = isCompactRoute ? false : req.body?.stream !== false

    const allowedKeys = [
      'version',
      'openai-version',
      'openai-beta',
      'session_id',
      'x-session-id',
      'x-codex-turn-state',
      'x-codex-turn-metadata',
      'x-codex-beta-features',
      'x-responsesapi-include-timing-metrics',
      'x-openai-subagent'
    ]

    const codexEndpoint = isCompactRoute
      ? 'https://chatgpt.com/backend-api/codex/responses/compact'
      : 'https://chatgpt.com/backend-api/codex/responses'

    for (;;) {
      ;({ accessToken, accountId, accountType, proxy, account } = authContext)
      const accountKey = `${accountType}:${accountId}`

      if (triedAccounts.has(accountKey) && lastRateLimitResult) {
        const errorResponse = createRateLimitErrorResponse(
          lastRateLimitResult.errorData,
          lastRateLimitResult.resetsInSeconds
        )
        sendRateLimitResponse(res, isStream, errorResponse)
        return
      }

      triedAccounts.add(accountKey)

      if (accountType === 'openai-responses') {
        logger.info(`🔀 Using OpenAI-Responses relay service for account: ${account.name}`)
        const relayResult = await openaiResponsesRelayService.handleRequest(
          req,
          res,
          account,
          apiKeyData,
          {
            captureRateLimitOnly: true
          }
        )

        if (relayResult?.rateLimited) {
          lastRateLimitResult = {
            resetsInSeconds: relayResult.resetsInSeconds,
            errorData: relayResult.errorData
          }
          failoverCount += 1

          if (hasDedicatedBinding || failoverCount >= MAX_429_FAILOVER_ATTEMPTS) {
            const errorResponse = createRateLimitErrorResponse(
              relayResult.errorData,
              relayResult.resetsInSeconds
            )
            sendRateLimitResponse(res, isStream, errorResponse)
            return
          }

          try {
            authContext = await getOpenAIAuthToken(apiKeyData, sessionId, requestedModel)
          } catch (selectionError) {
            logger.warn(
              '⚠️ Failed to select fallback OpenAI account after OpenAI-Responses 429:',
              selectionError.message
            )
            const errorResponse = createRateLimitErrorResponse(
              relayResult.errorData,
              relayResult.resetsInSeconds
            )
            sendRateLimitResponse(res, isStream, errorResponse)
            return
          }

          continue
        }

        return relayResult
      }

      const headers = {}
      for (const key of allowedKeys) {
        if (incoming[key] !== undefined) {
          headers[key] = incoming[key]
        }
      }
      if (isCompactRoute && headers['x-openai-subagent'] === undefined) {
        headers['x-openai-subagent'] = 'compact'
      }

      headers['authorization'] = `Bearer ${accessToken}`
      headers['chatgpt-account-id'] = account.accountId || account.chatgptUserId || accountId
      headers['host'] = 'chatgpt.com'
      headers['accept'] = isStream ? 'text/event-stream' : 'application/json'
      headers['content-type'] = 'application/json'

      const proxyAgent = createProxyAgent(proxy)
      const axiosConfig = {
        headers,
        timeout: config.requestTimeout || 600000,
        validateStatus: () => true
      }

      if (proxyAgent) {
        axiosConfig.httpAgent = proxyAgent
        axiosConfig.httpsAgent = proxyAgent
        axiosConfig.proxy = false
        logger.info(`🌐 Using proxy for OpenAI request: ${ProxyHelper.getProxyDescription(proxy)}`)
      } else {
        logger.debug('🌐 No proxy configured for OpenAI request')
      }

      if (isStream) {
        upstream = await axios.post(codexEndpoint, req.body, {
          ...axiosConfig,
          responseType: 'stream'
        })
      } else {
        upstream = await axios.post(codexEndpoint, req.body, axiosConfig)
      }

      const codexUsageSnapshot = extractCodexUsageHeaders(upstream.headers)
      if (codexUsageSnapshot) {
        try {
          await openaiAccountService.updateCodexUsageSnapshot(accountId, codexUsageSnapshot)
        } catch (codexError) {
          logger.error('⚠️ 更新 Codex 使用统计失败:', codexError)
        }
      }

      if (upstream.status !== 429) {
        break
      }

      logger.warn(`🚫 Rate limit detected for OpenAI account ${accountId} (Codex API)`)

      const { resetsInSeconds, errorData } = await parseRateLimitError(upstream, isStream)
      await unifiedOpenAIScheduler.markAccountRateLimited(
        accountId,
        'openai',
        sessionHash,
        resetsInSeconds
      )

      lastRateLimitResult = { resetsInSeconds, errorData }
      failoverCount += 1

      if (hasDedicatedBinding || failoverCount >= MAX_429_FAILOVER_ATTEMPTS) {
        const errorResponse = createRateLimitErrorResponse(errorData, resetsInSeconds)
        sendRateLimitResponse(res, isStream, errorResponse)
        return
      }

      try {
        authContext = await getOpenAIAuthToken(apiKeyData, sessionId, requestedModel)
      } catch (selectionError) {
        logger.warn(
          '⚠️ Failed to select fallback OpenAI account after 429:',
          selectionError.message
        )
        const errorResponse = createRateLimitErrorResponse(errorData, resetsInSeconds)
        sendRateLimitResponse(res, isStream, errorResponse)
        return
      }
    }

    if (upstream.status === 401 || upstream.status === 402) {
      const unauthorizedStatus = upstream.status
      const statusDescription = unauthorizedStatus === 401 ? 'Unauthorized' : 'Payment required'
      logger.warn(
        `🔐 ${statusDescription} error detected for OpenAI account ${accountId} (Codex API)`
      )

      let errorData = null

      try {
        if (isStream && upstream.data && typeof upstream.data.on === 'function') {
          const chunks = []
          await new Promise((resolve, reject) => {
            upstream.data.on('data', (chunk) => chunks.push(chunk))
            upstream.data.on('end', resolve)
            upstream.data.on('error', reject)
            setTimeout(resolve, 5000)
          })

          const fullResponse = Buffer.concat(chunks).toString()
          try {
            errorData = JSON.parse(fullResponse)
          } catch (parseError) {
            logger.error(`Failed to parse ${unauthorizedStatus} error response:`, parseError)
            logger.debug(`Raw ${unauthorizedStatus} response:`, fullResponse)
            errorData = { error: { message: fullResponse || 'Unauthorized' } }
          }
        } else {
          errorData = upstream.data
        }
      } catch (parseError) {
        logger.error(`⚠️ Failed to handle ${unauthorizedStatus} error response:`, parseError)
      }

      const statusLabel = unauthorizedStatus === 401 ? '401错误' : '402错误'
      const extraHint = unauthorizedStatus === 402 ? '，可能欠费' : ''
      let reason = `OpenAI账号认证失败（${statusLabel}${extraHint}）`
      if (errorData) {
        const messageCandidate =
          errorData.error &&
          typeof errorData.error.message === 'string' &&
          errorData.error.message.trim()
            ? errorData.error.message.trim()
            : typeof errorData.message === 'string' && errorData.message.trim()
              ? errorData.message.trim()
              : null
        if (messageCandidate) {
          reason = `OpenAI账号认证失败（${statusLabel}${extraHint}）：${messageCandidate}`
        }
      }

      try {
        await unifiedOpenAIScheduler.markAccountUnauthorized(
          accountId,
          'openai',
          sessionHash,
          reason
        )
      } catch (markError) {
        logger.error(
          `❌ Failed to mark OpenAI account unauthorized after ${unauthorizedStatus}:`,
          markError
        )
      }

      let errorResponse = errorData
      if (!errorResponse || typeof errorResponse !== 'object' || Buffer.isBuffer(errorResponse)) {
        const fallbackMessage =
          typeof errorData === 'string' && errorData.trim() ? errorData.trim() : 'Unauthorized'
        errorResponse = {
          error: {
            message: fallbackMessage,
            type: 'unauthorized',
            code: 'unauthorized'
          }
        }
      }

      res.status(unauthorizedStatus).json(errorResponse)
      return
    } else if (upstream.status === 200 || upstream.status === 201) {
      // 请求成功，检查并移除限流状态
      const isRateLimited = await unifiedOpenAIScheduler.isAccountRateLimited(accountId)
      if (isRateLimited) {
        logger.info(
          `✅ Removing rate limit for OpenAI account ${accountId} after successful request`
        )
        await unifiedOpenAIScheduler.removeAccountRateLimit(accountId, 'openai')
      }
    }

    res.status(upstream.status)

    if (isStream) {
      // 流式响应头
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')
    } else {
      // 非流式响应头
      res.setHeader('Content-Type', 'application/json')
    }

    // 透传关键诊断头与 Codex 相关头，避免传递不安全或与传输相关的头
    const passThroughHeaderKeys = new Set([
      'openai-version',
      'x-request-id',
      'openai-processing-ms',
      'retry-after',
      'x-models-etag',
      'x-reasoning-included'
    ])
    for (const [key, val] of Object.entries(upstream.headers || {})) {
      const lowerKey = key.toLowerCase()
      const shouldPass =
        passThroughHeaderKeys.has(lowerKey) ||
        lowerKey.startsWith('x-codex-') ||
        lowerKey.startsWith('x-responsesapi-') ||
        lowerKey.startsWith('x-ratelimit-')
      if (shouldPass && val !== undefined) {
        res.setHeader(lowerKey, val)
      }
    }

    if (isStream) {
      // 立即刷新响应头，开始 SSE
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders()
      }
    }

    // 处理响应并捕获 usage 数据和真实的 model
    let usageData = null
    let actualModel = null
    let usageReported = false
    let rateLimitDetected = false
    let rateLimitResetsInSeconds = null

    if (!isStream) {
      // 非流式响应处理
      try {
        logger.info(`📄 Processing OpenAI non-stream response for model: ${requestedModel}`)

        // 直接获取完整响应
        const responseData = upstream.data

        // 从响应中获取实际的 model 和 usage
        actualModel = responseData.model || requestedModel || 'gpt-4'
        usageData = responseData.usage

        logger.debug(`📊 Non-stream response - Model: ${actualModel}, Usage:`, usageData)

        // 记录使用统计
        if (usageData) {
          const totalInputTokens = usageData.input_tokens || usageData.prompt_tokens || 0
          const outputTokens = usageData.output_tokens || usageData.completion_tokens || 0
          const cacheReadTokens = usageData.input_tokens_details?.cached_tokens || 0
          // 计算实际输入token（总输入减去缓存部分）
          const actualInputTokens = Math.max(0, totalInputTokens - cacheReadTokens)

          await apiKeyService.recordUsage(
            apiKeyData.id,
            actualInputTokens, // 传递实际输入（不含缓存）
            outputTokens,
            0, // OpenAI没有cache_creation_tokens
            cacheReadTokens,
            actualModel,
            accountId,
            'openai'
          )

          logger.info(
            `📊 Recorded OpenAI non-stream usage - Input: ${totalInputTokens}(actual:${actualInputTokens}+cached:${cacheReadTokens}), Output: ${outputTokens}, Total: ${usageData.total_tokens || totalInputTokens + outputTokens}, Model: ${actualModel}`
          )

          await applyRateLimitTracking(
            req,
            {
              inputTokens: actualInputTokens,
              outputTokens,
              cacheCreateTokens: 0,
              cacheReadTokens
            },
            actualModel,
            'openai-non-stream',
            'openai'
          )
        }

        // 返回响应
        res.json(responseData)
        return
      } catch (error) {
        logger.error('Failed to process non-stream response:', error)
        if (!res.headersSent) {
          res.status(500).json({ error: { message: 'Failed to process response' } })
        }
        return
      }
    }

    // 使用增量 SSE 解析器
    const sseParser = new IncrementalSSEParser()

    // 处理解析出的事件
    const processSSEEvent = (eventData) => {
      // 检查 completion 事件（兼容 response.completed / response.done）
      if (
        (eventData.type === 'response.completed' || eventData.type === 'response.done') &&
        eventData.response
      ) {
        // 从响应中获取真实的 model
        if (eventData.response.model) {
          actualModel = eventData.response.model
          logger.debug(`📊 Captured actual model: ${actualModel}`)
        }

        // 获取 usage 数据
        if (eventData.response.usage) {
          usageData = eventData.response.usage
          logger.debug('📊 Captured OpenAI usage data:', usageData)
        }
      }

      const errorPayload = extractStreamErrorPayload(eventData)
      if (eventData.type === 'response.failed' && errorPayload) {
        logger.warn('⚠️ OpenAI stream received response.failed', {
          errorType: errorPayload.type,
          errorCode: errorPayload.code
        })
      }

      // 检查是否有限流错误（兼容 response.failed / error 事件）
      if (isRateLimitErrorPayload(errorPayload)) {
        rateLimitDetected = true
        if (rateLimitResetsInSeconds === null) {
          rateLimitResetsInSeconds =
            upstreamErrorHelper.parseRateLimitDelayFromError({ error: errorPayload }) ||
            upstreamErrorHelper.parseRateLimitDelayFromError(errorPayload)
        }
        if (rateLimitResetsInSeconds !== null) {
          logger.warn(
            `🚫 Rate limit detected in stream, resets in ${rateLimitResetsInSeconds} seconds`
          )
        } else {
          logger.warn('🚫 Rate limit detected in stream (reset time unknown)')
        }
      }
    }

    upstream.data.on('data', (chunk) => {
      try {
        // 转发数据给客户端
        if (!res.destroyed) {
          res.write(chunk)
        }

        // 使用增量解析器处理数据
        const events = sseParser.feed(chunk.toString())
        for (const event of events) {
          if (event.type === 'data' && event.data) {
            processSSEEvent(event.data)
          }
        }
      } catch (error) {
        logger.error('Error processing OpenAI stream chunk:', error)
      }
    })

    upstream.data.on('end', async () => {
      // 处理剩余的 buffer
      const remaining = sseParser.getRemaining()
      if (remaining.trim()) {
        const events = sseParser.feed('\n\n') // 强制刷新剩余内容
        for (const event of events) {
          if (event.type === 'data' && event.data) {
            processSSEEvent(event.data)
          }
        }
      }

      // 记录使用统计
      if (!usageReported && usageData) {
        try {
          const totalInputTokens = usageData.input_tokens || 0
          const outputTokens = usageData.output_tokens || 0
          const cacheReadTokens = usageData.input_tokens_details?.cached_tokens || 0
          // 计算实际输入token（总输入减去缓存部分）
          const actualInputTokens = Math.max(0, totalInputTokens - cacheReadTokens)

          // 使用响应中的真实 model，如果没有则使用请求中的 model，最后回退到默认值
          const modelToRecord = actualModel || requestedModel || 'gpt-4'

          await apiKeyService.recordUsage(
            apiKeyData.id,
            actualInputTokens, // 传递实际输入（不含缓存）
            outputTokens,
            0, // OpenAI没有cache_creation_tokens
            cacheReadTokens,
            modelToRecord,
            accountId,
            'openai'
          )

          logger.info(
            `📊 Recorded OpenAI usage - Input: ${totalInputTokens}(actual:${actualInputTokens}+cached:${cacheReadTokens}), Output: ${outputTokens}, Total: ${usageData.total_tokens || totalInputTokens + outputTokens}, Model: ${modelToRecord} (actual: ${actualModel}, requested: ${requestedModel})`
          )
          usageReported = true

          await applyRateLimitTracking(
            req,
            {
              inputTokens: actualInputTokens,
              outputTokens,
              cacheCreateTokens: 0,
              cacheReadTokens
            },
            modelToRecord,
            'openai-stream',
            'openai'
          )
        } catch (error) {
          logger.error('Failed to record OpenAI usage:', error)
        }
      }

      // 如果在流式响应中检测到限流
      if (rateLimitDetected) {
        const inferredReset =
          rateLimitResetsInSeconds || upstreamErrorHelper.parseRetryAfter(upstream.headers)
        logger.warn(`🚫 Processing rate limit for OpenAI account ${accountId} from stream`)
        await unifiedOpenAIScheduler.markAccountRateLimited(
          accountId,
          'openai',
          sessionHash,
          inferredReset
        )
      } else if (upstream.status === 200) {
        // 流式请求成功，检查并移除限流状态
        const isRateLimited = await unifiedOpenAIScheduler.isAccountRateLimited(accountId)
        if (isRateLimited) {
          logger.info(
            `✅ Removing rate limit for OpenAI account ${accountId} after successful stream`
          )
          await unifiedOpenAIScheduler.removeAccountRateLimit(accountId, 'openai')
        }
      }

      res.end()
    })

    upstream.data.on('error', (err) => {
      logger.error('Upstream stream error:', err)
      if (!res.headersSent) {
        res.status(502).json({ error: { message: 'Upstream stream error' } })
      } else {
        res.end()
      }
    })

    // 客户端断开时清理上游流
    const cleanup = () => {
      try {
        upstream.data?.unpipe?.(res)
        upstream.data?.destroy?.()
      } catch (_) {
        //
      }
    }
    req.on('close', cleanup)
    req.on('aborted', cleanup)
  } catch (error) {
    logger.error('Proxy to ChatGPT codex/responses failed:', error)
    // 优先使用主动设置的 statusCode，然后是上游响应的状态码，最后默认 500
    const status = error.statusCode || error.response?.status || 500

    if ((status === 401 || status === 402) && accountId) {
      const statusLabel = status === 401 ? '401错误' : '402错误'
      const extraHint = status === 402 ? '，可能欠费' : ''
      let reason = `OpenAI账号认证失败（${statusLabel}${extraHint}）`
      const errorData = error.response?.data
      if (errorData) {
        if (typeof errorData === 'string' && errorData.trim()) {
          reason = `OpenAI账号认证失败（${statusLabel}${extraHint}）：${errorData.trim()}`
        } else if (
          errorData.error &&
          typeof errorData.error.message === 'string' &&
          errorData.error.message.trim()
        ) {
          reason = `OpenAI账号认证失败（${statusLabel}${extraHint}）：${errorData.error.message.trim()}`
        } else if (typeof errorData.message === 'string' && errorData.message.trim()) {
          reason = `OpenAI账号认证失败（${statusLabel}${extraHint}）：${errorData.message.trim()}`
        }
      } else if (error.message) {
        reason = `OpenAI账号认证失败（${statusLabel}${extraHint}）：${error.message}`
      }

      try {
        await unifiedOpenAIScheduler.markAccountUnauthorized(
          accountId,
          accountType || 'openai',
          sessionHash,
          reason
        )
      } catch (markError) {
        logger.error('❌ Failed to mark OpenAI account unauthorized in catch handler:', markError)
      }
    }

    let responsePayload = error.response?.data
    if (!responsePayload) {
      responsePayload = { error: { message: getSafeMessage(error) } }
    } else if (typeof responsePayload === 'string') {
      responsePayload = { error: { message: getSafeMessage(responsePayload) } }
    } else if (typeof responsePayload === 'object' && !responsePayload.error) {
      responsePayload = {
        error: { message: getSafeMessage(responsePayload.message || error) }
      }
    } else if (responsePayload.error?.message) {
      responsePayload.error.message = getSafeMessage(responsePayload.error.message)
    }

    if (!res.headersSent) {
      res.status(status).json(responsePayload)
    }
  }
}

// 注册两个路由路径，都使用相同的处理函数
router.get('/models', authenticateApiKey, handleCodexModels)
router.get('/v1/models', authenticateApiKey, handleCodexModels)
router.post('/responses', authenticateApiKey, handleResponses)
router.post('/v1/responses', authenticateApiKey, handleResponses)
router.post('/responses/compact', authenticateApiKey, handleResponses)
router.post('/v1/responses/compact', authenticateApiKey, handleResponses)

// 使用情况统计端点
router.get('/usage', authenticateApiKey, async (req, res) => {
  try {
    const keyData = req.apiKey
    // 按需查询 usage 数据
    const usage = await redis.getUsageStats(keyData.id)

    res.json({
      object: 'usage',
      total_tokens: usage?.total?.tokens || 0,
      total_requests: usage?.total?.requests || 0,
      daily_tokens: usage?.daily?.tokens || 0,
      daily_requests: usage?.daily?.requests || 0,
      monthly_tokens: usage?.monthly?.tokens || 0,
      monthly_requests: usage?.monthly?.requests || 0
    })
  } catch (error) {
    logger.error('Failed to get usage stats:', error)
    res.status(500).json({
      error: {
        message: 'Failed to retrieve usage statistics',
        type: 'api_error'
      }
    })
  }
})

// API Key 信息端点
router.get('/key-info', authenticateApiKey, async (req, res) => {
  try {
    const keyData = req.apiKey
    // 按需查询 usage 数据（仅 key-info 端点需要）
    const usage = await redis.getUsageStats(keyData.id)
    const tokensUsed = usage?.total?.tokens || 0
    res.json({
      id: keyData.id,
      name: keyData.name,
      description: keyData.description,
      permissions: keyData.permissions,
      token_limit: keyData.tokenLimit,
      tokens_used: tokensUsed,
      tokens_remaining:
        keyData.tokenLimit > 0 ? Math.max(0, keyData.tokenLimit - tokensUsed) : null,
      rate_limit: {
        window: keyData.rateLimitWindow,
        requests: keyData.rateLimitRequests
      },
      usage: {
        total: usage?.total || {},
        daily: usage?.daily || {},
        monthly: usage?.monthly || {}
      }
    })
  } catch (error) {
    logger.error('Failed to get key info:', error)
    res.status(500).json({
      error: {
        message: 'Failed to retrieve API key information',
        type: 'api_error'
      }
    })
  }
})

module.exports = router
module.exports.handleResponses = handleResponses
module.exports.__testables = {
  handleCodexModels,
  buildModelsCatalogUnavailablePayload
}
