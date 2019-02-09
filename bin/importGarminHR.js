const rp        = require('request-promise')
const googleFit = require('../lib/googleFit')
const connectEs = require('../lib/connect-es')
const Users     = require('../lib/users')
const getConfig = require('../lib/getConfig')

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
  type, garminUserId, dateStr, gfit, dataSourceId,
}) => {
  console.log(`Indexing ${type} for ${garminUserId} at ${dateStr}`)

  if (dateStr === '2017-12-28') return true

  const data = await rp({
    json: true,
    url:  `https://connect.garmin.com/modern/proxy/wellness-service/wellness/${type}/${garminUserId}?${dateParam[type]}=${dateStr}`,
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
      endTimeNanos:       timestamp * nsPerMs,
      originDataSourceId: '',
      startTimeNanos:     timestamp * nsPerMs,
      value:              [{ fpVal: value }],
    }))

  const response = await gfit.users.dataSources.datasets.patch(
    {
      datasetId: `${startNs}-${endNs}`,
      dataSourceId,
      resource:  {
        dataSourceId,
        maxEndTimeNs:   endNs,
        minStartTimeNs: startNs,
        point,
      },
      userId: 'me',
    }
  )

  console.log(response.data)
  // process.exit()

  return false
}

const index = async ({ type, date, garminUserId, gfit, dataSourceId }) => {
  const done = await indexDay({
    dataSourceId,
    dateStr: date.toISOString().slice(0, 10),
    garminUserId,
    gfit,
    type,
  })

  return done || index({
    dataSourceId,
    date: new Date(date.valueOf() - (1000 * 60 * 60 * 24)),
    garminUserId,
    gfit,
    type,
  })
}

const main = async () => {
  const config = getConfig(process.env, 'eventstore', 'googleFit')

  const now = new Date('2019-01-03')
  const garminUserId = fiddur

  const es    = await connectEs(config.eventstore)
  const users = Users(es)
  const user = await users.getById('537a4631-1b04-4f3d-84a6-ca194addfc44') // fiddur

  const gfit = googleFit({ ...config.googleFit, ...user.accounts.google })

  // console.log(user)

  try {
    const dataSourceId = 'raw:com.google.heart_rate.bpm:593217898080'

    await index({
      dataSourceId,
      date: now,
      garminUserId,
      gfit,
      type: 'dailyHeartRate',
    })
    // await index({ type: 'dailyMovement', garminUserId, date: now })
  } catch (error) {
    console.error(error)
  }
}

main()
