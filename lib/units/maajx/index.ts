/**
* MaaJxApp 云控单元
*
* 一条自成一体的云控链路：安卓端 App → 反向 WebSocket 接入 → 上行日志与状态、
* 下行启停与配置命令。协议与安卓端 CloudProtocol 一一对应（见 ./protocol.ts），
* 不与 STF 既有的 /api 与 socket.io 通道混用。
*
* 设备从哪来：不是自己注册进来的。单元跟着 adb 设备走 —— 每台设备一上线就给它建
* 一条反向隧道，设备上的 127.0.0.1:<port> 于是直通本单元（见 ./tunnel.ts）。
* App 启动就连这个固定端口，不需要知道 STF 在哪，也就不需要令牌。
*
* 独立端口、独立进程：既不改 STF 既有的单元的行为，也不依赖 RethinkDB 与 ZeroMQ。
* 默认只监听回环 —— 设备走 adb 隧道进来，局域网里没有任何理由能连到这个端口。
* 前端不直连这里，而是经 app 单元的 /maajx 同源反代接入（见 units/app）；
* 那条路要过浏览器，所以留着共享令牌。
*/

import crypto from 'crypto'
import http from 'http'
import express from 'express'
import {WebSocketServer, type WebSocket} from 'ws'

import lifecycle from '../../util/lifecycle.js'
import logger from '../../util/logger.js'
import {MaajxRegistry} from './registry.js'
import {TunnelManager} from './tunnel.js'

const DEVICE_PATH = '/ws/device'
const CONSOLE_PATH = '/ws/console'
const TOKEN_HEADER = 'x-cloud-token'

export interface MaajxUnitOptions {
  port: number
  token: string
  adbHost: string
  adbPort: number
  /** 监听地址。默认只有回环，因为设备是走 adb 隧道进来的 */
  bind: string
}

/** 共享令牌比对：定长时用定时安全比较，避免用响应时间当侧信道 */
function authorized(options: MaajxUnitOptions, provided: string | null | undefined) {
  if (!provided) {
    return false
  }
  var expected = Buffer.from(options.token)
  var actual = Buffer.from(provided)
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

function parseRequestUrl(raw: string | undefined) {
  if (!raw) {
    return null
  }
  try {
    return new URL(raw, 'http://localhost')
  }
  catch (err) {
    return null
  }
}

function rawToBuffer(data: Buffer | ArrayBuffer | Buffer[]) {
  if (Buffer.isBuffer(data)) {
    return data
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data)
  }
  return Buffer.from(data as ArrayBuffer)
}

export default function(options: MaajxUnitOptions) {
  var log = logger.createLogger('maajx')
  var registry = new MaajxRegistry(log)
  var app = express()
  var server = http.createServer(app)

  app.use(express.json())

  // 设备清单：控制台首帧同样从这里拿；实时变化仍以控制台通道推送为准。
  // 设备自己不走这里 —— 它从 adb 隧道直接握手上 WS，没有令牌可出示。
  app.get('/api/devices', function(req, res) {
    if (!authorized(options, req.header(TOKEN_HEADER))) {
      res.status(401).json({message: '共享令牌不正确'})
      return
    }
    res.json({devices: registry.deviceViews()})
  })

  var wss = new WebSocketServer({noServer: true, perMessageDeflate: false})

  function attachDevice(ws: WebSocket, serial: string) {
    registry.attachDevice(serial, ws)
    ws.on('message', function(data, isBinary) {
      if (isBinary) {
        registry.onFrame(serial, rawToBuffer(data))
      }
      else {
        registry.handleDeviceText(serial, rawToBuffer(data).toString('utf8'))
      }
    })
    ws.on('close', function() {
      registry.detachDevice(serial, ws)
    })
    ws.on('error', function(err) {
      log.warn('device %s socket error: %s', serial, err.message)
    })
  }

  function attachConsole(ws: WebSocket) {
    registry.addConsole(ws)
    ws.on('message', function(data, isBinary) {
      if (!isBinary) {
        registry.handleConsoleText(ws, rawToBuffer(data).toString('utf8'))
      }
    })
    ws.on('close', function() {
      registry.removeConsole(ws)
    })
    ws.on('error', function(err) {
      log.warn('console socket error: %s', err.message)
    })
  }

  server.on('upgrade', function(req, socket, head) {
    var url = parseRequestUrl(req.url)
    if (!url) {
      socket.destroy()
      return
    }
    // 设备通道不鉴权：能连上的只有 adb 已经接上的那台机器自己，
    // 它的身份就是 adb 串号，握手时带上即可
    if (url.pathname === DEVICE_PATH) {
      var serial = (url.searchParams.get('serial') || '').trim()
      if (!serial) {
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, function(ws) {
        attachDevice(ws, serial)
      })
      return
    }
    if (url.pathname === CONSOLE_PATH && authorized(options, url.searchParams.get('token'))) {
      wss.handleUpgrade(req, socket, head, function(ws) {
        attachConsole(ws)
      })
      return
    }
    socket.destroy()
  })

  server.listen(options.port, options.bind)
  log.info('MaaJxApp cloud-control listening on port %d (%s)', options.port, options.bind)

  var tunnels = new TunnelManager(log, {
    port: options.port
  , adbHost: options.adbHost
  , adbPort: options.adbPort
  })
  tunnels.track()

  lifecycle.observe(function() {
    return new Promise<void>(function(resolve) {
      tunnels.dispose()
      // 先断开现有连接再关服务器，否则 close 会一直等它们自然结束
      wss.clients.forEach(function(client) {
        try {
          client.terminate()
        }
        catch (err) {
          // 已经断了：忽略
        }
      })
      server.close(function() {
        resolve()
      })
    })
  })
}
