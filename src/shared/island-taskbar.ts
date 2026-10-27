export interface WindowsTaskbarRect {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowsTaskbarGeometry {
  bounds: WindowsTaskbarRect
  notificationArea?: WindowsTaskbarRect
  visible: boolean
  autoHide: boolean
  dark?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isRect(value: unknown): value is WindowsTaskbarRect {
  if (!isRecord(value)) return false
  const { x, y, width, height } = value
  return (
    [x, y, width, height].every((item) => typeof item === 'number' && Number.isFinite(item)) &&
    (width as number) > 0 &&
    (height as number) > 0 &&
    Number.isFinite((x as number) + (width as number)) &&
    Number.isFinite((y as number) + (height as number))
  )
}

export function isWindowsTaskbarGeometry(value: unknown): value is WindowsTaskbarGeometry {
  if (!isRecord(value) || !isRect(value.bounds)) return false
  if (typeof value.visible !== 'boolean' || typeof value.autoHide !== 'boolean') return false
  if (value.dark !== undefined && typeof value.dark !== 'boolean') return false
  if (value.notificationArea === undefined) return true
  if (!isRect(value.notificationArea)) return false
  const { bounds, notificationArea } = value
  return (
    notificationArea.x >= bounds.x &&
    notificationArea.y >= bounds.y &&
    notificationArea.x + notificationArea.width <= bounds.x + bounds.width &&
    notificationArea.y + notificationArea.height <= bounds.y + bounds.height
  )
}
