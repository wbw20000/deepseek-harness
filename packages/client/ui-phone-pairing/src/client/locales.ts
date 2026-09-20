/** Copy owned by the phone pairing section. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Phone pairing section: mint form, QR result, and the paired-session list. */
    phonePairing: keyof typeof zh
  }
}

/** Simplified Chinese phone pairing copy. */
export const zh = {
  nav: '手机配对',
  title: '手机配对',
  intro: '在这台电脑上生成一次性配对链接，用手机相机或 Safari 扫码即可登录同一个稳定版；链接只能用一次，过期未用自动作废。',
  phoneOnly: '配对链接只能在电脑（稳定版所在机器）上生成；手机端这里只显示已配对设备。',
  deviceLabel: '设备名称',
  deviceLabelPlaceholder: '例如 我的 iPhone',
  ttl: '有效期',
  ttlMinutes: '{minutes} 分钟',
  mint: '生成配对链接',
  minting: '生成中…',
  mintFailed: '生成失败：{message}',
  resultTitle: '扫码登录',
  resultHint: '手机扫描二维码，或在手机浏览器里输入下面的链接。',
  qrLabel: '配对二维码',
  expiresIn: '{seconds} 秒后过期',
  expired: '链接已过期，请重新生成。',
  copy: '复制链接',
  copied: '已复制',
  copyFailed: '复制失败，请手动选中链接复制。',
  sessionsTitle: '已配对设备',
  refresh: '刷新',
  loading: '正在读取…',
  loadFailed: '读取失败：{message}',
  noSessions: '还没有配对的设备。',
  columnDevice: '设备',
  columnIssued: '登录时间',
  columnExpires: '到期',
  columnState: '状态',
  stateActive: '有效',
  stateRevoked: '已撤销',
  revoke: '撤销',
  revoking: '撤销中…',
  revokeTitle: '撤销这台设备？',
  revokeDescription: '设备 {device} 的登录立即失效：它的页面会断开，再次访问需要重新扫码配对。',
  revokeAcknowledge: '我已了解，立即撤销',
  cancel: '取消',
  close: '关闭',
  confirmRevoke: '撤销',
  revokeFailed: '撤销失败：{message}',
} as const

/** English phone pairing copy. */
export const en: Record<keyof typeof zh, string> = {
  nav: 'Phone pairing',
  title: 'Phone pairing',
  intro: 'Mint a one-time pairing link on this computer and scan it with the phone camera or Safari to sign in to this same stable version; a link works once and expires unused.',
  phoneOnly: 'Pairing links are minted on the computer that runs the stable version; on a phone this section only lists the paired devices.',
  deviceLabel: 'Device name',
  deviceLabelPlaceholder: 'e.g. My iPhone',
  ttl: 'Valid for',
  ttlMinutes: '{minutes} minutes',
  mint: 'Mint pairing link',
  minting: 'Minting…',
  mintFailed: 'Minting failed: {message}',
  resultTitle: 'Scan to sign in',
  resultHint: 'Scan the QR code with the phone, or type the link below into its browser.',
  qrLabel: 'Pairing QR code',
  expiresIn: 'Expires in {seconds} s',
  expired: 'This link has expired; mint a new one.',
  copy: 'Copy link',
  copied: 'Copied',
  copyFailed: 'Copy failed; select the link and copy it by hand.',
  sessionsTitle: 'Paired devices',
  refresh: 'Refresh',
  loading: 'Loading…',
  loadFailed: 'Loading failed: {message}',
  noSessions: 'No paired devices yet.',
  columnDevice: 'Device',
  columnIssued: 'Signed in',
  columnExpires: 'Expires',
  columnState: 'State',
  stateActive: 'Active',
  stateRevoked: 'Revoked',
  revoke: 'Revoke',
  revoking: 'Revoking…',
  revokeTitle: 'Revoke this device?',
  revokeDescription: 'Device {device} is signed out at once: its page disconnects, and it must scan a new pairing link to return.',
  revokeAcknowledge: 'I understand, revoke now',
  cancel: 'Cancel',
  close: 'Close',
  confirmRevoke: 'Revoke',
  revokeFailed: 'Revoking failed: {message}',
}

/** Every phone pairing copy key. */
export type PhonePairingKey = keyof typeof zh
