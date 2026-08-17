// 手动验证 1/7/30 天三工具 token 用量聚合:直连 usage.ts,打印真实本地数据。
// 用法:node --experimental-strip-types scripts/usage-verify.mjs
import { getTokenUsage } from '../src/main/services/usage.ts'

const AGENTS = ['codex', 'claude', 'opencode']
const WINDOWS = ['1d', '7d', '30d']

for (const agent of AGENTS) {
  for (const window of WINDOWS) {
    const overview = await getTokenUsage(agent, window)
    console.log(`\n=== ${agent} ${window} ===`)
    console.log('available:', overview.available)
    console.log('totals:', JSON.stringify(overview.totals))
    const active = overview.days.filter((d) => d.input > 0 || d.output > 0)
    for (const day of active) {
      console.log(
        `  ${day.date}: in=${day.input} cached=${day.cachedInput} ` +
          `out=${day.output} reasoning=${day.reasoning} $${day.cost}`
      )
    }
    if (active.length === 0) {
      console.log('  (无数据)')
    }
  }
}
