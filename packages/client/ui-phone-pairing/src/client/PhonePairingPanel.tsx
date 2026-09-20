/**
 * The phone pairing Settings section. On the stable host it mints one-time
 * pairing links (rendered as a QR code the phone scans) and, everywhere, it
 * lists the paired browser sessions with a revoke action behind a risk
 * confirmation. Every operation goes through {@link PairingApi}; the
 * component never sees a cookie, and the minted token lives only in this
 * component's state until the link expires.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Button, Input, RiskConfirmation, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { MintedPairing, PairedSession, PairingApi } from './api.ts'
import { encodeQr, type QrMatrix } from './qr.ts'
import css from './PhonePairingPanel.module.css'

/** What the slot framework injects into the section. */
export interface PhonePairingInjected {
  /** Connection's session routes. */
  readonly api: PairingApi
  /** Whether this client is a phone (non-loopback host): minting is hidden there. */
  readonly phone: boolean
  /** Host clock; injectable so the expiry countdown is testable. */
  readonly now: () => number
}

/** Composed props: the injected face plus the locale seat. */
export type PhonePairingPanelProps = InjectFace<PhonePairingInjected> & PropsLocale<'phonePairing'>

/** Pairing time-to-live choices in minutes; Connection caps a token at ten minutes. */
const TTL_MINUTES = [5, 10] as const

/**
 * Render a QR matrix as inline SVG (one rect per dark module, four-module quiet zone).
 * @param props.text - the payload to encode.
 * @param props.label - the accessible name of the image.
 * @returns the SVG element, or nothing when the payload exceeds what the encoder holds
 * (the link text and the copy button next to it still carry the pairing URL).
 */
function QrCode({ text, label }: { text: string; label: string }): ReactNode {
  let matrix: QrMatrix
  try {
    matrix = encodeQr(text)
  } catch {
    return null
  }
  const quiet = 4
  const total = matrix.size + quiet * 2
  const rects: ReactNode[] = []
  matrix.modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) rects.push(<rect key={`${String(x)}-${String(y)}`} x={x + quiet} y={y + quiet} width={1} height={1} />)
    })
  })
  return (
    <svg className={css.qr} viewBox={`0 0 ${String(total)} ${String(total)}`} shapeRendering="crispEdges" role="img" aria-label={label}>
      <rect width={total} height={total} fill="#fff" />
      <g fill="#000">{rects}</g>
    </svg>
  )
}

/**
 * Format a host-clock timestamp for the session table.
 * @param ms - milliseconds since the epoch.
 * @returns a locale date-time string.
 */
function timestamp(ms: number): string {
  return new Date(ms).toLocaleString()
}

/**
 * Render the section.
 * @param props - the injected face and the dictionary seat.
 * @returns the section element tree.
 */
export function PhonePairingPanel(props: PhonePairingPanelProps): ReactNode {
  const { t, api, phone, now } = props
  const [deviceLabel, setDeviceLabel] = useState('')
  const [ttlMinutes, setTtlMinutes] = useState<number>(10)
  const [minting, setMinting] = useState(false)
  const [mintError, setMintError] = useState<string | undefined>(undefined)
  const [minted, setMinted] = useState<MintedPairing | undefined>(undefined)
  const [tick, setTick] = useState(0)
  const [copied, setCopied] = useState<'copied' | 'failed' | undefined>(undefined)
  const [sessions, setSessions] = useState<readonly PairedSession[] | undefined>(undefined)
  const [sessionsError, setSessionsError] = useState<string | undefined>(undefined)
  const [revoking, setRevoking] = useState<PairedSession | undefined>(undefined)
  const [acknowledged, setAcknowledged] = useState(false)
  const [revokeBusy, setRevokeBusy] = useState(false)
  const [revokeError, setRevokeError] = useState<string | undefined>(undefined)

  const loadSessions = useCallback(async () => {
    setSessionsError(undefined)
    try {
      setSessions(await api.sessions())
    } catch (error) {
      setSessionsError(error instanceof Error ? error.message : String(error))
    }
  }, [api])

  useEffect(() => { void loadSessions() }, [loadSessions])

  // Countdown: re-render once a second while a minted link is on screen.
  useEffect(() => {
    if (minted === undefined) return undefined
    const timer = setInterval(() => { setTick(value => value + 1) }, 1000)
    return () => { clearInterval(timer) }
  }, [minted])

  const mint = async (): Promise<void> => {
    setMinting(true)
    setMintError(undefined)
    setCopied(undefined)
    try {
      setMinted(await api.mint({ deviceLabel: deviceLabel.trim(), ttlMs: ttlMinutes * 60_000 }))
    } catch (error) {
      setMinted(undefined)
      setMintError(error instanceof Error ? error.message : String(error))
    } finally {
      setMinting(false)
    }
  }

  const copy = async (url: string): Promise<void> => {
    setCopied((await writeClipboard(url)) ? 'copied' : 'failed')
  }

  const confirmRevoke = async (): Promise<void> => {
    // The dialog only opens over a selected session; RiskConfirmation calls
    // onConfirm only while open.
    /* v8 ignore next -- an open dialog always carries its session. */
    if (revoking === undefined) return
    setRevokeBusy(true)
    setRevokeError(undefined)
    try {
      await api.revoke(revoking.sessionId)
      setRevoking(undefined)
      setAcknowledged(false)
      await loadSessions()
    } catch (error) {
      setRevokeError(error instanceof Error ? error.message : String(error))
    } finally {
      setRevokeBusy(false)
    }
  }

  const remainingSeconds = minted === undefined ? 0 : Math.max(0, Math.ceil((minted.expiresAt - now()) / 1000))
  void tick

  return (
    <section className={css.panel} aria-label={t('title')}>
      <h2 className={css.heading}>{t('title')}</h2>
      <p className={css.text}>{t('intro')}</p>
      {phone
        ? <p className={css.text}>{t('phoneOnly')}</p>
        : (
          <form
            className={css.form}
            onSubmit={(event) => { event.preventDefault(); void mint() }}
          >
            <label className={css.field}>
              {t('deviceLabel')}
              <Input
                value={deviceLabel}
                placeholder={t('deviceLabelPlaceholder')}
                onChange={(event) => { setDeviceLabel(event.currentTarget.value) }}
              />
            </label>
            <label className={css.field}>
              {t('ttl')}
              <select
                className={css.select}
                value={ttlMinutes}
                onChange={(event) => { setTtlMinutes(Number(event.currentTarget.value)) }}
              >
                {TTL_MINUTES.map(minutes => (
                  <option key={minutes} value={minutes}>{t('ttlMinutes', { minutes })}</option>
                ))}
              </select>
            </label>
            <Button variant="primary" type="submit" disabled={minting || deviceLabel.trim() === ''}>
              {minting ? t('minting') : t('mint')}
            </Button>
          </form>
        )}
      {mintError !== undefined && <p className={css.error} role="alert">{t('mintFailed', { message: mintError })}</p>}
      {minted !== undefined && (
        <div aria-label={t('resultTitle')} role="region">
          <h3 className={css.heading}>{t('resultTitle')}</h3>
          <p className={css.text}>{remainingSeconds > 0 ? t('resultHint') : t('expired')}</p>
          {remainingSeconds > 0 && (
            <div className={css.result}>
              <QrCode text={minted.authenticatedUrl} label={t('qrLabel')} />
              <div>
                <p className={css.link}>{minted.authenticatedUrl}</p>
                <p className={css.text}>{t('expiresIn', { seconds: remainingSeconds })}</p>
                <Button size="sm" onClick={() => { void copy(minted.authenticatedUrl) }}>{t('copy')}</Button>
                {copied === 'copied' && <span className={css.text}> {t('copied')}</span>}
                {copied === 'failed' && <span className={css.error}> {t('copyFailed')}</span>}
              </div>
            </div>
          )}
        </div>
      )}
      <div>
        <div className={css.form}>
          <h3 className={css.heading}>{t('sessionsTitle')}</h3>
          <Button size="sm" onClick={() => { void loadSessions() }}>{t('refresh')}</Button>
        </div>
        {sessionsError !== undefined && <p className={css.error} role="alert">{t('loadFailed', { message: sessionsError })}</p>}
        {sessions === undefined && sessionsError === undefined && <p className={css.text}>{t('loading')}</p>}
        {sessions !== undefined && sessions.length === 0 && <p className={css.text}>{t('noSessions')}</p>}
        {sessions !== undefined && sessions.length > 0 && (
          <table className={css.table}>
            <thead>
              <tr>
                <th>{t('columnDevice')}</th>
                <th>{t('columnIssued')}</th>
                <th>{t('columnExpires')}</th>
                <th>{t('columnState')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sessions.map(session => (
                <tr key={session.sessionId} className={session.revokedAt === undefined ? undefined : css.revoked}>
                  <td>{session.deviceLabel}</td>
                  <td>{timestamp(session.issuedAt)}</td>
                  <td>{timestamp(session.expiresAt)}</td>
                  <td>{session.revokedAt === undefined ? t('stateActive') : t('stateRevoked')}</td>
                  <td>
                    {session.revokedAt === undefined && (
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`${t('revoke')} ${session.deviceLabel}`}
                        onClick={() => { setRevokeError(undefined); setAcknowledged(false); setRevoking(session) }}
                      >
                        {t('revoke')}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {revokeError !== undefined && <p className={css.error} role="alert">{t('revokeFailed', { message: revokeError })}</p>}
      </div>
      <RiskConfirmation
        open={revoking !== undefined}
        title={t('revokeTitle')}
        description={t('revokeDescription', { device: revoking?.deviceLabel ?? '' })}
        acknowledgeLabel={t('revokeAcknowledge')}
        cancelLabel={t('cancel')}
        closeLabel={t('close')}
        confirmLabel={revokeBusy ? t('revoking') : t('confirmRevoke')}
        acknowledged={acknowledged}
        disabled={revokeBusy}
        onAcknowledgedChange={setAcknowledged}
        onCancel={() => { setRevoking(undefined); setAcknowledged(false) }}
        onConfirm={() => { void confirmRevoke() }}
      />
    </section>
  )
}
