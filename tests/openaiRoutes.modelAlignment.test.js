const mockHasPermission = jest.fn()
const mockRecordUsage = jest.fn()
const mockSelectAccountForApiKey = jest.fn()
const mockIsAccountRateLimited = jest.fn()
const mockRemoveAccountRateLimit = jest.fn()
const mockMarkAccountRateLimited = jest.fn()
const mockMarkAccountUnauthorized = jest.fn()
const mockGetOpenAIAccount = jest.fn()
const mockDecryptOpenAIAccount = jest.fn()
const mockIsOpenAITokenExpired = jest.fn()
const mockRefreshOpenAIAccountToken = jest.fn()
const mockUpdateCodexUsageSnapshot = jest.fn()
const mockGetOpenAIResponsesAccount = jest.fn()
const mockRelayHandleRequest = jest.fn()
const mockAxiosGet = jest.fn()
const mockAxiosPost = jest.fn()
const mockRedisGet = jest.fn()
const mockRedisSetex = jest.fn()

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  api: jest.fn(),
  security: jest.fn()
}))

jest.mock('../src/middleware/auth', () => ({
  authenticateApiKey: (req, _res, next) => next()
}))

jest.mock('../src/services/apiKeyService', () => ({
  hasPermission: (...args) => mockHasPermission(...args),
  recordUsage: (...args) => mockRecordUsage(...args)
}))

jest.mock('../src/services/unifiedOpenAIScheduler', () => ({
  selectAccountForApiKey: (...args) => mockSelectAccountForApiKey(...args),
  isAccountRateLimited: (...args) => mockIsAccountRateLimited(...args),
  removeAccountRateLimit: (...args) => mockRemoveAccountRateLimit(...args),
  markAccountRateLimited: (...args) => mockMarkAccountRateLimited(...args),
  markAccountUnauthorized: (...args) => mockMarkAccountUnauthorized(...args)
}))

jest.mock('../src/services/openaiAccountService', () => ({
  getAccount: (...args) => mockGetOpenAIAccount(...args),
  decrypt: (...args) => mockDecryptOpenAIAccount(...args),
  isTokenExpired: (...args) => mockIsOpenAITokenExpired(...args),
  refreshAccountToken: (...args) => mockRefreshOpenAIAccountToken(...args),
  updateCodexUsageSnapshot: (...args) => mockUpdateCodexUsageSnapshot(...args)
}))

jest.mock('../src/services/openaiResponsesAccountService', () => ({
  getAccount: (...args) => mockGetOpenAIResponsesAccount(...args)
}))

jest.mock('../src/services/openaiResponsesRelayService', () => ({
  handleRequest: (...args) => mockRelayHandleRequest(...args)
}))

jest.mock('../src/models/redis', () => ({
  getClientSafe: () => ({
    get: (...args) => mockRedisGet(...args),
    setex: (...args) => mockRedisSetex(...args)
  })
}))

jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: () => null,
  getProxyDescription: () => 'none'
}))

jest.mock('../src/utils/rateLimitHelper', () => ({
  updateRateLimitCounters: jest.fn().mockResolvedValue({
    totalTokens: 0,
    totalCost: 0
  })
}))

jest.mock('../src/utils/upstreamErrorHelper', () => ({
  isTempUnavailable: jest.fn().mockResolvedValue(false),
  parseRetryAfter: jest.fn().mockReturnValue(null),
  parseRateLimitDelayFromError: jest.fn().mockReturnValue(null)
}))

jest.mock('axios', () => ({
  get: (...args) => mockAxiosGet(...args),
  post: (...args) => mockAxiosPost(...args)
}))

const { handleResponses, __testables } = require('../src/routes/openaiRoutes')
const { handleCodexModels } = __testables

function createMockRes() {
  const res = {
    statusCode: 200,
    payload: null,
    headers: {},
    headersSent: false,
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.payload = body
      this.headersSent = true
      return this
    },
    setHeader(key, value) {
      this.headers[key] = value
      return this
    },
    end() {
      this.headersSent = true
      return this
    }
  }
  return res
}

function buildApiKey() {
  return {
    id: 'key-1',
    name: 'test-key',
    permissions: ['openai']
  }
}

describe('openaiRoutes /model protocol alignment', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockHasPermission.mockReturnValue(true)
    mockIsAccountRateLimited.mockResolvedValue(false)
    mockRemoveAccountRateLimit.mockResolvedValue(undefined)
    mockMarkAccountRateLimited.mockResolvedValue(undefined)
    mockMarkAccountUnauthorized.mockResolvedValue(undefined)
    mockIsOpenAITokenExpired.mockReturnValue(false)
    mockRecordUsage.mockResolvedValue(undefined)
    mockRedisGet.mockResolvedValue(null)
    mockRedisSetex.mockResolvedValue('OK')
  })

  it('forwards /responses model as-is without gpt-5-* normalization', async () => {
    mockSelectAccountForApiKey.mockResolvedValue({
      accountId: 'responses-1',
      accountType: 'openai-responses'
    })
    mockGetOpenAIResponsesAccount.mockResolvedValue({
      id: 'responses-1',
      name: 'responses-account',
      apiKey: 'resp-key'
    })
    mockRelayHandleRequest.mockResolvedValue({ ok: true })

    const req = {
      headers: {
        'user-agent': 'codex_cli_rs/0.0.1'
      },
      body: {
        model: 'gpt-5-2025-08-07',
        input: [{ type: 'input_text', text: 'ping' }],
        stream: false
      },
      apiKey: buildApiKey(),
      path: '/v1/responses',
      originalUrl: '/v1/responses',
      on: jest.fn()
    }
    const res = createMockRes()

    await handleResponses(req, res)

    expect(mockRelayHandleRequest).toHaveBeenCalledTimes(1)
    const forwardedReq = mockRelayHandleRequest.mock.calls[0][0]
    expect(forwardedReq.body.model).toBe('gpt-5-2025-08-07')
  })

  it('forwards /v1/memories/trace_summarize to openai-responses relay without responses-only mutation', async () => {
    mockSelectAccountForApiKey.mockResolvedValue({
      accountId: 'responses-1',
      accountType: 'openai-responses'
    })
    mockGetOpenAIResponsesAccount.mockResolvedValue({
      id: 'responses-1',
      name: 'responses-account',
      apiKey: 'resp-key'
    })
    mockRelayHandleRequest.mockResolvedValue({ ok: true })

    const req = {
      headers: {
        'user-agent': 'codex_cli_rs/0.0.1',
        originator: 'codex_cli_rs',
        session_id: '123456789012345678901'
      },
      body: {
        model: 'gpt-5-codex',
        traces: [
          {
            id: 'trace-1',
            metadata: { source_path: '/tmp/trace.json' },
            items: [{ type: 'message', role: 'user', content: [] }]
          }
        ]
      },
      apiKey: buildApiKey(),
      path: '/v1/memories/trace_summarize',
      originalUrl: '/v1/memories/trace_summarize',
      on: jest.fn()
    }
    const res = createMockRes()

    await handleResponses(req, res)

    expect(mockRelayHandleRequest).toHaveBeenCalledTimes(1)
    const forwardedReq = mockRelayHandleRequest.mock.calls[0][0]
    expect(forwardedReq.body).toMatchObject({
      model: 'gpt-5-codex'
    })
    expect(forwardedReq.body.store).toBeUndefined()
    expect(forwardedReq.body.instructions).toBeUndefined()
  })

  it('routes /v1/memories/trace_summarize to codex memories endpoint for openai accounts', async () => {
    mockSelectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    mockGetOpenAIAccount.mockResolvedValue({
      id: 'openai-1',
      accountId: 'chatgpt-user-1',
      name: 'openai-account',
      accessToken: 'encrypted-token'
    })
    mockDecryptOpenAIAccount.mockReturnValue('decrypted-token')
    mockAxiosPost.mockResolvedValue({
      status: 200,
      data: {
        output: []
      },
      headers: {}
    })

    const req = {
      headers: {
        'user-agent': 'codex_cli_rs/0.0.1',
        originator: 'codex_cli_rs',
        session_id: '123456789012345678901',
        'x-openai-internal-codex-residency': 'us'
      },
      body: {
        model: 'gpt-5-codex',
        traces: [
          {
            id: 'trace-1',
            metadata: { source_path: '/tmp/trace.json' },
            items: [{ type: 'message', role: 'user', content: [] }]
          }
        ]
      },
      apiKey: buildApiKey(),
      path: '/v1/memories/trace_summarize',
      originalUrl: '/v1/memories/trace_summarize',
      on: jest.fn()
    }
    const res = createMockRes()

    await handleResponses(req, res)

    expect(mockAxiosPost).toHaveBeenCalledTimes(1)
    expect(mockAxiosPost.mock.calls[0][0]).toBe(
      'https://chatgpt.com/backend-api/codex/memories/trace_summarize'
    )
    expect(mockAxiosPost.mock.calls[0][2].headers).toMatchObject({
      originator: 'codex_cli_rs',
      session_id: '123456789012345678901',
      'x-openai-internal-codex-residency': 'us'
    })
  })

  it('loads authoritative /models from openai-responses account baseApi', async () => {
    mockSelectAccountForApiKey.mockResolvedValue({
      accountId: 'responses-1',
      accountType: 'openai-responses'
    })
    mockGetOpenAIResponsesAccount.mockResolvedValue({
      id: 'responses-1',
      name: 'responses-account',
      apiKey: 'resp-key',
      baseApi: 'https://api.openai.com/v1'
    })
    mockAxiosGet.mockResolvedValue({
      status: 200,
      data: {
        data: [
          { id: 'gpt-5-codex' },
          { id: 'gpt-5-codex-mini' }
        ]
      },
      headers: {}
    })

    const req = {
      headers: {
        originator: 'codex_cli_rs',
        'x-openai-internal-codex-residency': 'us'
      },
      query: {
        client_version: '0.99.0'
      },
      body: {},
      apiKey: buildApiKey()
    }
    const res = createMockRes()

    await handleCodexModels(req, res)

    expect(res.statusCode).toBe(200)
    expect(res.payload.models.map((item) => item.slug)).toEqual(['gpt-5-codex', 'gpt-5-codex-mini'])
    expect(mockAxiosGet).toHaveBeenCalledTimes(1)
    expect(mockRedisGet).not.toHaveBeenCalled()
    expect(mockRedisSetex).not.toHaveBeenCalled()
    expect(mockAxiosGet.mock.calls[0][0]).toBe(
      'https://api.openai.com/v1/models?client_version=0.99.0'
    )
    expect(mockAxiosGet.mock.calls[0][1].headers).toMatchObject({
      authorization: 'Bearer resp-key',
      originator: 'codex_cli_rs',
      'x-openai-internal-codex-residency': 'us'
    })
  })

  it('keeps ETag semantics for authoritative /models payloads', async () => {
    const upstreamPayload = {
      models: [
        {
          slug: 'gpt-5-codex',
          display_name: 'gpt-5-codex',
          description: 'Official codex model',
          default_reasoning_level: 'medium',
          supported_reasoning_levels: [{ effort: 'medium', description: 'balanced reasoning' }],
          shell_type: 'shell_command',
          visibility: 'list',
          supported_in_api: true,
          priority: 1,
          base_instructions: 'You are Codex, based on GPT-5.',
          supports_reasoning_summaries: false,
          support_verbosity: false,
          default_verbosity: null,
          apply_patch_tool_type: null,
          truncation_policy: { mode: 'tokens', limit: 272000 },
          supports_parallel_tool_calls: false,
          context_window: 272000,
          auto_compact_token_limit: null,
          effective_context_window_percent: 95,
          experimental_supported_tools: [],
          input_modalities: ['text', 'image'],
          prefer_websockets: false
        }
      ]
    }

    mockSelectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    mockGetOpenAIAccount.mockResolvedValue({
      id: 'openai-1',
      accountId: 'chatgpt-user-1',
      name: 'openai-account',
      accessToken: 'encrypted-token'
    })
    mockDecryptOpenAIAccount.mockReturnValue('decrypted-token')
    mockAxiosGet.mockResolvedValue({
      status: 200,
      data: upstreamPayload,
      headers: {}
    })

    const firstReq = {
      headers: {},
      query: {},
      body: {},
      apiKey: buildApiKey()
    }
    const firstRes = createMockRes()
    await handleCodexModels(firstReq, firstRes)

    const etag = firstRes.headers.ETag
    expect(firstRes.statusCode).toBe(200)
    expect(firstRes.payload.models[0].slug).toBe('gpt-5-codex')
    expect(typeof etag).toBe('string')

    const secondReq = {
      headers: {
        'if-none-match': etag
      },
      query: {},
      body: {},
      apiKey: buildApiKey()
    }
    const secondRes = createMockRes()
    await handleCodexModels(secondReq, secondRes)

    expect(secondRes.statusCode).toBe(304)
    expect(secondRes.payload).toBeNull()
  })
})
