const { v4: uuidv4 } = require('uuid')
const crypto = require('crypto')
const axios = require('axios')
const redis = require('../models/redis')
const logger = require('../utils/logger')
const config = require('../../config/config')
const LRUCache = require('../utils/lruCache')
const ProxyHelper = require('../utils/proxyHelper')

class OpenAIResponsesAccountService {
  constructor() {
    // 加密相关常量
    this.ENCRYPTION_ALGORITHM = 'aes-256-cbc'
    this.ENCRYPTION_SALT = 'openai-responses-salt'

    // Redis 键前缀
    this.ACCOUNT_KEY_PREFIX = 'openai_responses_account:'
    this.SHARED_ACCOUNTS_KEY = 'shared_openai_responses_accounts'
    this.MODELS_CACHE_KEY_PREFIX = 'openai_responses_models_cache:'

    // 🚀 性能优化：缓存派生的加密密钥，避免每次重复计算
    this._encryptionKeyCache = null

    // 🔄 解密结果缓存，提高解密性能
    this._decryptCache = new LRUCache(500)
    this._modelsRequestTimeout = 30000

    // 🧹 定期清理缓存（每10分钟）
    setInterval(
      () => {
        this._decryptCache.cleanup()
        logger.info(
          '🧹 OpenAI-Responses decrypt cache cleanup completed',
          this._decryptCache.getStats()
        )
      },
      10 * 60 * 1000
    )
  }

  // 创建账户
  async createAccount(options = {}) {
    const {
      name = 'OpenAI Responses Account',
      description = '',
      baseApi = '', // 必填：API 基础地址
      apiKey = '', // 必填：API 密钥
      userAgent = '', // 可选：自定义 User-Agent，空则透传原始请求
      priority = 50, // 调度优先级 (1-100)
      proxy = null,
      isActive = true,
      accountType = 'shared', // 'dedicated' or 'shared'
      schedulable = true, // 是否可被调度
      dailyQuota = 0, // 每日额度限制（美元），0表示不限制
      quotaResetTime = '00:00', // 额度重置时间（HH:mm格式）
      rateLimitDuration = 60 // 限流时间（分钟）
    } = options

    // 验证必填字段
    if (!baseApi || !apiKey) {
      throw new Error('Base API URL and API Key are required for OpenAI-Responses account')
    }

    // 规范化 baseApi（确保不以 / 结尾）
    const normalizedBaseApi = baseApi.endsWith('/') ? baseApi.slice(0, -1) : baseApi

    const accountId = uuidv4()

    const accountData = {
      id: accountId,
      platform: 'openai-responses',
      name,
      description,
      baseApi: normalizedBaseApi,
      apiKey: this._encryptSensitiveData(apiKey),
      userAgent,
      priority: priority.toString(),
      proxy: proxy ? JSON.stringify(proxy) : '',
      isActive: isActive.toString(),
      accountType,
      schedulable: schedulable.toString(),

      // ✅ 新增：账户订阅到期时间（业务字段，手动管理）
      // 注意：OpenAI-Responses 使用 API Key 认证，没有 OAuth token，因此没有 expiresAt
      subscriptionExpiresAt: options.subscriptionExpiresAt || null,

      createdAt: new Date().toISOString(),
      lastUsedAt: '',
      status: 'active',
      errorMessage: '',
      // 限流相关
      rateLimitedAt: '',
      rateLimitStatus: '',
      rateLimitDuration: rateLimitDuration.toString(),
      // 额度管理
      dailyQuota: dailyQuota.toString(),
      dailyUsage: '0',
      lastResetDate: redis.getDateStringInTimezone(),
      quotaResetTime,
      quotaStoppedAt: ''
    }

    // 保存到 Redis
    await this._saveAccount(accountId, accountData)

    logger.success(`Created OpenAI-Responses account: ${name} (${accountId})`)

    return {
      ...accountData,
      apiKey: '***' // 返回时隐藏敏感信息
    }
  }

  // 获取账户
  async getAccount(accountId) {
    const client = redis.getClientSafe()
    const key = `${this.ACCOUNT_KEY_PREFIX}${accountId}`
    const accountData = await client.hgetall(key)

    if (!accountData || !accountData.id) {
      return null
    }

    // 解密敏感数据
    accountData.apiKey = this._decryptSensitiveData(accountData.apiKey)

    // 解析 JSON 字段
    if (accountData.proxy) {
      try {
        accountData.proxy = JSON.parse(accountData.proxy)
      } catch (e) {
        accountData.proxy = null
      }
    }

    return accountData
  }

  // 更新账户
  async updateAccount(accountId, updates) {
    const account = await this.getAccount(accountId)
    if (!account) {
      throw new Error('Account not found')
    }

    // 处理敏感字段加密
    if (updates.apiKey) {
      updates.apiKey = this._encryptSensitiveData(updates.apiKey)
    }

    // 处理 JSON 字段
    if (updates.proxy !== undefined) {
      updates.proxy = updates.proxy ? JSON.stringify(updates.proxy) : ''
    }

    // 规范化 baseApi
    if (updates.baseApi) {
      updates.baseApi = updates.baseApi.endsWith('/')
        ? updates.baseApi.slice(0, -1)
        : updates.baseApi
    }

    // ✅ 直接保存 subscriptionExpiresAt（如果提供）
    // OpenAI-Responses 使用 API Key，没有 token 刷新逻辑，不会覆盖此字段
    if (updates.subscriptionExpiresAt !== undefined) {
      // 直接保存，不做任何调整
    }

    // 更新 Redis
    const client = redis.getClientSafe()
    const key = `${this.ACCOUNT_KEY_PREFIX}${accountId}`
    await client.hset(key, updates)

    logger.info(`📝 Updated OpenAI-Responses account: ${account.name}`)

    return { success: true }
  }

  // 删除账户
  async deleteAccount(accountId) {
    const client = redis.getClientSafe()
    const key = `${this.ACCOUNT_KEY_PREFIX}${accountId}`

    // 从共享账户列表中移除
    await client.srem(this.SHARED_ACCOUNTS_KEY, accountId)

    // 从索引中移除
    await redis.removeFromIndex('openai_responses_account:index', accountId)

    // 删除账户数据
    await client.del(key)

    logger.info(`🗑️ Deleted OpenAI-Responses account: ${accountId}`)

    return { success: true }
  }

  // 获取所有账户
  async getAllAccounts(includeInactive = false) {
    const client = redis.getClientSafe()

    // 使用索引获取所有账户ID
    const accountIds = await redis.getAllIdsByIndex(
      'openai_responses_account:index',
      `${this.ACCOUNT_KEY_PREFIX}*`,
      /^openai_responses_account:(.+)$/
    )
    if (accountIds.length === 0) {
      return []
    }

    const keys = accountIds.map((id) => `${this.ACCOUNT_KEY_PREFIX}${id}`)
    // Pipeline 批量查询所有账户数据
    const pipeline = client.pipeline()
    keys.forEach((key) => pipeline.hgetall(key))
    const results = await pipeline.exec()

    const accounts = []
    results.forEach(([err, accountData]) => {
      if (err || !accountData || !accountData.id) {
        return
      }

      // 过滤非活跃账户
      if (!includeInactive && accountData.isActive !== 'true') {
        return
      }

      // 隐藏敏感信息
      accountData.apiKey = '***'

      // 解析 JSON 字段
      if (accountData.proxy) {
        try {
          accountData.proxy = JSON.parse(accountData.proxy)
        } catch {
          accountData.proxy = null
        }
      }

      // 获取限流状态信息
      const rateLimitInfo = this._getRateLimitInfo(accountData)
      accountData.rateLimitStatus = rateLimitInfo.isRateLimited
        ? {
            isRateLimited: true,
            rateLimitedAt: accountData.rateLimitedAt || null,
            minutesRemaining: rateLimitInfo.remainingMinutes || 0
          }
        : {
            isRateLimited: false,
            rateLimitedAt: null,
            minutesRemaining: 0
          }

      // 转换字段类型
      accountData.schedulable = accountData.schedulable !== 'false'
      accountData.isActive = accountData.isActive === 'true'
      accountData.expiresAt = accountData.subscriptionExpiresAt || null
      accountData.platform = accountData.platform || 'openai-responses'

      accounts.push(accountData)
    })

    return accounts
  }

  // 🔗 拉取账户可用模型（带缓存）
  async fetchAvailableModels(accountId, options = {}) {
    const { forceRefresh = false, ttlSeconds = 600 } = options
    const cacheTtlSeconds = Number.isFinite(Number(ttlSeconds))
      ? Math.max(1, Math.floor(Number(ttlSeconds)))
      : 600

    try {
      if (!forceRefresh) {
        const cachedModels = await this._getCachedModels(accountId)
        if (Array.isArray(cachedModels) && cachedModels.length > 0) {
          return cachedModels
        }
      }

      const account = await this.getAccount(accountId)
      if (!account) {
        throw new Error('Account not found')
      }

      const modelsUrl = this._buildModelsUrl(account.baseApi)
      const requestOptions = {
        method: 'GET',
        url: modelsUrl,
        timeout: this._modelsRequestTimeout,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${account.apiKey}`
        },
        validateStatus: () => true
      }

      if (account.proxy) {
        const proxyAgent = ProxyHelper.createProxyAgent(account.proxy)
        if (proxyAgent) {
          requestOptions.httpAgent = proxyAgent
          requestOptions.httpsAgent = proxyAgent
          requestOptions.proxy = false
        }
      }

      const response = await axios(requestOptions)
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Models endpoint responded with status ${response.status}`)
      }

      const models = this._normalizeModelsResponse(response.data)
      if (models.length === 0) {
        throw new Error('No model ids found in upstream response')
      }

      await this._setCachedModels(accountId, models, cacheTtlSeconds)
      return models
    } catch (error) {
      logger.warn(
        `⚠️ Failed to fetch OpenAI-Responses models for account ${accountId}:`,
        error.message
      )

      const cachedModels = await this._getCachedModels(accountId)
      if (Array.isArray(cachedModels) && cachedModels.length > 0) {
        logger.info(`📦 Using cached OpenAI-Responses models for account ${accountId}`)
        return cachedModels
      }

      throw error
    }
  }

  // 标记账户限流
  async markAccountRateLimited(accountId, duration = null) {
    const account = await this.getAccount(accountId)
    if (!account) {
      return
    }

    const rateLimitDuration = duration || parseInt(account.rateLimitDuration) || 60
    const now = new Date()
    const resetAt = new Date(now.getTime() + rateLimitDuration * 60000)

    await this.updateAccount(accountId, {
      rateLimitedAt: now.toISOString(),
      rateLimitStatus: 'limited',
      rateLimitResetAt: resetAt.toISOString(),
      rateLimitDuration: rateLimitDuration.toString(),
      status: 'rateLimited',
      schedulable: 'false', // 防止被调度
      errorMessage: `Rate limited until ${resetAt.toISOString()}`
    })

    logger.warn(
      `⏳ Account ${account.name} marked as rate limited for ${rateLimitDuration} minutes (until ${resetAt.toISOString()})`
    )
  }

  // 🚫 标记账户为未授权状态（401错误）
  async markAccountUnauthorized(accountId, reason = 'OpenAI Responses账号认证失败（401错误）') {
    const account = await this.getAccount(accountId)
    if (!account) {
      return
    }

    const now = new Date().toISOString()
    const currentCount = parseInt(account.unauthorizedCount || '0', 10)
    const unauthorizedCount = Number.isFinite(currentCount) ? currentCount + 1 : 1

    await this.updateAccount(accountId, {
      status: 'unauthorized',
      schedulable: 'false',
      errorMessage: reason,
      unauthorizedAt: now,
      unauthorizedCount: unauthorizedCount.toString()
    })

    logger.warn(
      `🚫 OpenAI-Responses account ${account.name || accountId} marked as unauthorized due to 401 error`
    )

    try {
      const webhookNotifier = require('../utils/webhookNotifier')
      await webhookNotifier.sendAccountAnomalyNotification({
        accountId,
        accountName: account.name || accountId,
        platform: 'openai',
        status: 'unauthorized',
        errorCode: 'OPENAI_UNAUTHORIZED',
        reason,
        timestamp: now
      })
      logger.info(
        `📢 Webhook notification sent for OpenAI-Responses account ${account.name || accountId} unauthorized state`
      )
    } catch (webhookError) {
      logger.error('Failed to send unauthorized webhook notification:', webhookError)
    }
  }

  // 检查并清除过期的限流状态
  async checkAndClearRateLimit(accountId) {
    const account = await this.getAccount(accountId)
    if (!account || account.rateLimitStatus !== 'limited') {
      return false
    }

    const now = new Date()
    let shouldClear = false

    // 优先使用 rateLimitResetAt 字段
    if (account.rateLimitResetAt) {
      const resetAt = new Date(account.rateLimitResetAt)
      shouldClear = now >= resetAt
    } else {
      // 如果没有 rateLimitResetAt，使用旧的逻辑
      const rateLimitedAt = new Date(account.rateLimitedAt)
      const rateLimitDuration = parseInt(account.rateLimitDuration) || 60
      shouldClear = now - rateLimitedAt > rateLimitDuration * 60000
    }

    if (shouldClear) {
      // 限流已过期，清除状态
      await this.updateAccount(accountId, {
        rateLimitedAt: '',
        rateLimitStatus: '',
        rateLimitResetAt: '',
        status: 'active',
        schedulable: 'true', // 恢复调度
        errorMessage: ''
      })

      logger.info(`✅ Rate limit cleared for account ${account.name}`)
      return true
    }

    return false
  }

  // 切换调度状态
  async toggleSchedulable(accountId) {
    const account = await this.getAccount(accountId)
    if (!account) {
      throw new Error('Account not found')
    }

    const newSchedulableStatus = account.schedulable === 'true' ? 'false' : 'true'
    await this.updateAccount(accountId, {
      schedulable: newSchedulableStatus
    })

    logger.info(
      `🔄 Toggled schedulable status for account ${account.name}: ${newSchedulableStatus}`
    )

    return {
      success: true,
      schedulable: newSchedulableStatus === 'true'
    }
  }

  // 更新使用额度
  async updateUsageQuota(accountId, amount) {
    const account = await this.getAccount(accountId)
    if (!account) {
      return
    }

    // 检查是否需要重置额度
    const today = redis.getDateStringInTimezone()
    if (account.lastResetDate !== today) {
      // 重置额度
      await this.updateAccount(accountId, {
        dailyUsage: amount.toString(),
        lastResetDate: today,
        quotaStoppedAt: ''
      })
    } else {
      // 累加使用额度
      const currentUsage = parseFloat(account.dailyUsage) || 0
      const newUsage = currentUsage + amount
      const dailyQuota = parseFloat(account.dailyQuota) || 0

      const updates = {
        dailyUsage: newUsage.toString()
      }

      // 检查是否超出额度
      if (dailyQuota > 0 && newUsage >= dailyQuota) {
        updates.status = 'quotaExceeded'
        updates.quotaStoppedAt = new Date().toISOString()
        updates.errorMessage = `Daily quota exceeded: $${newUsage.toFixed(2)} / $${dailyQuota.toFixed(2)}`
        logger.warn(`💸 Account ${account.name} exceeded daily quota`)
      }

      await this.updateAccount(accountId, updates)
    }
  }

  // 更新账户使用统计（记录 token 使用量）
  async updateAccountUsage(accountId, tokens = 0) {
    const account = await this.getAccount(accountId)
    if (!account) {
      return
    }

    const updates = {
      lastUsedAt: new Date().toISOString()
    }

    // 如果有 tokens 参数且大于0，同时更新使用统计
    if (tokens > 0) {
      const currentTokens = parseInt(account.totalUsedTokens) || 0
      updates.totalUsedTokens = (currentTokens + tokens).toString()
    }

    await this.updateAccount(accountId, updates)
  }

  // 记录使用量（为了兼容性的别名）
  async recordUsage(accountId, tokens = 0) {
    return this.updateAccountUsage(accountId, tokens)
  }

  // 重置账户状态（清除所有异常状态）
  async resetAccountStatus(accountId) {
    const account = await this.getAccount(accountId)
    if (!account) {
      throw new Error('Account not found')
    }

    const updates = {
      // 根据是否有有效的 apiKey 来设置 status
      status: account.apiKey ? 'active' : 'created',
      // 恢复可调度状态
      schedulable: 'true',
      // 清除错误相关字段
      errorMessage: '',
      rateLimitedAt: '',
      rateLimitStatus: '',
      rateLimitResetAt: '',
      rateLimitDuration: ''
    }

    await this.updateAccount(accountId, updates)
    logger.info(`✅ Reset all error status for OpenAI-Responses account ${accountId}`)

    // 发送 Webhook 通知
    try {
      const webhookNotifier = require('../utils/webhookNotifier')
      await webhookNotifier.sendAccountAnomalyNotification({
        accountId,
        accountName: account.name || accountId,
        platform: 'openai-responses',
        status: 'recovered',
        errorCode: 'STATUS_RESET',
        reason: 'Account status manually reset',
        timestamp: new Date().toISOString()
      })
      logger.info(
        `📢 Webhook notification sent for OpenAI-Responses account ${account.name} status reset`
      )
    } catch (webhookError) {
      logger.error('Failed to send status reset webhook notification:', webhookError)
    }

    return { success: true, message: 'Account status reset successfully' }
  }

  // ⏰ 检查账户订阅是否已过期
  isSubscriptionExpired(account) {
    if (!account.subscriptionExpiresAt) {
      return false // 未设置过期时间，视为永不过期
    }

    const expiryDate = new Date(account.subscriptionExpiresAt)
    const now = new Date()

    if (expiryDate <= now) {
      logger.debug(
        `⏰ OpenAI-Responses Account ${account.name} (${account.id}) subscription expired at ${account.subscriptionExpiresAt}`
      )
      return true
    }

    return false
  }

  // 获取限流信息
  _getRateLimitInfo(accountData) {
    if (accountData.rateLimitStatus !== 'limited') {
      return { isRateLimited: false }
    }

    const now = new Date()
    let willBeAvailableAt
    let remainingMinutes

    // 优先使用 rateLimitResetAt 字段
    if (accountData.rateLimitResetAt) {
      willBeAvailableAt = new Date(accountData.rateLimitResetAt)
      remainingMinutes = Math.max(0, Math.ceil((willBeAvailableAt - now) / 60000))
    } else {
      // 如果没有 rateLimitResetAt，使用旧的逻辑
      const rateLimitedAt = new Date(accountData.rateLimitedAt)
      const rateLimitDuration = parseInt(accountData.rateLimitDuration) || 60
      const elapsedMinutes = Math.floor((now - rateLimitedAt) / 60000)
      remainingMinutes = Math.max(0, rateLimitDuration - elapsedMinutes)
      willBeAvailableAt = new Date(rateLimitedAt.getTime() + rateLimitDuration * 60000)
    }

    return {
      isRateLimited: remainingMinutes > 0,
      remainingMinutes,
      willBeAvailableAt
    }
  }

  _buildModelsUrl(baseApi) {
    const normalized = String(baseApi || '')
      .trim()
      .replace(/\/+$/, '')
    if (!normalized) {
      throw new Error('Account baseApi is empty')
    }

    if (normalized.endsWith('/v1')) {
      return `${normalized}/models`
    }

    return `${normalized}/v1/models`
  }

  _normalizeModelsResponse(payload) {
    const candidates = []

    if (Array.isArray(payload?.data)) {
      candidates.push(...payload.data)
    }

    if (Array.isArray(payload?.models)) {
      candidates.push(...payload.models)
    } else if (payload?.models && typeof payload.models === 'object') {
      for (const modelId of Object.keys(payload.models)) {
        candidates.push({ id: modelId })
      }
    }

    const uniqueIds = new Set()
    for (const item of candidates) {
      const modelId =
        typeof item === 'string'
          ? item
          : typeof item?.id === 'string'
            ? item.id
            : typeof item?.name === 'string'
              ? item.name
              : ''
      const normalizedId = String(modelId || '').trim()
      if (!normalizedId) {
        continue
      }
      uniqueIds.add(normalizedId)
    }

    return Array.from(uniqueIds)
      .sort((a, b) => a.localeCompare(b))
      .map((id) => ({
        value: id,
        label: id
      }))
  }

  async _getCachedModels(accountId) {
    const client = redis.getClientSafe()
    const cacheKey = `${this.MODELS_CACHE_KEY_PREFIX}${accountId}`
    const raw = await client.get(cacheKey)
    if (!raw) {
      return null
    }

    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed?.models)) {
        return parsed.models
      }
    } catch (error) {
      logger.warn(`⚠️ Failed to parse cached models for account ${accountId}:`, error.message)
    }

    return null
  }

  async _setCachedModels(accountId, models, ttlSeconds) {
    const client = redis.getClientSafe()
    const cacheKey = `${this.MODELS_CACHE_KEY_PREFIX}${accountId}`
    const payload = JSON.stringify({
      models,
      updatedAt: new Date().toISOString()
    })
    await client.setex(cacheKey, ttlSeconds, payload)
  }

  // 加密敏感数据
  _encryptSensitiveData(text) {
    if (!text) {
      return ''
    }

    const key = this._getEncryptionKey()
    const iv = crypto.randomBytes(16)
    const cipher = crypto.createCipheriv(this.ENCRYPTION_ALGORITHM, key, iv)

    let encrypted = cipher.update(text)
    encrypted = Buffer.concat([encrypted, cipher.final()])

    return `${iv.toString('hex')}:${encrypted.toString('hex')}`
  }

  // 解密敏感数据
  _decryptSensitiveData(text) {
    if (!text || text === '') {
      return ''
    }

    // 检查缓存
    const cacheKey = crypto.createHash('sha256').update(text).digest('hex')
    const cached = this._decryptCache.get(cacheKey)
    if (cached !== undefined) {
      return cached
    }

    try {
      const key = this._getEncryptionKey()
      const [ivHex, encryptedHex] = text.split(':')

      const iv = Buffer.from(ivHex, 'hex')
      const encryptedText = Buffer.from(encryptedHex, 'hex')

      const decipher = crypto.createDecipheriv(this.ENCRYPTION_ALGORITHM, key, iv)
      let decrypted = decipher.update(encryptedText)
      decrypted = Buffer.concat([decrypted, decipher.final()])

      const result = decrypted.toString()

      // 存入缓存（5分钟过期）
      this._decryptCache.set(cacheKey, result, 5 * 60 * 1000)

      return result
    } catch (error) {
      logger.error('Decryption error:', error)
      return ''
    }
  }

  // 获取加密密钥
  _getEncryptionKey() {
    if (!this._encryptionKeyCache) {
      this._encryptionKeyCache = crypto.scryptSync(
        config.security.encryptionKey,
        this.ENCRYPTION_SALT,
        32
      )
    }
    return this._encryptionKeyCache
  }

  // 保存账户到 Redis
  async _saveAccount(accountId, accountData) {
    const client = redis.getClientSafe()
    const key = `${this.ACCOUNT_KEY_PREFIX}${accountId}`

    // 保存账户数据
    await client.hset(key, accountData)

    // 添加到索引
    await redis.addToIndex('openai_responses_account:index', accountId)

    // 添加到共享账户列表
    if (accountData.accountType === 'shared') {
      await client.sadd(this.SHARED_ACCOUNTS_KEY, accountId)
    }
  }
}

module.exports = new OpenAIResponsesAccountService()
