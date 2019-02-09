const getConfig = (env, ...require) => {
  const config = {
    cookie: {
      name:   'session',
      secret: env.COOKIE_SECRET,
    },
    eventstore: {
      endpoint: env.ES_ENDPOINT,
      password: env.ES_PASSWORD,
      user:     env.ES_USER,
    },
    fitbit: {
      clientID: env.FITBIT_CLIENTID,
      secret:   env.FITBIT_SECRET,
    },
    google: {
      clientID: env.GOOGLE_CLIENTID,
      secret:   env.GOOGLE_SECRET,
    },
    server: {
      host:     env.SERVER_HOST,
      port:     parseInt(env.SERVER_PORT, 10),
      protocol: env.SERVER_PROTOCOL,
    },
  }

  return require.reduce((acc, type) => {
    if (!(type in config)) throw new Error(`Bad config type '${type}'. See lib/getConfig.js`)
    Object.entries(config[type]).forEach(([k, v]) => {
      if (!v) throw Error(`Missing config for '${type}.${k}'.  See lib/getConfig.js`)
    })
    return { [type]: config[type], ...acc }
  }, {})
}

module.exports = getConfig
