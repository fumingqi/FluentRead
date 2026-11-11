/**
 * @file src/features/video-subtitle/content/youtubeTimedTextUrl.ts
 * 文件职责：集中校验 YouTube timedtext 地址，阻止页面初始化数据或桥消息把字幕请求引向任意主机。
 * 主要内容：统一解析绝对/相对地址，要求 HTTPS、无凭据、无自定义端口、YouTube 主域或子域，且路径精确等于 /api/timedtext；向轨道提取、URL 构造、MAIN world 采集与消息消费提供同一判定。
 * 模块边界：只做纯 URL 解析和字符串判定，不读取页面状态、不发起请求，也不解析字幕内容；调用方负责在失败时静默跳过或拒绝数据。
 */

const YOUTUBE_HOSTNAME_PATTERN = /(^|\.)youtube\.com$/i;
const YOUTUBE_TIMED_TEXT_PATH = '/api/timedtext';

/** 只接受 YouTube 主域及其子域；URL 解析结果已转为小写，仍保留 i 以防调用方传入任意主机名。 */
export function isYoutubeHostname(hostname: string): boolean {
  return YOUTUBE_HOSTNAME_PATTERN.test(hostname);
}

/**
 * 解析并收紧 timedtext 地址。解析失败、非 HTTPS、带凭据或非默认端口、主机/路径不匹配时返回 null，
 * 让所有调用方 fail closed，而不是先请求再依赖响应内容判断。
 */
export function parseYoutubeTimedTextUrl(value: string, baseHref = 'https://www.youtube.com/'): URL | null {
  try {
    const url = new URL(value, baseHref);
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password || url.port) return null;
    if (!isYoutubeHostname(url.hostname)) return null;
    if (url.pathname !== YOUTUBE_TIMED_TEXT_PATH) return null;
    return url;
  } catch {
    return null;
  }
}

export function isYoutubeTimedTextUrl(value: string, baseHref: string): boolean {
  return parseYoutubeTimedTextUrl(value, baseHref) !== null;
}
