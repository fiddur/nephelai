const esClient = require('node-eventstore-client')

const connectEs = async ({ endpoint, user, password }) => {
  const es = esClient.createConnection(
    { defaultUserCredentials: new esClient.UserCredentials(user, password) }, endpoint
  )
  es.on('error', err => console.log(err))
  const promise = new Promise(res => es.once('connected', () => res(es)))

  es.connect()
  return promise
}

module.exports = connectEs
