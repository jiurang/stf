import {createRequire} from 'module'
import type {Argv} from 'yargs'
import type {CommandArgv} from '../../types/cli.js'

var require = createRequire(import.meta.url)

var command = 'maajx'

var describe = 'Start the MaaJxApp cloud-control unit.'

var builder = function(yargs: Argv) {
  return yargs
    .env('STF_MAAJX')
    .strict()
    .option('port', {
      alias: 'p'
    , describe: 'The port to bind to. Devices reach it through an adb ' +
        'reverse tunnel, so this is both this unit\'s port and the one ' +
        'listening on every device.'
    , type: 'number'
    , default: process.env.PORT || 7200
    })
    .option('bind', {
      describe: 'The address to bind to. Devices arrive over the adb tunnel, ' +
        'so there is no reason to expose this beyond loopback.'
    , type: 'string'
    , default: '127.0.0.1'
    })
    .option('adb-host', {
      describe: 'The ADB server host, used to watch devices and set up their ' +
        'reverse tunnels.'
    , type: 'string'
    , default: '127.0.0.1'
    })
    .option('adb-port', {
      describe: 'The ADB server port.'
    , type: 'number'
    , default: 5037
    })
    .option('token', {
      alias: 't'
    , describe: 'Shared token for the web console only (X-Cloud-Token header ' +
        'or ?token= query). Devices are not authenticated: they connect from ' +
        'the adb tunnel and identify themselves by ADB serial. The app unit ' +
        'also needs it to proxy /maajx for the browser.'
    , type: 'string'
    , demand: true
    })
    .epilog('Each option can be be overwritten with an environment variable ' +
      'by converting the option to uppercase, replacing dashes with ' +
      'underscores and prefixing it with `STF_MAAJX_` (e.g. ' +
      '`STF_MAAJX_TOKEN`).')
}

var handler = function(argv: CommandArgv<typeof builder>) {
  return require('../../units/maajx/index.js').default({
    port: argv.port
  , bind: argv.bind
  , token: argv.token
  , adbHost: argv.adbHost
  , adbPort: argv.adbPort
  })
}

export {command, describe, builder, handler}
