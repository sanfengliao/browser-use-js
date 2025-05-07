import { execSync } from 'node:child_process'

interface ScreenResolution {
  width: number
  height: number
}

export function getWindowAdjustments(): [number, number] {
  /** Returns recommended x, y offsets for window positioning */
  const platform = process.platform

  if (platform === 'darwin') { // macOS
    return [-4, 24] // macOS has a small title bar, no border
  }
  else if (platform === 'win32') { // Windows
    return [-8, 0] // Windows has a border on the left
  }
  else { // Linux
    return [0, 0]
  }
}

// 替代实现，使用系统命令
export function getScreenResolution(): ScreenResolution {
  const platform = process.platform

  try {
    if (platform === 'darwin') {
      const output = execSync('system_profiler SPDisplaysDataType | grep Resolution').toString()
      const match = output.match(/Resolution: (\d+) x (\d+)/)
      if (match) {
        return { width: Number.parseInt(match[1]), height: Number.parseInt(match[2]) }
      }
    }
    else if (platform === 'linux') {
      const output = execSync('xrandr | grep "*"').toString()
      const match = output.match(/(\d+)x(\d+)/)
      if (match) {
        return { width: Number.parseInt(match[1]), height: Number.parseInt(match[2]) }
      }
    }
    else if (platform === 'win32') {
      const output = execSync('wmic path Win32_VideoController get CurrentHorizontalResolution,CurrentVerticalResolution').toString()
      const lines = output.trim().split('\n')
      if (lines.length > 1) {
        const values = lines[1].trim().split(/\s+/)
        return { width: Number.parseInt(values[0]), height: Number.parseInt(values[1]) }
      }
    }
  }
  catch (e) {
    console.error('Failed to get screen resolution via command:', e)
  }

  // 默认分辨率
  return { width: 1920, height: 1080 }
}

// 在ESM中判断是否为直接执行的顶层模块
// 通过比较当前模块的URL和进程的入口点来判断
if (import.meta.url === (process.argv[1] ? new URL(`file://${process.argv[1]}`).href : undefined)) {
  const resolution = getScreenResolution()
  console.log(`Screen resolution: ${resolution.width}x${resolution.height}`)
}
