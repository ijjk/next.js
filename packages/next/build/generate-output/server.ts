import { IncomingMessage, ServerResponse } from 'http'
// Next.js can emit the project in a subdirectory depending on how
// many folder levels of `node_modules` are traced. To ensure `process.cwd()`
// returns the proper path, we change the directory to the folder with the
// launcher. This mimics `yarn workspace run` behavior.
process.chdir(__dirname)

if (!process.env.NODE_ENV) {
  // @ts-expect-error ensures we normalize NODE_ENV correctly
  process.env.NODE_ENV = 'production'
}

let requestHandler: ReturnType<
  import('../../server/next-server').default['getRequestHandler']
>
// @ts-ignore value is injected
const minimalMode = __MINIMAL_MODE__
// @ts-ignore value is injected
let conf = __NEXT_CONFIG__

module.exports = async (req: IncomingMessage, res: ServerResponse) => {
  try {
    if (!requestHandler) {
      if (!conf) {
        const loadConfig = (
          require('next/dist/server/config') as typeof import('../../server/config')
        ).default
        conf = await loadConfig('phase-production-server', __dirname)
      }

      // eslint-disable-next-line
      const NextServer = require('__NEXT_SERVER_PATH__').default
      const nextServer = new NextServer({
        dir: '.',
        conf: conf,
        customServer: false,
        minimalMode: minimalMode,
      })
      requestHandler = nextServer.getRequestHandler()
    }

    // entryDirectory handler
    await requestHandler(req, res)
  } catch (err) {
    console.error(err)

    if (minimalMode) {
      // crash the server immediately to clean up any bad module state
      // as this is cached between serverless function executions
      process.exit(1)
    } else {
      res.statusCode = 500
      res.end('internal error')
    }
  }
}
