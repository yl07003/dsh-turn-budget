// Regression test: peak/off-peak must exclude the bundled statutory holidays.
// bandOf is extracted VERBATIM from index.js, so a logic bug fails here.
import { readFileSync } from 'node:fs'
const FILE = new URL('./index.js', import.meta.url)
const src = readFileSync(FILE, 'utf8')
const HOLIDAYS = {}
for (const m of src.matchAll(/'(\d{4}-\d\d-\d\d)':/g)) HOLIDAYS[m[1]] = 'x'
const i = src.indexOf('function bandOf(ms) {')
const body = src.slice(i, src.indexOf('\n}', i) + 2)
const MS_HOUR = 3600000, MS_DAY = 86400000, MS_MINUTE = 60000
function isNum(v) { return typeof v === 'number' && Number.isFinite(v) }
function floorPos(v) { const f = v % 1; return v - (f < 0 ? f + 1 : f) }
const bandOf = eval('(' + body + ')')
const at = (d, t) => Date.parse(d + 'T' + t + ':00+08:00')
const dow = (d) => new Date(d + 'T00:00:00Z').getUTCDay()
let fail = 0
const ck = (n, got, want) => { if (got !== want) { fail++; console.log('FAIL  ' + n + '  got=' + got + ' want=' + want) } }
const days = Object.keys(HOLIDAYS)
let weekdayHolidays = 0
for (const d of days) {
  if (dow(d) >= 1 && dow(d) <= 5) weekdayHolidays++
  ck('holiday ' + d + ' 10:00', bandOf(at(d, '10:00')).peak, false)
  ck('holiday ' + d + ' 15:00', bandOf(at(d, '15:00')).peak, false)
}
ck('holiday entries present', days.length > 0, true)
ck('table has weekday holidays', weekdayHolidays > 10, true)
for (const d of ['2026-03-10', '2026-07-15', '2026-11-18', '2026-12-09']) {
  const wd = dow(d)
  ck('normal ' + d + ' 10:00', bandOf(at(d, '10:00')).peak, wd >= 1 && wd <= 5)
  ck('normal ' + d + ' 12:30', bandOf(at(d, '12:30')).peak, false)
  ck('normal ' + d + ' 20:00', bandOf(at(d, '20:00')).peak, false)
}
ck('2027 falls back to weekday rule', bandOf(at('2027-02-17', '10:00')).peak, dow('2027-02-17') >= 1 && dow('2027-02-17') <= 5)
console.log('holiday entries: ' + days.length + ', weekday holidays: ' + weekdayHolidays)
console.log(fail === 0 ? 'ALL PASS' : fail + ' FAILURE(S)')
process.exit(fail === 0 ? 0 : 1)