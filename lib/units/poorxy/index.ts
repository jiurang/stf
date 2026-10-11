/**
* Copyright © 2024 contains code contributed by Orange SA, authors: Denis Barbaron - Licensed under the Apache license 2.0
**/

import http from 'http'

import express from 'express'
import httpProxy from 'http-proxy'

import logger from '../../util/logger.js'

interface PoorxyOptions {
  port: number
  appUrl: string
  apiUrl: string
  authUrl: string
  storageUrl: string
  storagePluginImageUrl: string
  storagePluginApkUrl: string
}

export default function(options: PoorxyOptions) {
  var log = logger.createLogger('poorxy')
  var app = express()
  var server = http.createServer(app)
  var proxy = httpProxy.createProxyServer()

  proxy.on('error', function(err) {
    log.error('Proxy had an error', err.stack)
  })

  app.set('strict routing', true)
  app.set('case sensitive routing', true)
  app.set('trust proxy', true)

  app.disable('x-powered-by')

  ;['/static/auth/{*path}', '/auth/{*path}'].forEach(function(route) {
    app.all(route, function(req, res) {
      proxy.web(req, res, {
        target: options.authUrl
      })
    })
  })

  ;['/s/image/{*path}'].forEach(function(route) {
    app.all(route, function(req, res) {
      proxy.web(req, res, {
        target: options.storagePluginImageUrl
      })
    })
  })

  ;['/s/apk/{*path}'].forEach(function(route) {
    app.all(route, function(req, res) {
      proxy.web(req, res, {
        target: options.storagePluginApkUrl
      })
    })
  })

  ;['/s/{*path}'].forEach(function(route) {
    app.all(route, function(req, res) {
      proxy.web(req, res, {
        target: options.storageUrl
      })
    })
  })

  ;['/api/{*path}'].forEach(function(route) {
    app.all(route, function(req, res) {
      proxy.web(req, res, {
        target: options.apiUrl
      })
    })
  })
  app.use(function(req, res) {
    proxy.web(req, res, {
      target: options.appUrl
    })
  })

  // WebSocket 升级：没有这一段，浏览器发往 7100 的 ws:// 会被直接掐掉。
  // 照 web 那条兜底规则一律转给 app 单元，由它自己判断认不认（目前只有云控
  // 的控制台通道会应答，其余的它会 destroy）。
  server.on('upgrade', function(req, socket, head) {
    proxy.ws(req, socket, head, {
      target: options.appUrl
    })
  })

  server.listen(options.port)
  log.info('Listening on port %d', options.port)
}
