// Regression test for the source-aware drop calculation.
// The function under test is extracted VERBATIM from index.js (no copy), so a
// logic bug in the real file fails this test.
import { readFileSync } from 'node:fs'

const FILE = new URL('./index.js', import.meta.url)
const src = readFileSync(FILE, 'utf8')
const at = src.indexOf('function balanceDropIn(now) {')
if (at < 0) throw new Error('balanceDropIn not found in ' + FILE)
const end = src.indexOf('\n}', at) + 2
const body = src.slice(at, end)

const WINDOW_MS = 6 * 60 * 1000
let samples = []
const balanceDropIn = eval('(' + body + ')')

let failures = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  if (!ok) failures += 1
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '\n      got ' + a + '\n      want ' + e))
}

// 1) A source switch must NOT look like spend: the newest sample is alone in its
//    source, so there is nothing to compare against -> null (never a halt).
samples = [
  { at: 0, balance: 100, src: 'api' },
  { at: WINDOW_MS + 1000, balance: 99, src: 'api' },
  { at: WINDOW_MS + 2000, balance: 50, src: 'account' },
]
check('source switch -> null (no false halt)', balanceDropIn(WINDOW_MS + 2000), null)

// 2) Same source, window full: the drop is measured across the window.
samples = [
  { at: 0, balance: 100, src: 'api' },
  { at: WINDOW_MS + 1000, balance: 95, src: 'api' },
]
check('same source full window -> drop 5', balanceDropIn(WINDOW_MS + 1000), {
  drop: 5, baseAt: 0, to: WINDOW_MS + 1000, full: true,
})

// 3) Short history: the baseline is the oldest sample and `full` is false, which
//    can only under-report.
samples = [
  { at: 0, balance: 100, src: 'api' },
  { at: 1000, balance: 99, src: 'api' },
]
check('short history -> drop 1, full false', balanceDropIn(1000), {
  drop: 1, baseAt: 0, to: 1000, full: false,
})

// 4) The real trap: an old api baseline of 100 and a new account reading of 49
//    must report 1 (the account pair), NOT 51 (the cross-source step).
samples = [
  { at: 0, balance: 100, src: 'api' },
  { at: 1000, balance: 99, src: 'api' },
  { at: 2000, balance: 50, src: 'account' },
  { at: 3000, balance: 49, src: 'account' },
]
check('cross-source step is ignored -> drop 1', balanceDropIn(3000), {
  drop: 1, baseAt: 2000, to: 3000, full: false,
})

// 5) Fewer than two samples overall.
samples = [{ at: 0, balance: 100, src: 'api' }]
check('single sample -> null', balanceDropIn(0), null)

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
