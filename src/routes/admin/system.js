const express = require('express')
const fs = require('fs')
const path = require('path')
const axios = require('axios')
const claudeCodeHeadersService = require('../../services/claudeCodeHeadersService')
const claudeAccountService = require('../../services/claudeAccountService')
const claudeConsoleAccountService = require('../../services/claudeConsoleAccountService')
const geminiAccountService = require('../../services/geminiAccountService')
const bedrockAccountService = require('../../services/bedrockAccountService')
const droidAccountService = require('../../services/droidAccountService')
const redis = require('../../models/redis')
const { authenticateAdmin } = require('../../middleware/auth')
const logger = require('../../utils/logger')
const config = require('../../../config/config')

const router = express.Router()

// ==================== Claude Code Headers 管理 ====================

// 获取所有 Claude Code headers
router.get('/claude-code-headers', authenticateAdmin, async (req, res) => {
  try {
    const allHeaders = await claudeCodeHeadersService.getAllAccountHeaders()

    // 获取所有 Claude 账号信息
    const accounts = await claudeAccountService.getAllAccounts()
    const accountMap = {}
    accounts.forEach((account) => {
      accountMap[account.id] = account.name
    })

    // 格式化输出
    const formattedData = Object.entries(allHeaders).map(([accountId, data]) => ({
      accountId,
      accountName: accountMap[accountId] || 'Unknown',
      version: data.version,
      userAgent: data.headers['user-agent'],
      updatedAt: data.updatedAt,
      headers: data.headers
    }))

    return res.json({
      success: true,
      data: formattedData
    })
  } catch (error) {
    logger.error('❌ Failed to get Claude Code headers:', error)
    return res
      .status(500)
      .json({ error: 'Failed to get Claude Code headers', message: error.message })
  }
})

// 🗑️ 清除指定账号的 Claude Code headers
router.delete('/claude-code-headers/:accountId', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params
    await claudeCodeHeadersService.clearAccountHeaders(accountId)

    return res.json({
      success: true,
      message: `Claude Code headers cleared for account ${accountId}`
    })
  } catch (error) {
    logger.error('❌ Failed to clear Claude Code headers:', error)
    return res
      .status(500)
      .json({ error: 'Failed to clear Claude Code headers', message: error.message })
  }
})

// ==================== 系统更新检查 ====================

// 版本比较函数
function compareVersions(current, latest) {
  const parseVersion = (v) => {
    const parts = v.split('.').map(Number)
    return {
      major: parts[0] || 0,
      minor: parts[1] || 0,
      patch: parts[2] || 0
    }
  }

  const currentV = parseVersion(current)
  const latestV = parseVersion(latest)

  if (currentV.major !== latestV.major) {
    return currentV.major - latestV.major
  }
  if (currentV.minor !== latestV.minor) {
    return currentV.minor - latestV.minor
  }
  return currentV.patch - latestV.patch
}

router.get('/check-updates', authenticateAdmin, async (req, res) => {
  // 读取当前版本
  const versionPath = path.join(__dirname, '../../../VERSION')
  let currentVersion = '1.0.0'
  try {
    currentVersion = fs.readFileSync(versionPath, 'utf8').trim()
  } catch (err) {
    logger.warn('⚠️ Could not read VERSION file:', err.message)
  }

  try {
    // 从缓存获取
    const cacheKey = 'version_check_cache'
    const cached = await redis.getClient().get(cacheKey)

    if (cached && !req.query.force) {
      const cachedData = JSON.parse(cached)
      const cacheAge = Date.now() - cachedData.timestamp

      // 缓存有效期1小时
      if (cacheAge < 3600000) {
        // 实时计算 hasUpdate，不使用缓存的值
        const hasUpdate = compareVersions(currentVersion, cachedData.latest) < 0

        return res.json({
          success: true,
          data: {
            current: currentVersion,
            latest: cachedData.latest,
            hasUpdate, // 实时计算，不用缓存
            releaseInfo: cachedData.releaseInfo,
            cached: true
          }
        })
      }
    }

    // 请求 GitHub API
    const githubRepo = 'wei-shaw/claude-relay-service'
    const response = await axios.get(`https://api.github.com/repos/${githubRepo}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'Claude-Relay-Service'
      },
      timeout: 10000
    })

    const release = response.data
    const latestVersion = release.tag_name.replace(/^v/, '')

    // 比较版本
    const hasUpdate = compareVersions(currentVersion, latestVersion) < 0

    const releaseInfo = {
      name: release.name,
      body: release.body,
      publishedAt: release.published_at,
      htmlUrl: release.html_url
    }

    // 缓存结果（不缓存 hasUpdate，因为它应该实时计算）
    await redis.getClient().set(
      cacheKey,
      JSON.stringify({
        latest: latestVersion,
        releaseInfo,
        timestamp: Date.now()
      }),
      'EX',
      3600
    ) // 1小时过期

    return res.json({
      success: true,
      data: {
        current: currentVersion,
        latest: latestVersion,
        hasUpdate,
        releaseInfo,
        cached: false
      }
    })
  } catch (error) {
    // 改进错误日志记录
    const errorDetails = {
      message: error.message || 'Unknown error',
      code: error.code,
      response: error.response
        ? {
            status: error.response.status,
            statusText: error.response.statusText,
            data: error.response.data
          }
        : null,
      request: error.request ? 'Request was made but no response received' : null
    }

    logger.error('❌ Failed to check for updates:', errorDetails.message)

    // 处理 404 错误 - 仓库或版本不存在
    if (error.response && error.response.status === 404) {
      return res.json({
        success: true,
        data: {
          current: currentVersion,
          latest: currentVersion,
          hasUpdate: false,
          releaseInfo: {
            name: 'No releases found',
            body: 'The GitHub repository has no releases yet.',
            publishedAt: new Date().toISOString(),
            htmlUrl: '#'
          },
          warning: 'GitHub repository has no releases'
        }
      })
    }

    // 如果是网络错误，尝试返回缓存的数据
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
      const cacheKey = 'version_check_cache'
      const cached = await redis.getClient().get(cacheKey)

      if (cached) {
        const cachedData = JSON.parse(cached)
        // 实时计算 hasUpdate
        const hasUpdate = compareVersions(currentVersion, cachedData.latest) < 0

        return res.json({
          success: true,
          data: {
            current: currentVersion,
            latest: cachedData.latest,
            hasUpdate, // 实时计算
            releaseInfo: cachedData.releaseInfo,
            cached: true,
            warning: 'Using cached data due to network error'
          }
        })
      }
    }

    // 其他错误返回当前版本信息
    return res.json({
      success: true,
      data: {
        current: currentVersion,
        latest: currentVersion,
        hasUpdate: false,
        releaseInfo: {
          name: 'Update check failed',
          body: `Unable to check for updates: ${error.message || 'Unknown error'}`,
          publishedAt: new Date().toISOString(),
          htmlUrl: '#'
        },
        error: true,
        warning: error.message || 'Failed to check for updates'
      }
    })
  }
})

// ==================== OEM 设置管理 ====================

// 默认OEM设置
const defaultOemSettings = {
  siteName: 'Claude Relay Service',
  siteIcon: '',
  siteIconData: '', // Base64编码的图标数据
  showAdminButton: true, // 是否显示管理后台按钮
  publicStatsEnabled: false, // 是否在首页显示公开统计概览
  // 公开统计显示选项
  publicStatsShowModelDistribution: true, // 显示模型使用分布
  publicStatsModelDistributionPeriod: 'today', // 模型使用分布时间范围: today, 24h, 7d, 30d, all
  publicStatsShowTokenTrends: false, // 显示Token使用趋势
  publicStatsShowApiKeysTrends: false, // 显示API Keys使用趋势
  publicStatsShowAccountTrends: false, // 显示账号使用趋势
  updatedAt: new Date().toISOString()
}

// 获取OEM设置的辅助函数
async function getOemSettings() {
  const client = redis.getClient()
  const oemSettings = await client.get('oem:settings')

  let settings = { ...defaultOemSettings }
  if (oemSettings) {
    try {
      settings = { ...defaultOemSettings, ...JSON.parse(oemSettings) }
    } catch (err) {
      logger.warn('⚠️ Failed to parse OEM settings, using defaults:', err.message)
    }
  }
  return settings
}

// 获取OEM设置（公开接口，用于显示）
// 注意：这个端点没有 authenticateAdmin 中间件，因为前端登录页也需要访问
router.get('/oem-settings', async (req, res) => {
  try {
    const client = redis.getClient()
    const oemSettings = await client.get('oem:settings')

    // 默认设置
    const defaultSettings = {
      siteName: 'Claude Relay Service',
      siteIcon: '',
      siteIconData: '', // Base64编码的图标数据
      showAdminButton: true, // 是否显示管理后台按钮
      apiStatsNotice: {
        enabled: false,
        title: '',
        content: ''
      },
      updatedAt: new Date().toISOString()
    }

    let settings = defaultSettings
    if (oemSettings) {
      try {
        settings = { ...defaultSettings, ...JSON.parse(oemSettings) }
      } catch (err) {
        logger.warn('⚠️ Failed to parse OEM settings, using defaults:', err.message)
      }
    }

    // 添加 LDAP 启用状态到响应中
    return res.json({
      success: true,
      data: {
        ...settings,
        ldapEnabled: config.ldap && config.ldap.enabled === true
      }
    })
  } catch (error) {
    logger.error('❌ Failed to get OEM settings:', error)
    return res.status(500).json({ error: 'Failed to get OEM settings', message: error.message })
  }
})

// 更新OEM设置
router.put('/oem-settings', authenticateAdmin, async (req, res) => {
  try {
    const { siteName, siteIcon, siteIconData, showAdminButton, apiStatsNotice } = req.body

    // 验证输入
    if (!siteName || typeof siteName !== 'string' || siteName.trim().length === 0) {
      return res.status(400).json({ error: 'Site name is required' })
    }

    if (siteName.length > 100) {
      return res.status(400).json({ error: 'Site name must be less than 100 characters' })
    }

    // 验证图标数据大小（如果是base64）
    if (siteIconData && siteIconData.length > 500000) {
      // 约375KB
      return res.status(400).json({ error: 'Icon file must be less than 350KB' })
    }

    // 验证图标URL（如果提供）
    if (siteIcon && !siteIconData) {
      // 简单验证URL格式
      try {
        new URL(siteIcon)
      } catch (err) {
        return res.status(400).json({ error: 'Invalid icon URL format' })
      }
    }

    // 验证时间范围值
    const validPeriods = ['today', '24h', '7d', '30d', 'all']
    const periodValue = validPeriods.includes(publicStatsModelDistributionPeriod)
      ? publicStatsModelDistributionPeriod
      : 'today'

    const settings = {
      siteName: siteName.trim(),
      siteIcon: (siteIcon || '').trim(),
      siteIconData: (siteIconData || '').trim(), // Base64数据
      showAdminButton: showAdminButton !== false, // 默认为true
      apiStatsNotice: {
        enabled: apiStatsNotice?.enabled === true,
        title: (apiStatsNotice?.title || '').trim().slice(0, 100),
        content: (apiStatsNotice?.content || '').trim().slice(0, 2000)
      },
      updatedAt: new Date().toISOString()
    }

    const client = redis.getClient()
    await client.set('oem:settings', JSON.stringify(settings))

    logger.info(`✅ OEM settings updated: ${siteName}`)

    return res.json({
      success: true,
      message: 'OEM settings updated successfully',
      data: settings
    })
  } catch (error) {
    logger.error('❌ Failed to update OEM settings:', error)
    return res.status(500).json({ error: 'Failed to update OEM settings', message: error.message })
  }
})

// ==================== Claude Code 版本管理 ====================

router.get('/claude-code-version', authenticateAdmin, async (req, res) => {
  try {
    const CACHE_KEY = 'claude_code_user_agent:daily'

    // 获取缓存的统一User-Agent
    const unifiedUserAgent = await redis.client.get(CACHE_KEY)
    const ttl = unifiedUserAgent ? await redis.client.ttl(CACHE_KEY) : 0

    res.json({
      success: true,
      userAgent: unifiedUserAgent,
      isActive: !!unifiedUserAgent,
      ttlSeconds: ttl,
      lastUpdated: unifiedUserAgent ? new Date().toISOString() : null
    })
  } catch (error) {
    logger.error('❌ Get unified Claude Code User-Agent error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to get User-Agent information',
      error: error.message
    })
  }
})

// 🗑️ 清除统一Claude Code User-Agent缓存
router.post('/claude-code-version/clear', authenticateAdmin, async (req, res) => {
  try {
    const CACHE_KEY = 'claude_code_user_agent:daily'

    // 删除缓存的统一User-Agent
    await redis.client.del(CACHE_KEY)

    logger.info(`🗑️ Admin manually cleared unified Claude Code User-Agent cache`)

    res.json({
      success: true,
      message: 'Unified User-Agent cache cleared successfully'
    })
  } catch (error) {
    logger.error('❌ Clear unified User-Agent cache error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to clear cache',
      error: error.message
    })
  }
})

// ==================== 公开统计概览 ====================

// 获取公开统计数据（无需认证，用于首页展示）
// 只在 publicStatsEnabled 开启时返回数据
router.get('/public-stats', async (req, res) => {
  try {
    // 检查是否启用了公开统计
    const settings = await getOemSettings()
    if (!settings.publicStatsEnabled) {
      return res.json({
        success: true,
        enabled: false,
        data: null
      })
    }

    // 辅助函数：规范化布尔值
    const normalizeBoolean = (value) => value === true || value === 'true'
    const isRateLimitedFlag = (status) => {
      if (!status) {
        return false
      }
      if (typeof status === 'string') {
        return status === 'limited'
      }
      if (typeof status === 'object') {
        return status.isRateLimited === true
      }
      return false
    }

    // 并行获取统计数据
    const [
      claudeAccounts,
      claudeConsoleAccounts,
      geminiAccounts,
      bedrockAccountsResult,
      droidAccounts,
      todayStats,
      modelStats
    ] = await Promise.all([
      claudeAccountService.getAllAccounts(),
      claudeConsoleAccountService.getAllAccounts(),
      geminiAccountService.getAllAccounts(),
      bedrockAccountService.getAllAccounts(),
      droidAccountService.getAllAccounts(),
      redis.getTodayStats(),
      getPublicModelStats(settings.publicStatsModelDistributionPeriod || 'today')
    ])

    const bedrockAccounts = bedrockAccountsResult.success ? bedrockAccountsResult.data : []

    // 计算各平台正常账户数
    const normalClaudeAccounts = claudeAccounts.filter(
      (acc) =>
        acc.isActive &&
        acc.status !== 'blocked' &&
        acc.status !== 'unauthorized' &&
        acc.schedulable !== false &&
        !(acc.rateLimitStatus && acc.rateLimitStatus.isRateLimited)
    ).length
    const normalClaudeConsoleAccounts = claudeConsoleAccounts.filter(
      (acc) =>
        acc.isActive &&
        acc.status !== 'blocked' &&
        acc.status !== 'unauthorized' &&
        acc.schedulable !== false &&
        !(acc.rateLimitStatus && acc.rateLimitStatus.isRateLimited)
    ).length
    const normalGeminiAccounts = geminiAccounts.filter(
      (acc) =>
        acc.isActive &&
        acc.status !== 'blocked' &&
        acc.status !== 'unauthorized' &&
        acc.schedulable !== false &&
        !(
          acc.rateLimitStatus === 'limited' ||
          (acc.rateLimitStatus && acc.rateLimitStatus.isRateLimited)
        )
    ).length
    const normalBedrockAccounts = bedrockAccounts.filter(
      (acc) =>
        acc.isActive &&
        acc.status !== 'blocked' &&
        acc.status !== 'unauthorized' &&
        acc.schedulable !== false &&
        !(acc.rateLimitStatus && acc.rateLimitStatus.isRateLimited)
    ).length
    const normalDroidAccounts = droidAccounts.filter(
      (acc) =>
        normalizeBoolean(acc.isActive) &&
        acc.status !== 'blocked' &&
        acc.status !== 'unauthorized' &&
        normalizeBoolean(acc.schedulable) &&
        !isRateLimitedFlag(acc.rateLimitStatus)
    ).length

    // 计算总正常账户数
    const totalNormalAccounts =
      normalClaudeAccounts +
      normalClaudeConsoleAccounts +
      normalGeminiAccounts +
      normalBedrockAccounts +
      normalDroidAccounts

    // 判断服务状态
    const isHealthy = redis.isConnected && totalNormalAccounts > 0

    // 构建公开统计数据（脱敏后的数据）
    const publicStats = {
      // 服务状态
      serviceStatus: isHealthy ? 'healthy' : 'degraded',
      uptime: process.uptime(),

      // 平台可用性（只显示是否有可用账户，不显示具体数量）
      platforms: {
        claude: normalClaudeAccounts + normalClaudeConsoleAccounts > 0,
        gemini: normalGeminiAccounts > 0,
        bedrock: normalBedrockAccounts > 0,
        droid: normalDroidAccounts > 0
      },

      // 今日统计
      todayStats: {
        requests: todayStats.requestsToday || 0,
        tokens: todayStats.tokensToday || 0,
        inputTokens: todayStats.inputTokensToday || 0,
        outputTokens: todayStats.outputTokensToday || 0
      },

      // 系统时区
      systemTimezone: config.system.timezoneOffset || 8,

      // 显示选项
      showOptions: {
        modelDistribution: settings.publicStatsShowModelDistribution !== false,
        tokenTrends: settings.publicStatsShowTokenTrends === true,
        apiKeysTrends: settings.publicStatsShowApiKeysTrends === true,
        accountTrends: settings.publicStatsShowAccountTrends === true
      }
    }

    // 根据设置添加可选数据
    if (settings.publicStatsShowModelDistribution !== false) {
      // modelStats 现在返回 { stats: [], period }
      publicStats.modelDistribution = modelStats.stats
      publicStats.modelDistributionPeriod = modelStats.period
    }

    // 获取趋势数据（最近7天）
    if (
      settings.publicStatsShowTokenTrends ||
      settings.publicStatsShowApiKeysTrends ||
      settings.publicStatsShowAccountTrends
    ) {
      const trendData = await getPublicTrendData(settings)
      if (settings.publicStatsShowTokenTrends && trendData.tokenTrends) {
        publicStats.tokenTrends = trendData.tokenTrends
      }
      if (settings.publicStatsShowApiKeysTrends && trendData.apiKeysTrends) {
        publicStats.apiKeysTrends = trendData.apiKeysTrends
      }
      if (settings.publicStatsShowAccountTrends && trendData.accountTrends) {
        publicStats.accountTrends = trendData.accountTrends
      }
    }

    return res.json({
      success: true,
      enabled: true,
      data: publicStats
    })
  } catch (error) {
    logger.error('❌ Failed to get public stats:', error)
    return res.status(500).json({
      success: false,
      error: 'Failed to get public stats',
      message: error.message
    })
  }
})

// 获取公开模型统计的辅助函数
// period: 'today' | '24h' | '7d' | '30d' | 'all'
async function getPublicModelStats(period = 'today') {
  try {
    const client = redis.getClientSafe()
    const today = redis.getDateStringInTimezone()
    const tzDate = redis.getDateInTimezone()

    // 根据period生成日期范围
    const getDatePatterns = () => {
      const patterns = []

      if (period === 'today') {
        patterns.push(`usage:model:daily:*:${today}`)
      } else if (period === '24h') {
        // 过去24小时 = 今天 + 昨天
        patterns.push(`usage:model:daily:*:${today}`)
        const yesterday = new Date(tzDate)
        yesterday.setDate(yesterday.getDate() - 1)
        patterns.push(`usage:model:daily:*:${redis.getDateStringInTimezone(yesterday)}`)
      } else if (period === '7d') {
        // 过去7天
        for (let i = 0; i < 7; i++) {
          const date = new Date(tzDate)
          date.setDate(date.getDate() - i)
          patterns.push(`usage:model:daily:*:${redis.getDateStringInTimezone(date)}`)
        }
      } else if (period === '30d') {
        // 过去30天
        for (let i = 0; i < 30; i++) {
          const date = new Date(tzDate)
          date.setDate(date.getDate() - i)
          patterns.push(`usage:model:daily:*:${redis.getDateStringInTimezone(date)}`)
        }
      } else if (period === 'all') {
        // 所有数据
        patterns.push('usage:model:daily:*')
      } else {
        // 默认今天
        patterns.push(`usage:model:daily:*:${today}`)
      }

      return patterns
    }

    const patterns = getDatePatterns()
    let allKeys = []

    for (const pattern of patterns) {
      const keys = await client.keys(pattern)
      allKeys.push(...keys)
    }

    // 去重
    allKeys = [...new Set(allKeys)]

    if (allKeys.length === 0) {
      return { stats: [], period }
    }

    // 模型名标准化
    const normalizeModelName = (model) => {
      if (!model || model === 'unknown') {
        return model
      }
      if (model.includes('.anthropic.') || model.includes('.claude')) {
        let normalized = model.replace(/^[a-z0-9-]+\./, '')
        normalized = normalized.replace('anthropic.', '')
        normalized = normalized.replace(/-v\d+:\d+$/, '')
        return normalized
      }
      return model.replace(/-v\d+:\d+|:latest$/, '')
    }

    // 聚合模型数据
    const modelStatsMap = new Map()
    let totalRequests = 0

    for (const key of allKeys) {
      const match = key.match(/usage:model:daily:(.+):\d{4}-\d{2}-\d{2}$/)
      if (!match) {
        continue
      }

      const rawModel = match[1]
      const normalizedModel = normalizeModelName(rawModel)
      const data = await client.hgetall(key)

      if (data && Object.keys(data).length > 0) {
        const requests = parseInt(data.requests) || 0
        totalRequests += requests

        const stats = modelStatsMap.get(normalizedModel) || { requests: 0 }
        stats.requests += requests
        modelStatsMap.set(normalizedModel, stats)
      }
    }

    // 转换为数组并计算占比
    const modelStats = []
    for (const [model, stats] of modelStatsMap) {
      modelStats.push({
        model,
        percentage: totalRequests > 0 ? Math.round((stats.requests / totalRequests) * 100) : 0
      })
    }

    // 按占比排序，取前5个
    modelStats.sort((a, b) => b.percentage - a.percentage)
    return { stats: modelStats.slice(0, 5), period }
  } catch (error) {
    logger.warn('⚠️ Failed to get public model stats:', error.message)
    return { stats: [], period }
  }
}

// 获取公开趋势数据的辅助函数（最近7天）
async function getPublicTrendData(settings) {
  const result = {
    tokenTrends: null,
    apiKeysTrends: null,
    accountTrends: null
  }

  try {
    const client = redis.getClientSafe()
    const days = 7

    // 生成最近7天的日期列表
    const dates = []
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date()
      date.setDate(date.getDate() - i)
      dates.push(redis.getDateStringInTimezone(date))
    }

    // Token使用趋势
    if (settings.publicStatsShowTokenTrends) {
      const tokenTrends = []
      for (const dateStr of dates) {
        const pattern = `usage:model:daily:*:${dateStr}`
        const keys = await client.keys(pattern)

        let dayTokens = 0
        let dayRequests = 0
        for (const key of keys) {
          const data = await client.hgetall(key)
          if (data) {
            dayTokens += (parseInt(data.inputTokens) || 0) + (parseInt(data.outputTokens) || 0)
            dayRequests += parseInt(data.requests) || 0
          }
        }

        tokenTrends.push({
          date: dateStr,
          tokens: dayTokens,
          requests: dayRequests
        })
      }
      result.tokenTrends = tokenTrends
    }

    // API Keys使用趋势（脱敏：只显示总数，不显示具体Key）
    if (settings.publicStatsShowApiKeysTrends) {
      const apiKeysTrends = []
      for (const dateStr of dates) {
        const pattern = `usage:apikey:daily:*:${dateStr}`
        const keys = await client.keys(pattern)

        let dayRequests = 0
        let dayTokens = 0
        let activeKeys = 0

        for (const key of keys) {
          const data = await client.hgetall(key)
          if (data) {
            const requests = parseInt(data.requests) || 0
            if (requests > 0) {
              activeKeys++
              dayRequests += requests
              dayTokens += (parseInt(data.inputTokens) || 0) + (parseInt(data.outputTokens) || 0)
            }
          }
        }

        apiKeysTrends.push({
          date: dateStr,
          activeKeys,
          requests: dayRequests,
          tokens: dayTokens
        })
      }
      result.apiKeysTrends = apiKeysTrends
    }

    // 账号使用趋势（脱敏：只显示总数，不显示具体账号）
    if (settings.publicStatsShowAccountTrends) {
      const accountTrends = []
      for (const dateStr of dates) {
        const pattern = `usage:account:daily:*:${dateStr}`
        const keys = await client.keys(pattern)

        let dayRequests = 0
        let dayTokens = 0
        let activeAccounts = 0

        for (const key of keys) {
          const data = await client.hgetall(key)
          if (data) {
            const requests = parseInt(data.requests) || 0
            if (requests > 0) {
              activeAccounts++
              dayRequests += requests
              dayTokens += (parseInt(data.inputTokens) || 0) + (parseInt(data.outputTokens) || 0)
            }
          }
        }

        accountTrends.push({
          date: dateStr,
          activeAccounts,
          requests: dayRequests,
          tokens: dayTokens
        })
      }
      result.accountTrends = accountTrends
    }
  } catch (error) {
    logger.warn('⚠️ Failed to get public trend data:', error.message)
  }

  return result
}

module.exports = router
