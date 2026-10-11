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
    , describe: 'The port to bind to.'
    , type: 'number'
    , default: process.env.PORT || 7200
    })
    .option('token', {
      alias: 't'
    , describe: 'Shared token the App must present (X-Cloud-Token header ' +
        'or ?token= query). Must match the token configured in the App. The ' +
        'app unit also needs it to proxy /maajx for the web console.'
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
  , token: argv.token
  })
}

export {command, describe, builder, handler}
