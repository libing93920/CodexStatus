// 手动验证 1/7/30 天 token 用量聚合:直连 usage.ts 纯函数,打印真实 sessions 数据
// 用法:node --experimental-strip-types scripts/usage-verify.mjs
import { getTokenUsage } from '../src/main/services/usage.ts'

for (const window of ['1d', '7d', '30d']) {
  const overview = await getTokenUsage(window)
  console.log(`\n=== ${window} ===`)
  console.log('available:', overview.available)
  console.log('totals:', overview.totals)
  console.log('non-zero days:')
  for (const day of overview.days) {
    if (day.input > 0 || day.output > 0) {
      console.log(
        `  ${day.date}: in=${day.input} cached=${day.cachedInput} ` +
          `out=${day.output} reasoning=${day.reasoning} $${day.cost}`
      )
    }
  }
  if (!overview.days.some((d) => d.input > 0 || d.output > 0)) {
    console.log('  (无数据)')
  }
}
