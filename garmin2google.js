const rp = require('request-promise')
const { google } = require('googleapis')
const connectEs = require('./lib/connect-es')
const Users     = require('./lib/users')

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENTID, process.env.GOOGLE_SECRET
)

const fiddur = '43f23d7c-456a-4b51-ab32-9e7d568acd37'

const dateParam = {
  dailyHeartRate: 'date',
  dailyMovement:  'calendarDate',
}

const dataKey = {
  dailyHeartRate: 'heartRateValues',
  dailyMovement:  'movementValues',
}

const valueKey = {
  dailyHeartRate: 'heartrate',
  dailyMovement:  'movement',
}

const nsPerMs = 1000000

// @returns boolean If done
const indexDay = async ({
  type, garminUserId, dateStr, fitness, dataSourceId,
}) => {
  console.log(`Indexing ${type} for ${garminUserId} at ${dateStr}`)

  if (dateStr === '2017-12-28') return true

  const data = await rp({
    url:  `https://connect.garmin.com/modern/proxy/wellness-service/wellness/${type}/${garminUserId}?${dateParam[type]}=${dateStr}`,
    json: true,
  })

  // console.log(data)

  if (!data[dataKey[type]] || data[dataKey[type]].length === 0) {
    console.log('No heartrate, user is dead.')
    return true
  }

  const set = data[dataKey[type]]
  console.log(set)
  const startNs = set[0][0] * nsPerMs
  const endNs = set[set.length - 1][0] * nsPerMs

  const point = set
    .filter(([, v]) => v)
    .map(([timestamp, value]) => ({
      dataTypeName:       'com.google.heart_rate.bpm',
      startTimeNanos:     timestamp * nsPerMs,
      endTimeNanos:       timestamp * nsPerMs,
      originDataSourceId: '',
      value:              [{ fpVal: value }],
    }))

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

  console.log(response.data)
  // process.exit()

  return false
}

const index = async ({ type, date, garminUserId, fitness, dataSourceId }) => {
  const done = await indexDay({
    type,
    dateStr: date.toISOString().slice(0, 10),
    fitness,
    dataSourceId,
    garminUserId,
  })

  return done || index({
    type,
    date: new Date(date.valueOf() - (1000 * 60 * 60 * 24)),
    garminUserId,
    fitness,
    dataSourceId,
  })
}

const main = async () => {
  const now = new Date('2019-01-03')
  const garminUserId = fiddur

  const es    = await connectEs({
    endpoint: process.env.ES_ENDPOINT,
    user:     process.env.ES_USER,
    password: process.env.ES_PASSWORD,
  })
  const users = Users(es)
  const user = await users.getById('537a4631-1b04-4f3d-84a6-ca194addfc44') // fiddur
  const fitness = google.fitness('v1')
  // console.log(user)

  google.options({ auth: oauth2Client })
  oauth2Client.setCredentials({
    access_token:  user.accounts.google.accessToken,
    refresh_token: user.accounts.google.refreshToken,
  })

  try {
    const dataSourceId = 'raw:com.google.heart_rate.bpm:593217898080'

    await indexDay({
      type:    'dailyHeartRate',
      dateStr: '2019-01-03',
      fitness,
      dataSourceId,
      garminUserId,
    })

    await index({
      type: 'dailyHeartRate',
      garminUserId,
      date: now,
      fitness,
      dataSourceId,
    })
    // await index({ type: 'dailyMovement', garminUserId, date: now })

  } catch (error) {
    console.error(error)
  }
}

main()

    // const res1 = await fitness.users.dataSources.create({
    //   userId:   'me',
    //   resource: {
    //     name:         'someQuantifiedSelves heart_rate raw',
    //     dataStreamId: 'raw:com.google.heart_rate.bpm:593217898080',
    //     type:         'raw',
    //     application:  {
    //       detailsUrl: 'http://ydalar.hokasgard.com',
    //       name:       'Some Quantified Selves',
    //       version:    '1',
    //     },
    //     dataType: {
    //       field: [{ name: 'bpm', format: 'floatPoint' }],
    //       name:  'com.google.heart_rate.bpm',
    //     },
    //   },
    // })
    //
    // console.log(res1)
    // process.exit()
