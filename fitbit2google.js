const rp = require('request-promise')
const { google } = require('googleapis')
const connectEs = require('./lib/connect-es')
const Users     = require('./lib/users')

const nsPerMs = 1000000

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENTID, process.env.GOOGLE_SECRET
)

process.on('unhandledRejection', (err, promise) => {
  console.error('Unhandled rejection', { promise, err })
  process.exit(1)
})

const indexDay = async ({
  user, date, fitness, dataSourceId,
}) => {
  const fitbitUserId = user.accounts.fitbit.profile.id
  const username = user.username || user.id

  const isoDate = date.toISOString().slice(0, 10)
  const utcOffset = user.accounts.fitbit.profile._json.user.offsetFromUTCMillis

  console.log(`Indexing fitbit heartrate for ${username} at ${isoDate}`)

  const fitnessData = await rp({
    url:     `https://api.fitbit.com/1/user/${fitbitUserId}/activities/heart/date/${isoDate}/1d/1min.json`,
    method:  'GET',
    headers: { Authorization: `Bearer ${user.accounts.fitbit.accessToken}` },
    json:    true,
  })

  if (fitnessData['activities-heart-intraday'].dataset.length === 0) {
    console.log('No heartrate, user is dead.')
    return
  }

  const set = fitnessData['activities-heart-intraday'].dataset
  // console.log(set)
  const point = set
    // .filter(([, v]) => v)
    .map(({ time, value }) => {
      const timestampNs = (new Date(`${isoDate}T${time}Z`).valueOf() - utcOffset) * nsPerMs
      return {
        dataTypeName:       'com.google.heart_rate.bpm',
        startTimeNanos:     timestampNs,
        endTimeNanos:       timestampNs,
        originDataSourceId: '',
        value:              [{ fpVal: value }],
      }
    })

  const startNs  = point[0].startTimeNanos
  const endNs    = point[point.length - 1].endTimeNanos
  const response = await fitness.users.dataSources.datasets.patch(
    {
      dataSourceId,
      userId:    'me',
      datasetId: `${startNs}-${endNs}`,
      resource:  {
        dataSourceId,
        minStartTimeNs: startNs,
        maxEndTimeNs:   endNs,
        point,
      },
    }
  )
  console.log(response)
}

const index = async ({
  user, date, fitness, dataSourceId, startDate,
}) => {
  await indexDay({
    user, date, fitness, dataSourceId,
  })

  return (+date === +startDate) || index({
    date: new Date(date.valueOf() - (1000 * 60 * 60 * 24)),
    user,
    fitness,
    dataSourceId,
  })
}

const main = async () => {
  const es    = await connectEs({
    endpoint: process.env.ES_ENDPOINT,
    user:     process.env.ES_USER,
    password: process.env.ES_PASSWORD,
  })
  const users     = Users(es)
  const user      = await users.getById('537a4631-1b04-4f3d-84a6-ca194addfc44') // fiddur
  const fitness   = google.fitness('v1')
  const startDate = new Date('2015-03-01')
  const endDate   = new Date('2015-08-31')

  // TODO: Set up proper triggers for which user and period to transfer.

  google.options({ auth: oauth2Client })
  oauth2Client.setCredentials({
    access_token:  user.accounts.google.accessToken,
    refresh_token: user.accounts.google.refreshToken,
  })

  // TODO fetch client...
  const client = { id: process.env.FITBIT_CLIENTID, secret: process.env.FITBIT_SECRET }
  console.log(user.accounts.fitbit)
  // process.exit()

  if (!user.accounts.fitbit.atExpiration
      || user.accounts.fitbit.atExpiration < (Date.now() + (1000 * 60 * 5))) {
    console.log(`Renewing tokens for ${user.id}, exp ${new Date(user.accounts.fitbit.atExpiration)}`)

    const basic = new Buffer(`${client.id}:${client.secret}`).toString('base64')
    const refreshResponse = await rp({
      method:  'POST',
      uri:     'https://api.fitbit.com/oauth2/token',
      headers: {
        Authorization:  `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      form: {
        grant_type:    'refresh_token',
        refresh_token: user.accounts.fitbit.refreshToken,
      },
      json: true,
    })
    await users.refreshTokens({
      id:           user.id,
      provider:     'fitbit',
      accessToken:  refreshResponse.access_token,
      refreshToken: refreshResponse.refresh_token,
      atExpiration: (refreshResponse.expires_in * 1000) + Date.now(),
    })
    user.accounts.fitbit.accessToken = refreshResponse.access_token
  } else {
    console.log(`Tokens for ${user.id} are fresh, ${new Date(user.accounts.fitbit.atExpiration)}`)
  }

  const dataSourceId = 'raw:com.google.heart_rate.bpm:593217898080'
  await index({
    dataSourceId,
    date: endDate,
    fitness,
    startDate,
    user,
  })
}

main()
