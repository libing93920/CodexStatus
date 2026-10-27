const TASKBAR_COUNT_LIMIT = 99
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24
const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * MINUTES_PER_HOUR
const SECONDS_PER_DAY = SECONDS_PER_HOUR * HOURS_PER_DAY
const PADDED_COMPONENT_WIDTH = 2

export function formatTaskbarCount(count: number): string {
  return count <= TASKBAR_COUNT_LIMIT ? String(count) : `${TASKBAR_COUNT_LIMIT}+`
}

export function formatTaskbarDuration(seconds: number | undefined): string {
  if (seconds === undefined) return '--:--'

  if (seconds < SECONDS_PER_HOUR) {
    const minutes = Math.floor(seconds / SECONDS_PER_MINUTE)
    const remainingSeconds = seconds % SECONDS_PER_MINUTE
    const formattedMinutes = String(minutes).padStart(PADDED_COMPONENT_WIDTH, '0')
    const formattedSeconds = String(remainingSeconds).padStart(PADDED_COMPONENT_WIDTH, '0')
    return `${formattedMinutes}:${formattedSeconds}`
  }

  if (seconds < SECONDS_PER_DAY) {
    const hours = Math.floor(seconds / SECONDS_PER_HOUR)
    const minutes = Math.floor(seconds / SECONDS_PER_MINUTE) % MINUTES_PER_HOUR
    const formattedMinutes = String(minutes).padStart(PADDED_COMPONENT_WIDTH, '0')
    return `${hours}h${formattedMinutes}m`
  }

  const days = Math.floor(seconds / SECONDS_PER_DAY)
  const hours = Math.floor(seconds / SECONDS_PER_HOUR) % HOURS_PER_DAY
  return `${days}d${hours}h`
}
