/**
* MaaJxApp 云控单元
*
* 一条自成一体的云控链路：安卓端 App 注册 → 反向 WebSocket 接入 → 上行日志与状态、
* 下行启停与配置命令。协议与安卓端 CloudProtocol 一一对应（见 ./protocol.ts），
* 不与 STF 既有的 /api 与 socket.io 通道混用。
*
* 独立端口、独立进程：既不改 STF 既有单元的行为，也不依赖 RethinkDB 与 ZeroMQ。
* 前端不直连这里，而是经 app 单元的 /maajx 同源反代接入（见 units/app）。
*/

import crypto from 'crypto'
import http from 'http'
import express from 'express'
import {WebSocketServer, type WebSocket} from 'ws'

import lifecycle from '../../util/lifecycle.js'
import logger from '../../util/logger.js'
import {MaajxRegistry} from './registry.js'

const DEVICE_PATH = '/ws/device'
const CONSOLE_PATH = '/ws/console'
const TOKEN_HEADER = 'x-cloud-token'

export interface MaajxUnitOptions {
  port: number
  token: string
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

  // 注册：App 用 X-Cloud-Token 头鉴权，服务端按 serial（退化到设备名）去重后分配 deviceId
  app.post('/api/devices/register', function(req, res) {
    if (!authorized(options, req.header(TOKEN_HEADER))) {
      res.status(401).json({message: '共享令牌不正确'})
      return
    }
    var body = req.body !== null && typeof req.body === 'object' ? req.body : {}
    res.json({deviceId: registry.registerDevice(body)})
  })

  // 设备清单：控制台首帧同样从这里拿；实时变化仍以控制台通道推送为准
  app.get('/api/devices', function(req, res) {
    if (!authorized(options, req.header(TOKEN_HEADER))) {
      res.status(401).json({message: '共享令牌不正确'})
      return
    }
    res.json({devices: registry.deviceViews()})
  })

  var wss = new WebSocketServer({noServer: true, perMessageDeflate: false})

  function attachDevice(ws: WebSocket, deviceId: string) {
    registry.deviceAttached(deviceId, ws)
    ws.on('message', function(data, isBinary) {
      if (isBinary) {
        registry.onFrame(deviceId, rawToBuffer(data))
      }
      else {
        registry.handleDeviceText(deviceId, rawToBuffer(data).toString('utf8'))
      }
    })
    ws.on('close', function() {
      registry.deviceDetached(deviceId, ws)
    })
    ws.on('error', function(err) {
      log.warn('device %s socket error: %s', deviceId, err.message)
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
    if (!url || !authorized(options, url.searchParams.get('token'))) {
      socket.destroy()
      return
    }
    if (url.pathname === DEVICE_PATH) {
      var deviceId = url.searchParams.get('deviceId') || ''
      if (!registry.has(deviceId)) {
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, function(ws) {
        attachDevice(ws, deviceId)
      })
      return
    }
    if (url.pathname === CONSOLE_PATH) {
      wss.handleUpgrade(req, socket, head, function(ws) {
        attachConsole(ws)
      })
      return
    }
    socket.destroy()
  })

  server.listen(options.port)
  log.info('MaaJxApp cloud-control listening on port %d', options.port)

  lifecycle.observe(function() {
    return new Promise<void>(function(resolve) {
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
