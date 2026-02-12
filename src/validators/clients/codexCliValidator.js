const logger = require('../../utils/logger')
const { CLIENT_DEFINITIONS } = require('../clientDefinitions')

/**
 * Codex CLI 验证器
 * 验证请求是否来自 Codex CLI
 */
class CodexCliValidator {
  /**
   * 获取客户端ID
   */
  static getId() {
    return CLIENT_DEFINITIONS.CODEX_CLI.id
  }

  /**
   * 获取客户端名称
   */
  static getName() {
    return CLIENT_DEFINITIONS.CODEX_CLI.name
  }

  /**
   * 获取客户端描述
   */
  static getDescription() {
    return CLIENT_DEFINITIONS.CODEX_CLI.description
  }

  /**
   * 验证请求是否来自 Codex CLI
   * @param {Object} req - Express 请求对象
   * @returns {boolean} 验证结果
   */
  static validate(req) {
    try {
      const headers = req.headers || {}
      const userAgent = headers['user-agent'] || ''
      const sessionId = headers['session_id'] || headers['x-session-id']

      // 1. 基础 User-Agent 检查
      // Codex CLI 的 UA 格式:
      // - codex_vscode/0.35.0 (Windows 10.0.26100; x86_64) unknown (Cursor; 0.4.10)
      // - codex_cli_rs/0.38.0 (Ubuntu 22.4.0; x86_64) WindowsTerminal
      // - codex_exec/0.89.0 (Mac OS 26.2.0; arm64) xterm-256color (非交互式/脚本模式)
      const codexCliPattern = /^(codex_vscode|codex_cli_rs|codex_exec)\/[\d.]+/i
      const uaMatch = userAgent.match(codexCliPattern)

      if (!uaMatch) {
        logger.debug(`Codex CLI validation failed - UA mismatch: ${userAgent}`)
        return false
      }

      // 2. 对于 /openai 和 /azure 路径做基础额外校验（与官方协议保持松耦合）
      const normalizedPath = String(req.originalUrl || req.path || '').toLowerCase()
      const needsStrictValidation =
        normalizedPath.startsWith('/openai') || normalizedPath.startsWith('/azure')
      const isModelsCatalogPath =
        normalizedPath.startsWith('/openai/models') ||
        normalizedPath.startsWith('/openai/v1/models') ||
        normalizedPath.startsWith('/azure/models') ||
        normalizedPath.startsWith('/azure/v1/models')

      if (!needsStrictValidation) {
        // 其他路径，只要 User-Agent 匹配就认为是 Codex CLI
        logger.debug(`Codex CLI detected for path: ${req.path}, allowing access`)
        return true
      }

      // 3. 非 models 请求要求 session_id 基本有效，避免明显伪造流量
      if (!isModelsCatalogPath) {
        if (!sessionId || sessionId.length <= 20) {
          logger.debug(
            `Codex CLI validation failed - session_id missing or too short: ${sessionId}`
          )
          return false
        }
      }

      // 所有必要检查通过（originator / instructions 保持透传，不做强绑定）
      logger.debug(`Codex CLI validation passed for UA: ${userAgent}`)
      return true
    } catch (error) {
      logger.error('Error in CodexCliValidator:', error)
      // 验证出错时默认拒绝
      return false
    }
  }

  /**
   * 比较版本号
   * @returns {number} -1: v1 < v2, 0: v1 = v2, 1: v1 > v2
   */
  static compareVersions(v1, v2) {
    const parts1 = v1.split('.').map(Number)
    const parts2 = v2.split('.').map(Number)

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const part1 = parts1[i] || 0
      const part2 = parts2[i] || 0

      if (part1 < part2) {
        return -1
      }
      if (part1 > part2) {
        return 1
      }
    }

    return 0
  }

  /**
   * 获取验证器信息
   */
  static getInfo() {
    return {
      id: this.getId(),
      name: this.getName(),
      description: this.getDescription(),
      icon: CLIENT_DEFINITIONS.CODEX_CLI.icon
    }
  }
}

module.exports = CodexCliValidator
