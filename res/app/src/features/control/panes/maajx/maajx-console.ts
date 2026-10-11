import {appState} from '@/core/app-state'

/** 云控协议的服务端侧镜像；字段含义见 lib/units/maajx/protocol.ts */
export interface MaajxTask {
  name: string
  entry: string
}

export interface MaajxState {
  deviceId: string
  running: boolean
  status: string
  entry: string
  shortSide: number | null
  online: boolean
  tasks: MaajxTask[]
  logEnabled: boolean
}

export interface MaajxDevice {
  deviceId: string
  name: string
  model: string
  serial: string
  androidVersion: string
  appVersion: string
  online: boolean
  lastSeenAt: number
  state: MaajxState
}

export interface CommandResult {
  commandId: string
  command: string
  ok: boolean
  message: string
}

interface ConsoleMessage {
  type: string
  deviceId: string
  payload: Record<string, any>
}

const RECONNECT_MIN_MILLIS = 1000
const RECONNECT_MAX_MILLIS = 15000

/** 只留最近这些行，长跑任务不至于把浏览器拖垮 */
export const MAX_LOG_LINES = 2000

export function maajxEnabled(): boolean {
  return Boolean(appState.config.maajxUrl)
}

/**
 * 认领：STF 按 adb 串号认设备，云控按它上报的 serial 认。
 *
 * 上报空串的设备一律不认 —— 那是「没取到 serial」，不是「serial 就是空」，
 * 放它进来会让多台没上报的机器抢到同一个 STF 设备上。
 */
export function claimDevice(devices: MaajxDevice[], serial: string): MaajxDevice | undefined {
  return devices.find((device) => Boolean(device.serial) && device.serial === serial)
}

/**
 * 云控控制台连接
 *
 * 握手靠一次性票据：GET 同源的 /maajx/api/console-ticket 换票，再用它连 WS。
 * 共享令牌留在服务端，浏览器从头到尾看不到。
 */
export class MaajxConsole {
  private socket: WebSocket | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private attempts = 0
  private watched = ''

  onDevices: (devices: MaajxDevice[]) => void = () => undefined
  onState: (deviceId: string, state: MaajxState) => void = () => undefined
  onLogs: (deviceId: string, lines: string[]) => void = () => undefined
  onCommandResult: (result: CommandResult) => void = () => undefined
  onConnectionChange: (connected: boolean) => void = () => undefined

  constructor(private readonly base: string) {}

  start() {
    this.stopped = false
    this.open()
  }

  stop() {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }

    const socket = this.socket
    this.socket = null
    this.watched = ''
    socket?.close()
  }

  /** 只观看一台设备（就是当前这台 adb 设备），换设备时自动退掉上一台 */
  watch(deviceId: string) {
    if (this.watched === deviceId) {
      return
    }

    if (this.watched) {
      this.send({type: 'unwatch', deviceId: this.watched, payload: {}})
    }

    this.watched = deviceId
    this.send({type: 'watch', deviceId, payload: {}})
  }

  command(deviceId: string, command: string, args: Record<string, unknown> = {}) {
    this.send({type: 'command', deviceId, payload: {command, args}})
  }

  /** 日志接收开关：关掉后服务端直接丢弃该设备的上行日志 */
  setLogEnabled(deviceId: string, enabled: boolean) {
    this.send({type: 'setLog', deviceId, payload: {enabled}})
  }

  private async open() {
    if (this.stopped) {
      return
    }

    let ticket: string
    try {
      const response = await fetch(`${this.base}/api/console-ticket`, {credentials: 'same-origin'})
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const body = await response.json()
      ticket = body.ticket
      if (!ticket) {
        throw new Error('empty ticket')
      }
    }
    catch (err) {
      this.retry()
      return
    }

    if (this.stopped) {
      return
    }

    const url = new URL(`${this.base}/ws/console`, window.location.href)
    url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('ticket', ticket)

    const socket = new WebSocket(url.toString())
    this.socket = socket
    socket.addEventListener('open', () => {
      this.attempts = 0
      this.onConnectionChange(true)
    })
    socket.addEventListener('message', (event) => {
      this.handle(String(event.data))
    })
    socket.addEventListener('close', () => {
      this.onConnectionChange(false)
      this.retry()
    })
    socket.addEventListener('error', () => socket.close())
  }

  private retry() {
    if (this.stopped || this.timer) {
      return
    }

    const delay = Math.min(RECONNECT_MIN_MILLIS * Math.pow(2, this.attempts), RECONNECT_MAX_MILLIS)
    this.attempts += 1
    this.timer = setTimeout(() => {
      this.timer = null
      this.open()
    }, delay)
  }

  private send(message: ConsoleMessage) {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return
    }

    this.socket.send(JSON.stringify(message))
  }

  private handle(text: string) {
    let message: ConsoleMessage
    try {
      message = JSON.parse(text)
    }
    catch (err) {
      return
    }

    if (!message || typeof message.type !== 'string') {
      return
    }

    switch (message.type) {
    case 'devices':
      this.onDevices(Array.isArray(message.payload?.devices) ? message.payload.devices : [])
      break
    case 'state':
      this.onState(message.deviceId, message.payload as MaajxState)
      break
    case 'logs':
      if (Array.isArray(message.payload?.lines)) {
        this.onLogs(message.deviceId, message.payload.lines)
      }

      break
    case 'commandResult':
      this.onCommandResult({
        commandId: message.payload?.commandId || ''
      , command: message.payload?.command || ''
      , ok: message.payload?.ok === true
      , message: message.payload?.message || ''
      })
      break
    default:
      break
    }
  }
}
