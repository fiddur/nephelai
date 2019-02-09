const App       = require('../lib/app')
const Users     = require('../lib/users')
const getConfig = require('../lib/getConfig')
const connectEs = require('../lib/connect-es')

process.on('unhandledRejection', (err, promise) => {
  console.error('Unhandled rejection', { err, promise })
  process.exit(2)
})

async function main() {
  const config = getConfig(process.env, 'cookie', 'fitbit', 'google', 'server', 'eventstore')

  const portStr = config.server.port === 80 ? '' : `:${config.server.port}`
  config.server.full = `${config.server.protocol}://${config.server.host}${portStr}`

  const es    = await connectEs(config.eventstore)
  const users = Users(es)
  const app   = App(config, users)
  const port  = process.env.PORT || 3000

  app.listen(port, err => {
    if (err) throw err
    console.log(`Quantified Nephelai listening on port ${port}!`)
  })
}

main()
