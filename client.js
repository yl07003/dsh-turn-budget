/**
 * dsh-turn-budget — Client half (browser bundle).
 *
 * The Web shell serves this file at /plugins/dsh-turn-budget/client.js because
 * package.json declares dsh.client + exports["./client"]; the browser mounts it
 * on startup — no dynamic-plugin step or approval needed.
 *
 * It renders the breaker under the composer (conversation.composer.dock): the
 * current pricing band (谷时 light green / 峰时 orange-red), the live official
 * balance, both window readings against their own thresholds (real balance drop
 * and the faster token estimate), one fill-in per threshold, a reset-to-default,
 * and a manual release. State and writes go to the Host half's same-origin
 * /turn-budget/* endpoints.
 */
window.__ModuleLoader__.load({
  id: 'dsh-turn-budget',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    var plugin = (() => {
      const S_ROW = {
        // The row itself spans the composer width (see the injected layout CSS);
        // centring its *content* is what lines the badge/readings/controls up with
        // the composer axis instead of hugging the left edge.
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center',
        gap: '8px',
        padding: '4px 8px', fontSize: '12px', lineHeight: '18px',
        color: 'var(--dsw-alias-label-secondary)',
      }
      const S_STRONG = { color: 'var(--dsw-alias-label-primary)', fontWeight: 600 }
      const S_CHIP = { padding: '0 6px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '999px' }
      // Pricing band badge: 谷时 (off-peak, half price) light green, 峰时 (peak)
      // orange-red. Semi-transparent backgrounds keep the badge readable on both
      // the light and the dark theme; the label colour comes from a theme token.
      const S_BAND_IDLE = Object.assign({}, S_CHIP, {
        background: 'rgba(82, 196, 26, 0.16)',
        borderColor: 'rgba(82, 196, 26, 0.45)',
        // Back to the theme's success green (user 2026-09-28): the hardcoded
        // #006400 read too dark on this light-green background.
        color: 'var(--dsw-alias-state-success-primary)',
        fontWeight: 600,
      })
      const S_BAND_PEAK = Object.assign({}, S_CHIP, {
        background: 'rgba(255, 122, 69, 0.18)',
        borderColor: 'rgba(255, 122, 69, 0.5)',
        color: 'var(--dsw-alias-state-error-primary)',
        fontWeight: 600,
      })
      const S_INPUT = {
        width: '24px', padding: '1px 3px', font: 'inherit',
        color: 'var(--dsw-alias-label-primary)', background: '#FFF8DD',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '6px',
        textAlign: 'center',
      }
      // When the balance comes from the API-key fallback instead of the signed-in
      // platform account, the numeric readouts turn deep purple: it is the only
      // on-screen signal that the reading is not the account's own.
      // Only the balance *number* carries the source colour: dark green for the
      // signed-in platform account, deep purple for the API-key fallback. Every
      // other number keeps its own styling — the thresholds are user settings and
      // do not depend on where the balance came from.
      const S_ACCOUNT_COLOR = { color: '#006400' }
      const S_API_COLOR = { color: '#C701FF' }
      // Balance-amount tints on the chip itself (user rule 2026-09-28): plenty of
      // headroom reads calm green, a thin margin warns yellow, and under ¥10
      // reuses the peak badge's orange-red so it reads as an alarm.
      const S_BAL_OK = { background: 'rgba(82, 196, 26, 0.16)' }    // >= ¥50（与"谷"徽章同底色）
      const S_BAL_MID = { background: '#FFF9DB' }                   // >= ¥10 and < ¥50
      const S_BAL_LOW = { background: 'rgba(255, 122, 69, 0.18)' }  // < ¥10（与峰时徽章同色）
      const S_BUTTON = {
        font: 'inherit', color: 'inherit', background: '#E7EFFA',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '6px',
        // Narrow side padding (was 8px) keeps the four controls on one line in a
        // narrow composer; the labels stay as they are on purpose.
        padding: '1px 5px', cursor: 'pointer',
      }
      // The controls live in their own block so their spacing can be tighter than
      // the readings' (the row gap is 8px) without crowding the reading line.
      const S_CONTROLS = {
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '3px',
      }
      const S_ERROR = { color: 'var(--dsw-alias-state-error-primary)' }
      const S_WARN = { color: 'var(--dsw-alias-state-warn-primary)' }

      function createView(timer) {
        return function SpendBreaker(props) {
          const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
          const [state, setState] = React.useState(null)
          const [estimateDraft, setEstimateDraft] = React.useState('')
          const [balanceDraft, setBalanceDraft] = React.useState('')
          const [error, setError] = React.useState('')

          React.useEffect(() => {
            let live = true
            const encoded = encodeURIComponent(sessionId)
            const pull = () => {
              fetch('/turn-budget/state?sessionId=' + encoded, { cache: 'no-store' })
                .then((res) => (res.ok ? res.json() : null))
                .then((value) => {
                  if (live && value !== null && typeof value === 'object') setState(value)
                })
                .catch((reason) => {
                  console.error('[turn-budget] state request failed', reason)
                })
            }
            pull()
            const dispose = timer.interval(pull, 1500)
            return () => {
              live = false
              if (typeof dispose === 'function') dispose()
            }
          }, [sessionId])

          const minutes = state !== null && typeof state.windowMinutes === 'number' ? state.windowMinutes : 6
          const estimateCap = state === null || typeof state.estimateLimit !== 'number' ? 7 : state.estimateLimit
          const balanceCap = state === null || typeof state.balanceLimit !== 'number' ? 10 : state.balanceLimit
          const maxLimit = state !== null && typeof state.limitMax === 'number' ? state.limitMax : 100000

          const post = (action, extra) => {
            const query = 'sessionId=' + encodeURIComponent(sessionId) + (extra === undefined ? '' : extra)
            return fetch('/turn-budget/' + action + '?' + query, { method: 'POST', cache: 'no-store' })
              .then((res) => (res.ok ? res.json() : null))
          }
          const settle = (next) => {
            if (next !== null && typeof next === 'object') setState(next)
          }
          const commit = (action, raw, label, clear) => {
            const value = +raw.trim()
            if (!Number.isInteger(value) || value <= 0 || value > maxLimit) {
              setError(label + '需要 1-' + maxLimit + ' 之间的整数')
              return
            }
            setError('')
            post(action, '&limit=' + value).then((next) => {
              settle(next)
              clear('')
            }).catch((reason) => {
              setError(label + '设置失败')
              console.error('[turn-budget] ' + action + ' failed', reason)
            })
          }
          const saveEstimate = () => commit('estimate-limit', estimateDraft, '估算阈值', setEstimateDraft)
          const saveBalance = () => commit('balance-limit', balanceDraft, '余额阈值', setBalanceDraft)
          const restoreDefault = () => {
            setError('')
            post('reset-limit').then((next) => {
              settle(next)
              setEstimateDraft('')
              setBalanceDraft('')
            }).catch((reason) => {
              setError('重置失败')
              console.error('[turn-budget] reset-limit failed', reason)
            })
          }
          const release = () => {
            setError('')
            post('resume').then(settle).catch((reason) => {
              setError('解除失败')
              console.error('[turn-budget] resume failed', reason)
            })
          }

          if (sessionId.length === 0) return null

          const band = state !== null && typeof state.band === 'string' ? state.band : ''
          const isPeak = band === 'peak'
          // Holiday-table status rides the badge tooltip only: the badge itself
          // stays a single character, so the confirmed layout is untouched.
          const holiday = state === null || state.holidayTable === undefined ? null : state.holidayTable
          const holidayNote = holiday === null
            ? ''
            : '。假期表：' + holiday.year + ' 年度（截至 ' + holiday.coverageEnd +
              (holiday.stale === true ? '，⚠ 即将到期，请更新插件' : '') + '）' +
              (typeof holiday.today === 'string' ? '；今天是' + holiday.today + '，按谷时计费' : '')
          const balance = state === null ? null : state.balance
          const readable = state !== null && state.balanceReadable === true
          const balanceError = state !== null && typeof state.balanceError === 'string' ? state.balanceError : ''
          // Which balance source produced the reading: 'account' = the signed-in
          // platform account, 'api' = the API-key fallback.
          const src = state === null || typeof state.sampleSource !== 'string' ? '' : state.sampleSource
          const balanceTint = src === 'account' ? S_ACCOUNT_COLOR : (src === 'api' ? S_API_COLOR : undefined)
          const cost = state === null || typeof state.cost !== 'number' ? 0 : state.cost
          const drop = state === null || state.balanceDrop === null || typeof state.balanceDrop !== 'number' ? null : state.balanceDrop
          const full = state !== null && state.balanceFull === true
          const halted = state !== null && state.halted === true
          const reason = state !== null && typeof state.haltReason === 'string' ? state.haltReason : ''
          const parked = state === null || typeof state.parked !== 'number' ? 0 : state.parked

          const dropText = drop === null
            ? (readable ? '—' : '不可用')
            : (drop >= 0 ? drop.toFixed(2) : '+' + (-drop).toFixed(2))

          const children = []
          if (band.length > 0) {
            children.push(React.createElement('span', {
              key: 'band',
              style: isPeak ? S_BAND_PEAK : S_BAND_IDLE,
              title: (isPeak
                ? '当前计费时段：峰时（北京时间周一至周五 09:00-12:00 / 14:00-18:00，标准单价）'
                : '当前计费时段：谷时（空闲时段，单价减半）') + holidayNote,
            }, isPeak ? '峰' : '谷'))
          }
          children.push(
            React.createElement('span', {
              key: 'balance',
              // Amount tiers ride the chip background; the number keeps its own
              // source colour (green = account, purple = API fallback).
              style: typeof balance !== 'number'
                ? S_CHIP
                : Object.assign({}, S_CHIP, balance >= 50 ? S_BAL_OK : (balance >= 10 ? S_BAL_MID : S_BAL_LOW)),
            },
              '余额 ',
              React.createElement('b', { key: 'v', style: balanceTint },
                balance === null || typeof balance !== 'number' ? '不可用' : balance.toFixed(2))),
            React.createElement('span', {
              key: 'drop',
              // The window-not-full note used to be inline text; it sat far from
              // the input box, so it now lives on hover instead (same signal, no
              // layout width).
              title: full ? undefined : '窗口未满 ' + minutes + ' 分钟：余额跌幅是"从最早样本到现在"的区间，只会少报不会虚报',
            },
              '最近' + minutes + 'min 估算 ',
              React.createElement('b', { style: cost >= estimateCap ? S_ERROR : S_STRONG },
                cost.toFixed(2) + ' / ' + String(estimateCap)),
              ' · 真实 ',
              React.createElement('b', { style: drop !== null && drop >= balanceCap ? S_ERROR : S_STRONG },
                dropText + ' / ' + String(balanceCap))),
            React.createElement('span', { key: 'controls', style: S_CONTROLS },
              React.createElement('span', { key: 'edit-estimate' },
                React.createElement('input', {
                  style: S_INPUT,
                  type: 'text',
                  inputMode: 'decimal',
                  value: estimateDraft,
                  placeholder: String(estimateCap),
                  'aria-label': '估算阈值（元）',
                  onChange: (event) => setEstimateDraft(event.target.value),
                  onKeyDown: (event) => { if (event.key === 'Enter') saveEstimate() },
                }),
                React.createElement('button', { type: 'button', style: S_BUTTON, onClick: saveEstimate }, '估算阈值')),
              React.createElement('span', { key: 'edit-balance' },
                React.createElement('input', {
                  style: S_INPUT,
                  type: 'text',
                  inputMode: 'decimal',
                  value: balanceDraft,
                  placeholder: String(balanceCap),
                  'aria-label': '余额阈值（元）',
                  onChange: (event) => setBalanceDraft(event.target.value),
                  onKeyDown: (event) => { if (event.key === 'Enter') saveBalance() },
                }),
                React.createElement('button', { type: 'button', style: S_BUTTON, onClick: saveBalance }, '余额阈值')),
              React.createElement('button', { key: 'default', type: 'button', style: S_BUTTON, onClick: restoreDefault }, '重置默认'),
              React.createElement('button', { key: 'release', type: 'button', style: S_BUTTON, onClick: release }, '解除暂停')),
          )

          if (error.length > 0) {
            children.push(React.createElement('span', { key: 'err', style: S_ERROR }, error))
          }
          if (halted) {
            children.push(React.createElement('span', { key: 'halt', style: S_ERROR },
              '已强制暂停所有对话：' + reason +
              '；等 ' + minutes + ' 分钟窗口滑过会自动恢复' +
              (parked > 0 ? '（已挂起 ' + parked + ' 个模型请求）' : '') + '。'))
          } else if (!readable) {
            children.push(React.createElement('span', { key: 'blind', style: S_WARN },
              '读不到账户余额' + (balanceError.length > 0 ? '（' + balanceError + '）' : '') +
              '，目前只按 token 估算拦截——抗突发能力会弱一些。'))
          }
          return React.createElement('div', { style: S_ROW, 'data-dsh-turn-budget': '' }, children)
        }
      }

      return {
        inject: ['timer'],
        apply(ctx) {
          const slots = ctx.get('slots')
          if (slots === undefined || ctx.timer === undefined) {
            console.error('[turn-budget] client apply aborted: slots or timer unavailable')
            return
          }
          // The composer dock is a single-line (nowrap) flex row shared with the
          // shipped stats pills and the context meter, so a wide entry gets
          // squeezed. Claim a full line for our row and let the dock wrap, keyed
          // to our own marker attribute, so nothing else is restyled.
          ctx.effect(() => {
            if (typeof document === 'undefined') return () => {}
            if (document.querySelector('style[data-dsh-turn-budget-layout]') !== null) return () => {}
            const tag = document.createElement('style')
            tag.setAttribute('data-dsh-turn-budget-layout', '')
            // Layout, step by step:
            //  - the dock is a nowrap flex row, centred at its content width, so
            //    our row must claim a full line AND the dock must be pinned to the
            //    composer card width, or our row sits narrower than the input;
            //  - a list slot wraps its entries in a box that is not always the
            //    flex container laying them out, which leaves our flex-basis
            //    resolving against that box; making it boxless (`display:contents`)
            //    promotes the entries — and the context meter beside the slot —
            //    into the dock itself, which is what makes a clean break possible;
            //  - the context meter is a sibling of the slot, and the slot's own
            //    registration `order` is only a render order (the F12 dump shows
            //    our element computes to `order:0`), so a real CSS `order:1` is
            //    what keeps the meter — and the stats pills — on line one.
            // `box-sizing:border-box` matters: the row carries 8px of side padding,
            // and with the default content-box sizing a 100% basis plus that
            // padding rendered 16px wider than the dock, overhanging the input box
            // by 8px on each side.
            tag.textContent = '[data-dsh-turn-budget]{flex:1 1 100%;min-width:0;box-sizing:border-box;order:1}'
              + ':has(> [data-dsh-turn-budget]):not([class*="_dock"]){display:contents}'
              + ':has(> [data-dsh-turn-budget]){flex-wrap:wrap}'
              + '[class*="_dock"]:has([data-dsh-turn-budget]){flex-wrap:wrap;width:100%;max-width:var(--dsh-composer-card-max-width)}'
            document.head.appendChild(tag)
            return () => { tag.remove() }
          })
          const View = createView(ctx.timer)
          slots.inject('conversation.composer.dock', () => slots.register(
            // Render order inside the slot only. The line break itself comes from
            // the CSS `order:1` injected above, which keeps the shipped stats pills
            // and the context meter together on the first line.
            { name: 'conversation.composer.dock', id: 'turn-budget', order: 9999, label: '消费熔断' },
            (props) => React.createElement(View, { sessionId: props.sessionId }),
          ))
        },
      }
    })()
    exports.apply = plugin.apply
    exports.inject = plugin.inject
    return module.exports
  },
})
