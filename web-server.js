const connectEs = require('./lib/connect-es')
const App       = require('./lib/app')
const Users     = require('./lib/users')

process.on('unhandledRejection', (err, promise) => {
  console.error('Unhandled rejection', { promise, err })
})

const config = {
  cookie: {
    name:   'session',
    secret: process.env.COOKIE_SECRET,
  },
  fitbit: {
    clientID: process.env.FITBIT_CLIENTID,
    secret:   process.env.FITBIT_SECRET,
  },
  google: {
    clientID: process.env.GOOGLE_CLIENTID,
    secret:   process.env.GOOGLE_SECRET,
  },
  server: {
    host:     process.env.SERVER_HOST,
    port:     parseInt(process.env.SERVER_PORT, 10),
    protocol: process.env.SERVER_PROTOCOL,
  },
  eventstore: {
    endpoint: process.env.ES_ENDPOINT,
    user:     process.env.ES_USER,
    password: process.env.ES_PASSWORD,
  },
}
const portStr = config.server.port === 80 ? '' : `:${config.server.port}`
config.server.full = `${config.server.protocol}://${config.server.host}${portStr}`

async function main() {
  const es    = await connectEs(config.eventstore)
  const users = Users(es)
  const app   = App(config, users)
  const port  = process.env.PORT || 3000

  app.listen(port, (err) => {
    if (err) console.log(err) && process.exit()
    console.log(`Quantified Nephelai listening on port ${port}!`)
  })
}

main()
