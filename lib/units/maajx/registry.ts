/**
* 设备注册表与会话中心（MaaJxApp 云控）
*
* 记住谁在线、每台设备的状态摘要与任务清单，并负责把日志、帧、命令结果推给控制台。
* 只做状态与投递，不做业务判断（业务都在安卓端的 CloudCommandHandler 里）。
*
* 身份只有一条：adb 串号。STF 前端按串号对号入座，云控这边就没有第二个身份来源，
* 也没有注册这一步 —— 设备连上来即认领。之前那套「自报姓名换 deviceId」的映射表
* 会让任何拿到令牌的客户端冒名顶替别的机器，现在这条路整个删掉了。
*
* 全部为内存态，进程重启即清空：设备掉线重连即可，不必重新注册。
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
  /** adb 串号，同时充当设备 ID —— 没有第二套编号了 */
  public serial: string
  public name = ''
  public model = ''
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

  constructor(serial: string) {
    this.serial = serial
  }

  get deviceId() {
    return this.serial
  }
}

function statePayload(device: Device): DeviceStateView {
  return {
    deviceId: device.serial
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
    deviceId: device.serial
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
  private consoles = new Set<WebSocket>()
  // commandId -> 发起命令的控制台连接，回执到了也好送回去（它可能没在观看）
  private pending = new Map<string, WebSocket>()

  constructor(log: Logger) {
    this.log = log
  }

  // ------------------------------------------------------------------
  // 设备通道生命周期
  // ------------------------------------------------------------------

  /**
  * 设备连上来了，按串号认领。第一次连上是登记，之后重连都认得回同一台。
  * 返回 null 表示这个连接没法归属（没带串号），调用方该直接断开。
  */
  attachDevice(serial: string, socket: WebSocket) {
    if (!serial) {
      this.log.warn('device channel without a serial, dropping it')
      return null
    }
    var device = this.devices.get(serial)
    if (!device) {
      device = new Device(serial)
      this.devices.set(serial, device)
      this.log.info('device %s registered', serial)
    }
    device.socket = socket
    device.online = true
    device.lastSeenAt = Date.now()
    this.log.info('device %s channel attached', serial)
    this.broadcastDevices()
    this.broadcastState(device)
    return device
  }

  detachDevice(serial: string, socket: WebSocket) {
    var device = this.devices.get(serial)
    if (!device || device.socket !== socket) {
      return
    }
    device.socket = null
    device.online = false
    this.log.info('device %s channel detached', serial)
    this.broadcastDevices()
    this.broadcastState(device)
  }

  // ------------------------------------------------------------------
  // 查询
  // ------------------------------------------------------------------

  deviceViews() {
    var list = Array.from(this.devices.values())
    list.sort(function(a, b) {
      return a.serial.localeCompare(b.serial)
    })
    return list.map(deviceView)
  }

  // ------------------------------------------------------------------
  // 设备上行
  // ------------------------------------------------------------------

  handleDeviceText(serial: string, text: string) {
    var message = parse(text)
    if (!message) {
      return
    }
    var device = this.devices.get(serial)
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
      this.log.warn('device %s sent unknown type %s', serial, message.type)
      break
    }
  }

  /** 设备上行的 PNG 帧，只中继给正在观看该设备的控制台连接 */
  onFrame(serial: string, frame: Buffer) {
    var device = this.devices.get(serial)
    if (!device || frame.length === 0) {
      return
    }
    device.watchers.forEach(function(socket) {
      safeSendBinary(socket, frame)
    })
  }

  onHello(device: Device, payload: Payload) {
    // 串号以握手时带的那条为准：那是 adb 给的。反过来这里只记一笔不符，
    // 因为一旦允许它改写身份，前面那套「不冒名」就白做了。
    var reported = typeof payload.serial === 'string' ? payload.serial.trim() : ''
    if (reported && reported !== device.serial) {
      this.log.warn('device %s reports serial %s, keeping the one from the handshake'
        , device.serial
        , reported)
    }
    if (typeof payload.model === 'string' && payload.model) {
      device.model = payload.model
      device.name = device.name || payload.model
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
    var text = envelope('state', device.serial, statePayload(device))
    this.consoles.forEach(function(socket) {
      safeSend(socket, text)
    })
  }

  private pushLogs(device: Device, lines: string[]) {
    var text = envelope(LOGS, device.serial, {deviceId: device.serial, lines: lines})
    device.watchers.forEach(function(socket) {
      safeSend(socket, text)
    })
  }

  /** 回执送给观看该设备的连接，外加命令发起者（它可能没在观看） */
  private pushCommandResult(device: Device, commandId: string, command: string
    , ok: boolean, message: string, origin: WebSocket | null) {
    var text = envelope(COMMAND_RESULT, device.serial, {
      deviceId: device.serial
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
