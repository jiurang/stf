/**
* Copyright © 2024 contains code contributed by Orange SA, authors: Denis Barbaron - Licensed under the Apache license 2.0
**/

import {createRequire} from 'module'
import crypto from 'crypto'
import http from 'http'
import url from 'url'
import fs from 'fs'

import express from 'express'
import cookieSession from 'cookie-session'
import bodyParser from 'body-parser'
import serveFavicon from 'serve-favicon'
import serveStatic from 'serve-static'
import httpProxy from 'http-proxy'
// csurf exports the middleware factory directly up to 1.15.0 and as an ESM
// default from 1.16.1 on. Accept both, the declared range allows both.
import * as csurf from '@dr.pogodin/csurf'
var csrf = csurf.default || (csurf as unknown as typeof csurf.default)
import compression from 'compression'

import logger from '../../util/logger.js'
import pathutil from '../../util/pathutil.js'

import auth from './middleware/auth.js'
import deviceIconMiddleware from './middleware/device-icons.js'
import browserIconMiddleware from './middleware/browser-icons.js'
import appstoreIconMiddleware from './middleware/appstore-icons.js'

import markdownServe from 'markdown-serve'

var require = createRequire(import.meta.url)
var packageJson = require('../../../package.json')

interface AppOptions {
  port: number
  secret: string
  ssid: string
  authUrl: string
  websocketUrl: string
  userProfileUrl?: string

  /** 内网可达的 maajx 单元地址；给了才启用 /maajx 反代与云控标签页 */
  maajxUrl?: string

  /** 与 maajx 单元一致的共享令牌，只留在服务端，不进浏览器 */
  maajxToken?: string
}

interface AppState {
  config: {
    websocketUrl: string
    stfVersion: string
    userProfileUrl?: string
    maajxUrl?: string
  }
  user: unknown
}

/** 同源反代前缀：云控前端只认这个相对路径，不关心 maajx 单元在哪 */
const MAAJX_PREFIX = '/maajx'

/** 控制台 WS 票据的有效期。签发到握手之间只隔一个连接，够用且短 */
const MAAJX_TICKET_TTL = 30000

export default function(options: AppOptions) {
  var log = logger.createLogger('app')
  var app = express()
  var server = http.createServer(app)

  app.use('/static/wiki', markdownServe.middleware({
    rootDirectory: pathutil.root('node_modules/@devicefarmer/stf-wiki')
  , view: 'docs'
  }))

  app.set('view engine', 'pug')
  app.set('views', pathutil.resource('app/views'))
  app.set('strict routing', true)
  app.set('case sensitive routing', true)
  app.set('trust proxy', true)

  // one-shot startup check for a prebuilt bundle
  // eslint-disable-next-line no-sync
  if (fs.existsSync(pathutil.resource('build'))) {
    log.info('Using pre-built resources')
    app.use(compression())
    app.use('/static/app/build/entry',
      serveStatic(pathutil.resource('build/entry')))
    app.use('/static/app/build', serveStatic(pathutil.resource('build'), {
      maxAge: '10d'
    }))
  }
  else {
    log.info('Using webpack')
    // Keep webpack-related requires here, as our prebuilt package won't
    // have them at all.
    var webpackServerConfig = require('./../../../webpack.config.mts').webpackServer
    app.use('/static/app/build',
      require('./middleware/webpack.js').default(webpackServerConfig))
  }

  app.use('/static/app/data', serveStatic(pathutil.resource('data')))
  app.use('/static/app/status', serveStatic(pathutil.resource('common/status')))
  app.use('/static/app/browsers', browserIconMiddleware())
  app.use('/static/app/appstores', appstoreIconMiddleware())
  app.use('/static/app/devices', deviceIconMiddleware())
  app.use('/static/app', serveStatic(pathutil.resource('app')))

  app.use('/static/logo',
    serveStatic(pathutil.resource('common/logo')))
  app.use(serveFavicon(pathutil.resource(
    'common/logo/exports/STF-128.png')))

  app.use(cookieSession({
    name: options.ssid
  , keys: [options.secret]
  , httpOnly: false
  }))

  app.use(auth({
    secret: options.secret
  , authUrl: options.authUrl
  }))

  // 走到这里的请求都已经过了 auth()，也就是带着有效登录态
  var maajxProxy = options.maajxUrl ? httpProxy.createProxyServer() : null
  if (maajxProxy) {
    // http-proxy 的 error 是 EventEmitter 事件，没有监听会直接把进程带崩
    maajxProxy.on('error', function(err, _req, res) {
      log.warn('maajx proxy error: %s', err.message)
      var response = res as http.ServerResponse
      if (response && typeof response.writeHead === 'function' && !response.headersSent) {
        response.writeHead(502)
        response.end('云控单元不可达')
      }
    })

    // ticket -> 过期时间戳。一次性：用掉即删
    var tickets = new Map<string, number>()

    function sweepTickets(now: number) {
      tickets.forEach(function(expiresAt, ticket) {
        if (expiresAt <= now) {
          tickets.delete(ticket)
        }
      })
    }

    // 控制台 WS 的握手走不到 express，中间件也就无从鉴权，所以先在这里
    // （已登录态下）换一张一次性票据，再由 upgrade 用它换真正的 WS
    app.get(MAAJX_PREFIX + '/api/console-ticket', function(req, res) {
      var now = Date.now()
      sweepTickets(now)
      var ticket = crypto.randomBytes(24).toString('hex')
      tickets.set(ticket, now + MAAJX_TICKET_TTL)
      res.json({ticket: ticket})
    })

    app.use(MAAJX_PREFIX, function(req, res) {
      req.headers['x-cloud-token'] = options.maajxToken || ''
      // 出错走代理对象上的 error 事件，那里统一回 502
      maajxProxy!.web(req, res, {target: options.maajxUrl})
    })

    // 同源的 WS 升级：换掉前缀、补上令牌后转给 maajx 单元
    server.on('upgrade', function(req, socket, head) {
      var path = req.url || ''
      if (!path.startsWith(MAAJX_PREFIX + '/')) {
        // 不是给我们的，直接断开，免得挂着一个没人应答的连接
        socket.destroy()
        return
      }
      var ticket = ''
      try {
        ticket = new URL(path, 'http://localhost').searchParams.get('ticket') || ''
      }
      catch (err) {
        socket.destroy()
        return
      }
      var expiresAt = ticket ? tickets.get(ticket) : null
      tickets.delete(ticket)
      if (!expiresAt || expiresAt <= Date.now()) {
        socket.destroy()
        return
      }
      var target = new URL(path.substring(MAAJX_PREFIX.length), options.maajxUrl)
      if (options.maajxToken) {
        target.searchParams.set('token', options.maajxToken)
      }
      req.url = target.pathname + target.search
      maajxProxy!.ws(req, socket, head, {target: options.maajxUrl})
    })
  }
  else {
    server.on('upgrade', function(_req, socket) {
      socket.destroy()
    })
  }

  // This needs to be before the csrf() middleware or we'll get nasty
  // errors in the logs. The dummy endpoint is a hack used to enable
  // autocomplete on some text fields.
  app.all('/app/api/v1/dummy', function(req, res) {
    res.send('OK')
  })

  app.use(bodyParser.json())
  app.use(csrf())

  app.use(function(req, res, next) {
    res.cookie('XSRF-TOKEN', req.csrfToken())
    next()
  })

  app.disable('x-powered-by')

  app.get('/', function(req, res) {
    res.render('index')
  })

  app.get('/app/api/v1/state.js', function(req, res) {
    var state: AppState = {
      config: {
        websocketUrl: (function() {
          var wsUrl = url.parse(options.websocketUrl, true)
          wsUrl.query.uip = req.ip
          return url.format(wsUrl)
        })()
      , stfVersion: packageJson.version
      }
    , user: req.user
    }

    if (options.userProfileUrl) {
      state.config.userProfileUrl = (function() {
        return options.userProfileUrl
      })()
    }

    // 只告诉前端「云控开着」，地址一律走同源前缀
    if (options.maajxUrl) {
      state.config.maajxUrl = MAAJX_PREFIX
    }

    res.type('application/javascript')
    res.send('var GLOBAL_APPSTATE = ' + JSON.stringify(state))
  })

  server.listen(options.port)
  log.info('Listening on port %d', options.port)
}
