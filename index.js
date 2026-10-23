/**
 * dsh-turn-budget — Host half (official DSH bundle form).
 *
 * A spend circuit breaker. One sliding window (default 6 minutes) is watched
 * from two independent sources, each with its OWN threshold:
 *
 *   - the real account balance, polled from the official DeepSeek
 *     /user/balance endpoint — ground truth, because it moves no matter which
 *     model, session, subagent, retry or compaction summary did the spending.
 *     Measured settlement lag is ~30 s to ~3.5 min (the platform documents "up
 *     to 5 minutes" for its usage data), so this source is authoritative but
 *     slow, which is why its threshold is the looser one;
 *   - a token-cost estimate folded from every session's durable log — zero lag,
 *     checked on every step, so it is the fast trigger and carries the tighter
 *     threshold.
 *
 * Reaching EITHER threshold SUSPENDS every model request in the process: the
 * `llm/stream` waterfall waits before delegating, so no request is sent and
 * nothing is dropped. The window slides, so the gate reopens by itself; "解除暂停"
 * rebases the window to now. Both thresholds are editable from the composer dock
 * and persisted to <DSH_HOME>/turn-budget.json.
 *
 * Client channel: same-origin HTTP endpoints on ctx.webServer (/turn-budget/*).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'dsh-turn-budget'

const WINDOW_MINUTES = 6
const MS_MINUTE = 60000
const WINDOW_MS = WINDOW_MINUTES * MS_MINUTE
const ESTIMATE_LIMIT_DEFAULT = 7
const BALANCE_LIMIT_DEFAULT = 10
const LIMIT_MAX = 100000
const SAMPLE_MS = 120000
/**
 * Gate re-decision clock. The cost estimate is folded per billed step, so this
 * only governs how quickly a halt is released as the window slides; keeping it at
 * 30s means the balance poll can be slow without delaying any release.
 */
const EVALUATE_MS = 30000
const BALANCE_TIMEOUT_MS = 8000
const OFFICIAL_BASE = /^https?:\/\/api\.deepseek\.com\/?$/
const ROUTE_PREFIX = '/turn-budget'
const CONFIG_FILE = 'turn-budget.json'
const CREDENTIALS_FILE = '.credentials.yaml'
const MS_DAY = 86400000
const MS_HOUR = 3600000

/** Official DeepSeek list prices, CNY per 1M tokens: cache hit / cache miss / output. */
const PRICES = {
  flash: { idle: { hit: 0.02, miss: 1, out: 4 }, peak: { hit: 0.04, miss: 2, out: 8 } },
  pro: { idle: { hit: 0.15, miss: 4.5, out: 13.5 }, peak: { hit: 0.3, miss: 9, out: 27 } },
}

/**
 * CN statutory holidays — 2026 arrangement (国务院办公厅通知
 * gov.cn/zhengce/zhengceku/202511/content_7047091.htm, structured by holiday-cn).
 * Only days OFF are listed: the official billing rule (API docs "模型 & 价格",
 * footnote 2) makes weekends and statutory holidays off-peak for the whole day,
 * so the make-up workdays (01-04, 02-14, 02-28, 05-09, 09-20, 10-10) are
 * off-peak as well and deliberately need no entry here.
 */
const HOLIDAYS = {
  '2026-01-01': '元旦', '2026-01-02': '元旦', '2026-01-03': '元旦',
  '2026-02-15': '春节', '2026-02-16': '春节', '2026-02-17': '春节',
  '2026-02-18': '春节', '2026-02-19': '春节', '2026-02-20': '春节',
  '2026-02-21': '春节', '2026-02-22': '春节', '2026-02-23': '春节',
  '2026-04-04': '清明', '2026-04-05': '清明', '2026-04-06': '清明',
  '2026-05-01': '劳动节', '2026-05-02': '劳动节', '2026-05-03': '劳动节',
  '2026-05-04': '劳动节', '2026-05-05': '劳动节',
  '2026-06-19': '端午', '2026-06-20': '端午', '2026-06-21': '端午',
  '2026-09-25': '中秋', '2026-09-26': '中秋', '2026-09-27': '中秋',
  '2026-10-01': '国庆', '2026-10-02': '国庆', '2026-10-03': '国庆',
  '2026-10-04': '国庆', '2026-10-05': '国庆', '2026-10-06': '国庆',
  '2026-10-07': '国庆',
}
/** Last day the holiday table covers; the plugin starts warning before it ends. */
const HOLIDAY_COVERAGE_END = '2026-12-31'
/** Warn this many days before HOLIDAY_COVERAGE_END. */
const HOLIDAY_STALE_DAYS = 60
const models = {}
/** Token-cost estimate inside the window: { at, cost }. */
const costEvents = []
/** Deadline for one account-service read; the provider's own default is 30s. */
const ACCOUNT_TIMEOUT_MS = 8000

/** Real balance samples inside the window: { at, balance, src }. */
const samples = []
/** Model requests parked on the gate. */
const waiters = []
let estimateLimit = ESTIMATE_LIMIT_DEFAULT
let balanceLimit = BALANCE_LIMIT_DEFAULT
let halted = false
let haltReason = ''
let haltAt = 0
let lastBalance = null
let lastSampleAt = 0
let lastSampleError = ''
/** Why the account service produced nothing this round ('' when it succeeded). */
let accountError = ''
let balanceReadable = false
let keySource = ''
let credentialsVisible = false
/** Source of the newest sample: 'account' | 'api' | ''. */
let sampleSource = ''
/** In-flight guard: a slow read must not let sampling rounds overlap. */
let sampling = false

function isNum(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function floorPos(value) {
  const frac = value % 1
  return value - (frac < 0 ? frac + 1 : frac)
}

/** Model id -> price lane. Anything without "pro" is the flash lane. */
function laneOf(model) {
  return typeof model === 'string' && model.toLowerCase().includes('pro') ? 'pro' : 'flash'
}

/**
 * Beijing peak = Mon-Fri 09:00-12:00 and 14:00-18:00, **excluding CN statutory
 * holidays**; weekends, make-up workdays and holidays are off-peak all day
 * (official footnote: "包括周末及中国法定节假日全天均为空闲时段").
 */
function bandOf(ms) {
  const at = isNum(ms) && ms > 0 ? ms : 0
  const beijing = at + 8 * MS_HOUR
  const day = floorPos(beijing / MS_DAY)
  const dow = (((day + 4) % 7) + 7) % 7
  const minutes = floorPos((beijing - day * MS_DAY) / MS_MINUTE)
  const date = new Date(day * MS_DAY).toISOString().slice(0, 10)
  const holiday = Object.prototype.hasOwnProperty.call(HOLIDAYS, date) ? HOLIDAYS[date] : null
  const peak = holiday === null && dow >= 1 && dow <= 5 && ((minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080))
  return { peak: peak, holiday: holiday }
}

/** Holiday-table status for the snapshot / tooltip: coverage plus today's name. */
function holidayStatus(now) {
  const at = isNum(now) && now > 0 ? now : Date.now()
  const end = Date.parse(HOLIDAY_COVERAGE_END + 'T00:00:00Z')
  const daysLeft = Math.floor((end - at) / MS_DAY)
  const beijing = at + 8 * MS_HOUR
  const date = new Date(floorPos(beijing / MS_DAY) * MS_DAY).toISOString().slice(0, 10)
  const today = Object.prototype.hasOwnProperty.call(HOLIDAYS, date) ? HOLIDAYS[date] : null
  return {
    year: Number(HOLIDAY_COVERAGE_END.slice(0, 4)),
    coverageEnd: HOLIDAY_COVERAGE_END,
    daysLeft: daysLeft,
    stale: daysLeft < HOLIDAY_STALE_DAYS,
    today: today,
  }
}

function priceOf(lane, peak) {
  const table = PRICES[lane] === undefined ? PRICES.flash : PRICES[lane]
  return peak ? table.peak : table.idle
}

/** Drop every entry older than the floor, whatever the append order was. */
function pruneList(list, floor) {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].at < floor) list.splice(i, 1)
  }
}

/** Estimated token cost spent by every session inside the window. */
function costSpendIn(now) {
  const floor = now - WINDOW_MS
  let sum = 0
  for (let i = 0; i < costEvents.length; i += 1) {
    if (costEvents[i].at >= floor) sum += costEvents[i].cost
  }
  return sum
}

/**
 * Real balance drop inside the window, measured **within one source only**. The
 * account service and the API key report the same account through different
 * Platform payloads (wallet sum vs `total_balance`), so comparing across a source
 * switch would inject a step that looks exactly like spend. Samples older than the
 * newest sample's source are therefore ignored; if that source has no earlier
 * sample the result is null — "not known yet", never a halt. `base` is the newest
 * same-source sample at or before `now - WINDOW_MS`; a history younger than the
 * window falls back to the oldest such sample, which can only under-report.
 */
function balanceDropIn(now) {
  if (samples.length < 2) return null
  const last = samples[samples.length - 1]
  let start = samples.length - 1
  while (start > 0 && samples[start - 1].src === last.src) start -= 1
  const same = samples.slice(start)
  if (same.length < 2) return null
  const target = now - WINDOW_MS
  let base = null
  for (let i = same.length - 1; i >= 0; i -= 1) {
    if (same[i].at <= target) {
      base = same[i]
      break
    }
  }
  let full = true
  if (base === null) {
    base = same[0]
    full = false
  }
  return { drop: base.balance - last.balance, baseAt: base.at, to: last.at, full: full }
}

/** Re-decide the gate and wake parked requests when it opens. */
function evaluate(now) {
  const cost = costSpendIn(now)
  const balance = balanceDropIn(now)
  const overEstimate = cost >= estimateLimit
  const overBalance = balance !== null && balance.drop >= balanceLimit
  const shouldHalt = overEstimate || overBalance
  if (shouldHalt && !halted) {
    halted = true
    haltAt = now
    if (overBalance) {
      haltReason = '余额 ' + WINDOW_MINUTES + ' 分钟内掉了 ' + balance.drop.toFixed(2) + '（阈值 ' + balanceLimit + '）'
    } else {
      haltReason = '估算花费 ' + WINDOW_MINUTES + ' 分钟内达 ' + cost.toFixed(2) + '（阈值 ' + estimateLimit + '）'
    }
    console.log('[turn-budget] SUSPENDED every model request: ' + haltReason +
      ' [' + waiters.length + ' parked]')
    return
  }
  if (!shouldHalt && halted) {
    halted = false
    haltReason = ''
    console.log('[turn-budget] resumed: the ' + WINDOW_MINUTES + '-minute window fell below both thresholds')
    flushWaiters()
  }
}

/**
 * Park one model request until the gate opens, the caller aborts, or the safety
 * valve expires (the window plus a margin) so a stuck gate can never freeze the
 * whole harness forever.
 */
function waitForGate(signal) {
  if (!halted) return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    const waiter = {}
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(waiter.cap)
      const at = waiters.indexOf(waiter)
      if (at >= 0) waiters.splice(at, 1)
      resolve()
    }
    waiter.finish = finish
    waiter.cap = setTimeout(() => {
      console.error('[turn-budget] gate safety valve fired; releasing one request')
      finish()
    }, WINDOW_MS + 5 * MS_MINUTE)
    waiters.push(waiter)
    if (signal) {
      if (signal.aborted) {
        finish()
        return
      }
      if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', finish, { once: true })
    }
    // The gate may have opened while this waiter was being registered.
    if (!halted) finish()
  })
}

function flushWaiters() {
  const pending = waiters.slice()
  for (let i = 0; i < pending.length; i += 1) pending[i].finish()
}

/**
 * DSH home — where the persisted thresholds and the credentials document live.
 * DSH_HOME when the deployment exports it; otherwise the standard
 * <user home>/.dsh, because the running server process does not necessarily have
 * DSH_HOME set.
 */
function homeDir() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  const userHome = process.env.USERPROFILE || process.env.HOME || ''
  return userHome.length > 0 ? join(userHome, '.dsh') : ''
}

function loadConfig() {
  const dir = homeDir()
  if (dir.length === 0) return
  try {
    const data = JSON.parse(readFileSync(join(dir, CONFIG_FILE), 'utf8'))
    if (Number.isInteger(data.estimateLimit) && data.estimateLimit > 0 && data.estimateLimit <= LIMIT_MAX) estimateLimit = data.estimateLimit
    if (Number.isInteger(data.balanceLimit) && data.balanceLimit > 0 && data.balanceLimit <= LIMIT_MAX) balanceLimit = data.balanceLimit
  } catch (error) {
    // First run (no file yet) or unreadable file: keep the defaults. A legacy
    // single `dropLimit` key is deliberately ignored.
  }
}

function saveConfig() {
  const dir = homeDir()
  if (dir.length === 0) return
  try {
    const body = JSON.stringify({ estimateLimit: estimateLimit, balanceLimit: balanceLimit }, null, 2)
    writeFileSync(join(dir, CONFIG_FILE), body, 'utf8')
  } catch (error) {
    console.error('[turn-budget] persist failed: ' + String((error && error.message) || error))
  }
}

/**
 * Read DEEPSEEK_API_KEY straight out of the credentials document
 * (<DSH_HOME>/.credentials.yaml, the inline scalar at `refs.DEEPSEEK_API_KEY`)
 * with no YAML dependency. This is the fallback for when the `credentials`
 * service is not reachable from this plugin's context; the document is written
 * by the very service that would otherwise answer, so a key rotated in the UI
 * shows up here too.
 */
function readCredentialFile() {
  const dir = homeDir()
  if (dir.length === 0) return ''
  try {
    const lines = readFileSync(join(dir, CREDENTIALS_FILE), 'utf8').split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      const at = line.indexOf('DEEPSEEK_API_KEY')
      if (at < 0) continue
      const rest = line.slice(at + 'DEEPSEEK_API_KEY'.length).replace(/^\s*:\s*/, '').trim()
      const token = rest.replace(/^["']/, '').replace(/["']$/, '')
      if (token.length >= 20 && token.indexOf('DEEPSEEK_API_KEY') < 0) return token
    }
  } catch (error) {
    // No document / unreadable: no fallback key from here.
  }
  return ''
}

/**
 * Resolve the official API key in preference order: the credentials service, the
 * process environment, then the credentials document itself. The key is used
 * only as an Authorization header to api.deepseek.com — never logged, never sent
 * to the browser.
 */
async function resolveKey(ctx) {
  try {
    const credentials = ctx.get('credentials')
    if (credentials && typeof credentials.resolve === 'function') {
      credentialsVisible = true
      const record = await credentials.resolve('DEEPSEEK_API_KEY')
      const value = record && typeof record.value === 'string' ? record.value.trim() : ''
      if (value.length > 0) {
        keySource = 'credentials-service'
        lastSampleError = ''
        return value
      }
      lastSampleError = 'credentials 服务返回空值'
    } else {
      credentialsVisible = false
      lastSampleError = 'credentials 服务在此上下文不可见'
    }
  } catch (error) {
    credentialsVisible = false
    lastSampleError = 'credentials.resolve 失败: ' + String((error && error.message) || error)
  }
  const fromEnv = typeof process.env.DEEPSEEK_API_KEY === 'string' ? process.env.DEEPSEEK_API_KEY.trim() : ''
  if (fromEnv.length > 0) {
    keySource = 'env'
    lastSampleError = ''
    return fromEnv
  }
  const fromFile = readCredentialFile()
  if (fromFile.length > 0) {
    keySource = 'credentials-file'
    lastSampleError = ''
    return fromFile
  }
  keySource = ''
  return ''
}

/**
 * Read the balance through the harness's own DeepSeek account service. This is
 * the preferred source: it queries the Platform with the signed-in account's
 * grant, so no API key, no baseURL gate and no credentials document are
 * involved. Returns null when the account is signed out, the query failed, or no
 * CNY wallet was reported — the caller then falls back to the API-key path.
 */
async function officialBalance(ctx) {
  const account = ctx.get('deepseekAccount')
  if (!account || typeof account.getBalance !== 'function') {
    accountError = '账户服务不可用'
    return null
  }
  let timer = null
  try {
    const details = await Promise.race([
      account.getBalance({
        // AccountClientMetadata: the provider derives the Platform client headers
        // from it; the values are informational, only the shape matters.
        version: '1.0.0',
        locale: 'zh-CN',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      }),
      // The provider's own deadline is balanceTimeoutMs (30s by default) — a whole
      // sampling interval. Bound it here so one slow round cannot delay the next
      // one or stamp stale data with a fresh timestamp.
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(undefined), ACCOUNT_TIMEOUT_MS)
      }),
    ])
    if (details === undefined) {
      accountError = '账户查询超时'
      return null
    }
    if (details === null || details.status !== 'ready') {
      accountError = details === null ? '未登录平台账号' : '平台查询失败'
      return null
    }
    const wallets = []
    if (Array.isArray(details.value)) wallets.push(...details.value)
    if (Array.isArray(details.bonusWallets)) wallets.push(...details.bonusWallets)
    let total = 0
    let seen = false
    for (const wallet of wallets) {
      if (!wallet || wallet.currency !== 'CNY') continue
      const amount = Number(wallet.balance)
      if (!Number.isFinite(amount)) continue
      total += amount
      seen = true
    }
    if (!seen) {
      accountError = '未报告 CNY 钱包'
      return null
    }
    accountError = ''
    return total
  } catch (error) {
    accountError = '账户查询失败: ' + String((error && error.message) || error)
    return null
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * Read the official account balance in CNY, preferring the signed-in account
 * service and falling back to the API key on api.deepseek.com. Returns null
 * whenever neither source is authoritative — a non-official baseURL, no key, an
 * HTTP error or a timeout — and the caller then relies on the estimate alone.
 */
async function queryBalance(ctx) {
  keySource = ''
  accountError = ''
  sampleSource = ''
  const settings = ctx.get('settings')
  const section = settings && typeof settings.get === 'function' ? settings.get('llm-deepseek') : undefined
  const base = section && typeof section.baseURL === 'string' ? section.baseURL.trim() : ''
  if (base.length > 0 && !OFFICIAL_BASE.test(base)) {
    // A non-official baseURL means the inference traffic is not this account's, so
    // no balance reading is authoritative — the same rule as before, now applied
    // to the account source too.
    lastSampleError = 'llm-deepseek baseURL 不是官方 API'
    return null
  }
  const fromAccount = await officialBalance(ctx)
  if (fromAccount !== null) {
    keySource = 'deepseek-account'
    sampleSource = 'account'
    lastSampleError = ''
    return fromAccount
  }
  try {
    const key = await resolveKey(ctx)
    if (key.length === 0) return null
    const response = await fetch('https://api.deepseek.com/user/balance', {
      headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
      signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
    })
    if (!response.ok) {
      lastSampleError = 'HTTP ' + response.status
      return null
    }
    const data = await response.json()
    if (!data || !Array.isArray(data.balance_infos) || data.balance_infos.length === 0) {
      lastSampleError = '响应结构不符合预期'
      return null
    }
    let picked = null
    for (let i = 0; i < data.balance_infos.length; i += 1) {
      if (data.balance_infos[i] && data.balance_infos[i].currency === 'CNY') {
        picked = data.balance_infos[i]
        break
      }
    }
    if (picked === null) picked = data.balance_infos[0]
    const total = Number(picked.total_balance)
    if (!Number.isFinite(total)) {
      lastSampleError = 'total_balance 不是数字'
      return null
    }
    lastSampleError = ''
    sampleSource = 'api'
    return total
  } catch (error) {
    lastSampleError = String((error && error.message) || error)
    return null
  }
}

/** One sampling round: refresh the balance, re-decide the gate. */
async function sample(ctx) {
  // One round at a time: the account source can take seconds, and overlapping
  // rounds would double-sample and race on the shared state.
  if (sampling) return
  sampling = true
  const startedAt = Date.now()
  let total = null
  try {
    total = await queryBalance(ctx)
  } finally {
    sampling = false
  }
  const now = Date.now()
  // Readability is per round. A sticky `true` meant one success hid a dead
  // balance source from the client's blind-guard warning for the rest of the run.
  balanceReadable = total !== null
  if (total !== null) {
    lastBalance = total
    // A reading describes the account when the query was issued, not when it
    // answered, so a slow source cannot stamp stale data with a fresh time.
    lastSampleAt = startedAt
    samples.push({ at: startedAt, balance: total, src: sampleSource })
    pruneList(samples, now - WINDOW_MS - 3 * SAMPLE_MS)
    if (samples.length === 1) {
      console.log('[turn-budget] balance source: ' + (sampleSource || keySource) + ' -> CNY ' + total.toFixed(2))
    }
  }
  // Even when the balance is unavailable the estimate must still be able to age
  // out and reopen the gate.
  evaluate(now)
}

function snapshot(ctx) {
  const now = Date.now()
  const balance = balanceDropIn(now)
  const band = bandOf(now)
  return {
    band: band.peak ? 'peak' : 'idle',
    /** Holiday awareness: loaded year, coverage end, days left, today's holiday. */
    holidayTable: holidayStatus(now),
    windowMinutes: WINDOW_MINUTES,
    estimateLimit: estimateLimit,
    estimateLimitDefault: ESTIMATE_LIMIT_DEFAULT,
    balanceLimit: balanceLimit,
    balanceLimitDefault: BALANCE_LIMIT_DEFAULT,
    limitMax: LIMIT_MAX,
    balance: lastBalance,
    balanceReadable: balanceReadable,
    balanceError: lastSampleError,
    keySource: keySource,
    /** Which source produced the newest sample: 'account' | 'api' | ''. */
    sampleSource: sampleSource,
    /** Why the account source produced nothing this round ('' when it answered). */
    accountError: accountError,
    credentialsVisible: credentialsVisible,
    lastSampleAt: lastSampleAt,
    sampleCount: samples.length,
    cost: costSpendIn(now),
    balanceDrop: balance === null ? null : balance.drop,
    balanceFull: balance === null ? false : balance.full,
    halted: halted,
    haltReason: haltReason,
    haltAt: haltAt,
    parked: waiters.length,
  }
}

/** Register the same-origin endpoints the bundled Client half polls. */
function registerHttpEndpoints(ws, ctx) {
  if (!ws || typeof ws.register !== 'function') return
  const sendJson = (res, code, body) => {
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(body))
  }
  return ws.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (req, res) => {
      try {
        const url = String(req.url || '/')
        const raw = url.split('?')[0]
        const path = raw.length > 1 ? raw.replace(/\/+$/, '') : raw
        const query = new URLSearchParams(url.split('?')[1] || '')
        if (path === ROUTE_PREFIX + '/state') {
          sendJson(res, 200, snapshot(ctx))
          return
        }
        if (req.method === 'POST' && (path === ROUTE_PREFIX + '/estimate-limit' || path === ROUTE_PREFIX + '/balance-limit')) {
          const value = Number(query.get('limit'))
          if (Number.isInteger(value) && value > 0 && value <= LIMIT_MAX) {
            if (path === ROUTE_PREFIX + '/estimate-limit') estimateLimit = value
            else balanceLimit = value
            saveConfig()
            evaluate(Date.now())
          }
          sendJson(res, 200, snapshot(ctx))
          return
        }
        if (req.method === 'POST' && path === ROUTE_PREFIX + '/reset-limit') {
          // Restore only the thresholds. Window data is deliberately left alone:
          // wiping it would silently weaken the guard.
          estimateLimit = ESTIMATE_LIMIT_DEFAULT
          balanceLimit = BALANCE_LIMIT_DEFAULT
          saveConfig()
          evaluate(Date.now())
          sendJson(res, 200, snapshot(ctx))
          return
        }
        if (req.method === 'POST' && path === ROUTE_PREFIX + '/resume') {
          const now = Date.now()
          samples.length = 0
          // Keep the source tag: an untagged rebase sample would break the
          // same-source grouping in balanceDropIn, so the drop would read as
          // unknown until two fresh same-source samples arrived.
          if (lastBalance !== null) samples.push({ at: now, balance: lastBalance, src: sampleSource })
          costEvents.length = 0
          halted = false
          haltReason = ''
          haltAt = 0
          console.log('[turn-budget] manual resume: window rebased to now')
          flushWaiters()
          sendJson(res, 200, snapshot(ctx))
          return
        }
        if (req.method === 'POST' && path === ROUTE_PREFIX + '/signin') {
          // Start (or join) the official DeepSeek account authorization attempt and
          // return the URL the user must open. The account provider registers its
          // callback on this same web server, so the origin the browser used for
          // THIS request is the right callbackOrigin.
          const account = ctx.get('deepseekAccount')
          if (!account || typeof account.startSignIn !== 'function') {
            sendJson(res, 503, { error: '账户服务不可用' })
            return
          }
          const host = String(req.headers.host || '')
          const origin = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)
            ? 'http://' + host
            : 'http://127.0.0.1:3080'
          account.startSignIn(
            {
              version: '1.0.0',
              locale: 'zh-CN',
              timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
            },
            origin,
            'web',
          ).then(
            (view) => {
              const attempt = view && view.attempt ? view.attempt : null
              sendJson(res, 200, {
                ok: true,
                callbackOrigin: origin,
                status: view && view.status ? view.status : null,
                phase: attempt && attempt.phase ? attempt.phase : null,
                url: attempt && typeof attempt.authorizeUrl === 'string' ? attempt.authorizeUrl : null,
                expiresAt: attempt && typeof attempt.expiresAt === 'number' ? attempt.expiresAt : null,
              })
            },
            (error) => {
              sendJson(res, 500, { error: String((error && error.message) || error) })
            },
          )
          return
        }
        if (req.method === 'POST' && path === ROUTE_PREFIX + '/selftest') {
          // Deliberately shut the gate for a few seconds so the NEXT model request
          // parks. That is the only way to prove the llm/stream gate really holds
          // requests: a gate that silently stopped firing looks exactly like a
          // healthy one. It restores whatever was there before, so a real breach is
          // never cleared by a self-test.
          const seconds = Math.min(Math.max(Number(query.get('seconds')) || 15, 1), 60)
          const wasHalted = halted
          const prevReason = haltReason
          const prevAt = haltAt
          if (!wasHalted) {
            halted = true
            haltReason = '自检：人为关闸 ' + seconds + ' 秒（验证请求是否真被挂起）'
            haltAt = Date.now()
          }
          console.log('[turn-budget] selftest: gate shut for ' + seconds + 's')
          setTimeout(() => {
            if (wasHalted) {
              haltReason = prevReason
              haltAt = prevAt
            } else {
              halted = false
              haltReason = ''
              haltAt = 0
            }
            evaluate(Date.now())
            flushWaiters()
            console.log('[turn-budget] selftest: gate released')
          }, seconds * 1000)
          sendJson(res, 200, { ok: true, seconds: seconds, alreadyHalted: wasHalted })
          return
        }
        sendJson(res, 404, { error: 'unknown turn-budget endpoint: ' + path })
      } catch (error) {
        sendJson(res, 500, { error: String((error && error.message) || error) })
      }
    },
  })
}

export function apply(ctx) {
  loadConfig()

  // The holiday table is bundled rather than fetched: the State Council publishes
  // a year's arrangement months in advance, so an offline table beats another
  // network dependency. `holidayTable.stale` in the snapshot marks the renewal
  // window instead.
  const holidays = holidayStatus(Date.now())
  console.log('[turn-budget] holidays: ' + holidays.year + ' through ' + holidays.coverageEnd +
    (holidays.stale ? ' (almost out of date — update the plugin)' : ''))

  // Cost estimate: fold every session's billed steps (parents and children).
  ctx.on('session/event', (session, event) => {
    if (!session || !event || !event.data) return
    const data = event.data
    if (event.type === 'request/header') {
      const config = data.header ? data.header.config : undefined
      const model = config ? config.model : undefined
      if (typeof model === 'string' && model.length > 0) models[session.id] = model
      return
    }
    if (event.type !== 'assistant/message') return
    const usage = data.usage
    if (!usage) return
    const time = isNum(event.time) && event.time > 0 ? event.time : Date.now()
    const prices = priceOf(laneOf(models[session.id]), bandOf(time).peak)
    const hit = isNum(usage.cacheReadTokens) && usage.cacheReadTokens > 0 ? usage.cacheReadTokens : 0
    const input = isNum(usage.inputTokens) && usage.inputTokens > 0 ? usage.inputTokens : 0
    // Prefer the explicit uncached count. Subtracting `hit` from `input` is only
    // correct while `inputTokens` is the whole prompt: if the runtime reports it
    // as already-uncached input, the subtraction goes negative and clamps to zero,
    // silently dropping every input token from the estimate.
    const miss = isNum(usage.uncachedInputTokens) && usage.uncachedInputTokens > 0
      ? usage.uncachedInputTokens
      : (input > hit ? input - hit : 0)
    const out = isNum(usage.outputTokens) && usage.outputTokens > 0 ? usage.outputTokens : 0
    costEvents.push({ at: time, cost: (hit * prices.hit + miss * prices.miss + out * prices.out) / 1e6 })
    const now = Date.now()
    pruneList(costEvents, now - WINDOW_MS)
    evaluate(now)
  })

  // Enforcement: every streaming model call in the process parks here while the
  // breaker is open. Nothing is dropped and nothing is sent.
  ctx.on('llm/stream', (options, next) => {
    return (async function* gated() {
      await waitForGate(options ? options.signal : undefined)
      const stream = await next()
      for await (const chunk of stream) yield chunk
    })()
  })

  // Balance polling. Owned by this fiber, so it stops with the plugin.
  ctx.effect(() => {
    let closed = false
    const round = () => {
      if (closed) return
      void sample(ctx).catch((error) => {
        console.error('[turn-budget] sample failed: ' + String((error && error.message) || error))
      })
    }
    round()
    const handle = setInterval(round, SAMPLE_MS)
    // Separate clock: re-decide the gate every 30s (no network) so a halt still
    // releases promptly now that the balance is only sampled every 2 minutes.
    const gateHandle = setInterval(() => {
      if (!closed) evaluate(Date.now())
    }, EVALUATE_MS)
    return () => {
      closed = true
      clearInterval(handle)
      clearInterval(gateHandle)
    }
  })

  // The plugin row injects no webServer dependency, so apply() may run before the
  // web carrier is registered; ctx.inject waits for it in that case.
  const webServer = ctx.get('webServer')
  if (webServer && typeof webServer.register === 'function') {
    ctx.effect(() => registerHttpEndpoints(webServer, ctx))
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (sub) => {
      sub.effect(() => registerHttpEndpoints(sub.get('webServer'), ctx))
    })
  }
}
