/**
* MaaJxApp 云控协议（服务端侧）
*
* 与安卓端 com.aliothmoon.maafw.jxapp.cloud.CloudProtocol 一一对应：消息类型与命令名
* 只在这里定义一次，改协议先改这里，避免散落在各处的字符串字面量对不上。
* 信封统一为 `{type, deviceId, payload}` 的 JSON 文本。
*/

export const PROTOCOL_VERSION = 1

// 上行（设备 → 服务端）
export const HELLO = 'hello'
export const HEARTBEAT = 'heartbeat'
export const LOGS = 'logs'
export const CONFIG = 'config'
export const COMMAND_RESULT = 'commandResult'

// 下行（服务端 → 设备）
export const COMMAND = 'command'

// 命令清单（与云控设计文档章节7一致）
export const CMD_START = 'start'
export const CMD_STOP = 'stop'
export const CMD_SET_CONFIG = 'setConfig'
export const CMD_SCREENCAP = 'screencap'
export const CMD_TAP = 'tap'
export const CMD_SWIPE = 'swipe'
export const CMD_KEY = 'key'

export const COMMANDS = new Set([
  CMD_START
, CMD_STOP
, CMD_SET_CONFIG
, CMD_SCREENCAP
, CMD_TAP
, CMD_SWIPE
, CMD_KEY
])

/** 协议载荷：安卓端字段随版本增补，服务端只按需读取，不做静态约束 */
export type Payload = Record<string, any>

export interface Envelope {
  type: string
  deviceId: string
  payload: Payload
}

/** 组包；deviceId 为空时不写这个字段（只有整表广播那种不针对单台的消息） */
export function envelope(type: string, deviceId: string, payload: Payload = {}) {
  var root: {type: string, deviceId?: string, payload?: Payload} = {type}
  if (deviceId) {
    root.deviceId = deviceId
  }
  root.payload = payload
  return JSON.stringify(root)
}

/** 拆包；非法 JSON 返回 null，由调用方当作「没收到」处理 */
export function parse(text: string): Envelope | null {
  var root: unknown
  try {
    root = JSON.parse(text)
  }
  catch (err) {
    // 非法 JSON：不打断连接，交给上层忽略
    return null
  }
  if (root === null || typeof root !== 'object') {
    return null
  }
  var obj = root as Payload
  var payload = obj.payload
  return {
    type: typeof obj.type === 'string' ? obj.type : ''
  , deviceId: typeof obj.deviceId === 'string' ? obj.deviceId : ''
  , payload: payload !== null && typeof payload === 'object' ? payload : {}
  }
}
