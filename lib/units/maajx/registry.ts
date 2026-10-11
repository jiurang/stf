/**
* 设备注册表与会话中心（MaaJxApp 云控）
*
* 记住谁在线、每台设备的状态摘要与任务清单，并负责把日志、帧、命令结果推给控制台。
* 只做状态与投递，不做业务判断（业务都在安卓端的 CloudCommandHandler 里）。
* 全部为内存态，进程重启即清空。
*/

import {randomBytes} from 'crypto'
import {WebSocket} from 'ws'
import logger from '../../util/logger.js'
import {
  COMMAND
, COMMAND_RESULT
, COMMANDS
, CONFIG
, HEARTBEAT
, HELLO
, LOGS
, envelope
, parse
, type Payload
} from './protocol.js'

type Logger = ReturnType<typeof logger.createLogger>

export interface DeviceTask {
  name: string
  entry: string
}

/** 云控视角下的一台设备。`serial` 是与 STF 设备列表对齐的唯一依据 */
export interface DeviceView {
  deviceId: string
  name: string
  model: string
  serial: string
  androidVersion: string
  appVersion: string
  online: boolean
  lastSeenAt: number
  state: DeviceStateView
}

export interface DeviceStateView {
  deviceId: string
  running: boolean
  status: string
  entry: string
  shortSide: number | null
  online: boolean
  tasks: DeviceTask[]
  logEnabled: boolean
}

class Device {
  public deviceId: string
  public name = ''
  public model = ''
  // `ro.serialno`：STF 侧按 adb 串号认设备，云控要认领到同一台就得报它
  public serial = ''
  public androidVersion = ''
  public appVersion = ''
  public online = false
  public lastSeenAt = 0
  public running = false
  public status = ''
  public entry = ''
  public shortSide: number | null = null
  public tasks: DeviceTask[] = []
  // 日志接收开关：关闭后服务端直接丢弃该设备上行的 logs，与其它上行互不影响
  public logEnabled = true
  public socket: WebSocket | null = null
  public watchers = new Set<WebSocket>()

  constructor(deviceId: string) {
    this.deviceId = deviceId
  }
}

function statePayload(device: Device): DeviceStateView {
  return {
    deviceId: device.deviceId
  , running: device.running
  , status: device.status
  , entry: device.entry
  , shortSide: device.shortSide
  , online: device.online
  , tasks: device.tasks
  , logEnabled: device.logEnabled
  }
}

function deviceView(device: Device): DeviceView {
  return {
    deviceId: device.deviceId
  , name: device.name
  , model: device.model
  , serial: device.serial
  , androidVersion: device.androidVersion
  , appVersion: device.appVersion
  , online: device.online
  , lastSeenAt: device.lastSeenAt
  , state: statePayload(device)
  }
}

function safeSend(socket: WebSocket, text: string) {
  if (socket.readyState !== WebSocket.OPEN) {
    return false
  }
  try {
    socket.send(text)
    return true
  }
  catch (err) {
    // 对端已断：交给 close 事件回收
    return false
  }
}

function safeSendBinary(socket: WebSocket, data: Buffer) {
  if (socket.readyState !== WebSocket.OPEN) {
    return false
  }
  try {
    socket.send(data)
    return true
  }
  catch (err) {
    // 同上
    return false
  }
}

function randomId() {
  return randomBytes(6).toString('hex')
}

export class MaajxRegistry {
  private log: Logger
  private devices = new Map<string, Device>()
  // serial -> deviceId：认领设备的首选依据，一台手机换名字也认得回来
  private serialToId = new Map<string, string>()
  // name -> deviceId：没有 serial 时的兜底，同型号多台时按名字认会认错
  private nameToId = new Map<string, string>()
  private consoles = new Set<WebSocket>()
  // commandId -> 发起命令的控制台连接，回执到了也好送回去（它可能没在观看）
  private pending = new Map<string, WebSocket>()

  constructor(log: Logger) {
    this.log = log
  }

  // ------------------------------------------------------------------
  // 注册与查询
  // ------------------------------------------------------------------

  registerDevice(input: Payload) {
    var name = typeof input.name === 'string' ? input.name.trim() : ''
    var serial = typeof input.serial === 'string' ? input.serial.trim() : ''
    if (!name) {
      name = 'unknown-' + randomId()
    }
    var existingId = serial ? this.serialToId.get(serial) : this.nameToId.get(name)
    var device = existingId ? this.devices.get(existingId) ?? null : null
    var reconnect = device !== null
    if (!device) {
      device = new Device('dev-' + randomId())
      device.name = name
      this.devices.set(device.deviceId, device)
      this.nameToId.set(name, device.deviceId)
    }
    device.serial = serial
    if (serial) {
      this.serialToId.set(serial, device.deviceId)
    }
    if (typeof input.model === 'string') {
      device.model = input.model
    }
    if (typeof input.androidVersion === 'string') {
      device.androidVersion = input.androidVersion
    }
    if (typeof input.appVersion === 'string') {
      device.appVersion = input.appVersion
    }
    device.lastSeenAt = Date.now()
    this.log.info('device %s: %s serial=%s model=%s android=%s app=%s'
      , reconnect ? 're-registered' : 'registered'
      , device.deviceId
      , device.serial || '-'
      , device.model
      , device.androidVersion
      , device.appVersion)
    this.broadcastDevices()
    return device.deviceId
  }

  has(deviceId: string) {
    return this.devices.has(deviceId)
  }

  /** 按 serial 找云控设备；STF 前端用它把当前 adb 设备对上号 */
  bySerial(serial: string) {
    var deviceId = this.serialToId.get(serial)
    return deviceId ? this.devices.get(deviceId) ?? null : null
  }

  deviceViews() {
    var list = Array.from(this.devices.values())
    list.sort(function(a, b) {
      return a.name.localeCompare(b.name) || a.deviceId.localeCompare(b.deviceId)
    })
    return list.map(deviceView)
  }

  // ------------------------------------------------------------------
  // 设备通道生命周期
  // ------------------------------------------------------------------

  deviceAttached(deviceId: string, socket: WebSocket) {
    var device = this.devices.get(deviceId)
    if (!device) {
      return false
    }
    device.socket = socket
    device.online = true
    device.lastSeenAt = Date.now()
    this.log.info('device %s channel attached', deviceId)
    this.broadcastDevices()
    this.broadcastState(device)
    return true
  }

  deviceDetached(deviceId: string, socket: WebSocket) {
    var device = this.devices.get(deviceId)
    if (!device || device.socket !== socket) {
      return
    }
    device.socket = null
    device.online = false
    this.log.info('device %s channel detached', deviceId)
    this.broadcastDevices()
    this.broadcastState(device)
  }

  // ------------------------------------------------------------------
  // 设备上行
  // ------------------------------------------------------------------

  handleDeviceText(deviceId: string, text: string) {
    var message = parse(text)
    if (!message) {
      return
    }
    var device = this.devices.get(deviceId)
    if (!device) {
      return
    }
    switch (message.type) {
    case HELLO:
      this.onHello(device, message.payload)
      break
    case HEARTBEAT:
    case CONFIG:
      this.applyState(device, message.payload)
      device.lastSeenAt = Date.now()
      this.broadcastState(device)
      break
    case LOGS:
      this.onLogs(device, message.payload)
      break
    case COMMAND_RESULT:
      this.onCommandResult(device, message.payload)
      break
    default:
      this.log.warn('device %s sent unknown type %s', deviceId, message.type)
      break
    }
  }

  /** 设备上行的 PNG 帧，只中继给正在观看该设备的控制台连接 */
  onFrame(deviceId: string, frame: Buffer) {
    var device = this.devices.get(deviceId)
    if (!device || frame.length === 0) {
      return
    }
    device.watchers.forEach(function(socket) {
      safeSendBinary(socket, frame)
    })
  }

  onHello(device: Device, payload: Payload) {
    if (typeof payload.model === 'string') {
      device.model = payload.model
    }
    if (typeof payload.serial === 'string' && payload.serial) {
      device.serial = payload.serial
      this.serialToId.set(payload.serial, device.deviceId)
    }
    if (typeof payload.androidVersion === 'string') {
      device.androidVersion = payload.androidVersion
    }
    if (typeof payload.appVersion === 'string') {
      device.appVersion = payload.appVersion
    }
    var tasks = payload.tasks
    if (Array.isArray(tasks)) {
      device.tasks = tasks.map(function(item) {
        var obj = item !== null && typeof item === 'object' ? item : {} as Payload
        return {
          name: typeof obj.name === 'string' ? obj.name : ''
        , entry: typeof obj.entry === 'string' ? obj.entry : ''
        }
      })
    }
    this.applyState(device, payload)
    device.lastSeenAt = Date.now()
    this.broadcastDevices()
    this.broadcastState(device)
  }

  onLogs(device: Device, payload: Payload) {
    if (!device.logEnabled) {
      // 日志接收已单独关闭：丢弃，不转发也不入队
      return
    }
    var raw = payload.lines
    if (!Array.isArray(raw)) {
      return
    }
    var lines: string[] = []
    raw.forEach(function(line) {
      if (typeof line === 'string') {
        lines.push(line)
      }
    })
    if (lines.length === 0) {
      return
    }
    device.lastSeenAt = Date.now()
    this.pushLogs(device, lines)
  }

  onCommandResult(device: Device, payload: Payload) {
    var commandId = typeof payload.commandId === 'string' ? payload.commandId : ''
    var command = typeof payload.command === 'string' ? payload.command : ''
    var message = typeof payload.message === 'string' ? payload.message : ''
    var origin = commandId ? this.pending.get(commandId) ?? null : null
    if (commandId) {
      this.pending.delete(commandId)
    }
    this.pushCommandResult(device, commandId, command, payload.ok === true, message, origin)
  }

  applyState(device: Device, payload: Payload) {
    if (typeof payload.running === 'boolean') {
      device.running = payload.running
    }
    if (typeof payload.status === 'string') {
      device.status = payload.status
    }
    if (typeof payload.entry === 'string') {
      device.entry = payload.entry
    }
    if (typeof payload.shortSide === 'number') {
      device.shortSide = payload.shortSide
    }
  }

  // ------------------------------------------------------------------
  // 控制台通道
  // ------------------------------------------------------------------

  addConsole(socket: WebSocket) {
    this.consoles.add(socket)
    safeSend(socket, envelope('devices', '', {devices: this.deviceViews()}))
  }

  removeConsole(socket: WebSocket) {
    this.consoles.delete(socket)
    this.devices.forEach(function(device) {
      device.watchers.delete(socket)
    })
  }

  handleConsoleText(socket: WebSocket, text: string) {
    var message = parse(text)
    if (!message) {
      return
    }
    switch (message.type) {
    case 'watch':
      this.watch(socket, message.deviceId)
      break
    case 'unwatch':
      this.unwatch(socket, message.deviceId)
      break
    case 'setLog':
      this.setLogEnabled(message.deviceId, message.payload.enabled === true)
      break
    case 'command':
      this.consoleCommand(socket, message.deviceId, message.payload)
      break
    default:
      this.log.warn('console sent unknown type %s', message.type)
      break
    }
  }

  watch(socket: WebSocket, deviceId: string) {
    var device = this.devices.get(deviceId)
    if (!device || !this.consoles.has(socket)) {
      return
    }
    device.watchers.add(socket)
  }

  unwatch(socket: WebSocket, deviceId: string) {
    var device = this.devices.get(deviceId)
    if (device) {
      device.watchers.delete(socket)
    }
  }

  /** 日志接收开关：按设备单独控制，关掉即停止接收该设备的日志 */
  setLogEnabled(deviceId: string, enabled: boolean) {
    var device = this.devices.get(deviceId)
    if (!device) {
      return
    }
    device.logEnabled = enabled
    this.log.info('device %s log reception %s', deviceId, enabled ? 'on' : 'off')
    this.broadcastState(device)
  }

  consoleCommand(socket: WebSocket, deviceId: string, payload: Payload) {
    var command = typeof payload.command === 'string' ? payload.command : ''
    if (!command) {
      this.log.warn('console sent command without a command name')
      return
    }
    var rawArgs = payload.args
    var isArgsObject = rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
    var args: Payload = isArgsObject ? rawArgs : {}
    var outcome = this.dispatchCommand(deviceId, command, args, socket)
    if (!outcome.ok) {
      // 没投出去也要回一条结果，免得控制台一直等
      var device = this.devices.get(deviceId)
      if (device) {
        this.pushCommandResult(device, outcome.commandId, command, false, outcome.message, socket)
      }
    }
  }

  // ------------------------------------------------------------------
  // 命令下发
  // ------------------------------------------------------------------

  /**
  * 把命令投给设备。同一设备的命令串行由安卓端保证（云端不重试），
  * 这里只记下发起者，回执到了也好送回去。
  */
  dispatchCommand(deviceId: string, command: string, args: Payload, origin: WebSocket) {
    var commandId = 'cmd-' + randomId()
    if (!COMMANDS.has(command)) {
      return {ok: false, commandId: commandId, message: '未知命令 ' + command}
    }
    var device = this.devices.get(deviceId)
    if (!device) {
      return {ok: false, commandId: commandId, message: '设备不存在'}
    }
    if (!device.online || !device.socket) {
      return {ok: false, commandId: commandId, message: '设备不在线'}
    }
    var sent = safeSend(device.socket, envelope(COMMAND, deviceId, {
      commandId: commandId
    , command: command
    , args: args
    }))
    if (!sent) {
      return {ok: false, commandId: commandId, message: '命令发送失败'}
    }
    if (origin) {
      this.pending.set(commandId, origin)
    }
    return {ok: true, commandId: commandId, message: '已下发'}
  }

  // ------------------------------------------------------------------
  // 推送
  // ------------------------------------------------------------------

  private broadcastDevices() {
    var text = envelope('devices', '', {devices: this.deviceViews()})
    this.consoles.forEach(function(socket) {
      safeSend(socket, text)
    })
  }

  private broadcastState(device: Device) {
    var text = envelope('state', device.deviceId, statePayload(device))
    this.consoles.forEach(function(socket) {
      safeSend(socket, text)
    })
  }

  private pushLogs(device: Device, lines: string[]) {
    var text = envelope(LOGS, device.deviceId, {deviceId: device.deviceId, lines: lines})
    device.watchers.forEach(function(socket) {
      safeSend(socket, text)
    })
  }

  /** 回执送给观看该设备的连接，外加命令发起者（它可能没在观看） */
  private pushCommandResult(device: Device, commandId: string, command: string
    , ok: boolean, message: string, origin: WebSocket | null) {
    var text = envelope(COMMAND_RESULT, device.deviceId, {
      deviceId: device.deviceId
    , commandId: commandId
    , command: command
    , ok: ok
    , message: message
    })
    var targets = new Set(device.watchers)
    if (origin) {
      targets.add(origin)
    }
    targets.forEach(function(socket) {
      safeSend(socket, text)
    })
  }
}
