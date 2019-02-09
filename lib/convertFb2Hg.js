// @FIXME old copy

const aawait = require('asyncawait/await')
const aasync = require('asyncawait/async')
const moment = require('moment')

/**
 *  Needs the fitbit log id to be remembered from the /home view.
 */
module.exports = cache => getFitbitTcx => aasync(fitbitLogId => {
  console.log(`Attempting to copy fitbit activity ${fitbitLogId} to runkeeper.`)

  if (!(fitbitLogId in cache)) {
    throw new Error(
      `No cached activity with id ${fitbitLogId}.  Visit the list first!`
    )
  }

  const fbActivity = cache[fitbitLogId]

  const hgActivity = {
    source:     'fitbit2runkeeper',
    entry_mode: 'API',
  }


  // type

  const typeMap = {
    Run:            'Running',
    Sport:          'Sports',
    Walk:           'Walking',
    Yoga:           'Yoga',
    'Outdoor Bike': 'Cycling',
    // Arc Trainer
    // Barre
    // Bootcamp
    // Boxing / MMA
    // Circuit Training
    // Core Strengthening
    // Cross-Country
    // CrossFit
    // Cycling
    // Dance
    // Downhill Skiing
    // Elliptical
    // Group Workout
    // Hiking
    // Meditation
    // Mountain Biking
    // Nordic Walking
    // Other
    // Pilates
    // Rowing
    // Skating
    // Skiing
    // Snowboarding
    // Spinning
    // Sports
    // Stairmaster / Stepwell
    // Strength
    // Swimming
    // Training
    // Wheelchair
    // Zumba
  }

  if (fbActivity.activityName in typeMap) {
    hgActivity.type = typeMap[fbActivity.activityName]
  } else {
    hgActivity.type = 'Other'
  }

  switch (fbActivity.activityName) {
    default:
  }

  // start_time   (Needs to split out utc_offset?)
  hgActivity.start_time = moment(fbActivity.startTime)
    .format('ddd, D MMM YYYY HH:mm:ss')

  // total_distance
  if ('distance' in fbActivity) {
    if (fbActivity.distanceUnit !== 'Kilometer') {
      throw new Error(`Unsupported unit: ${fbActivity.distanceUnit}`)
    }

    hgActivity.total_distance = fbActivity.distance * 1000
  }

  // duration
  hgActivity.duration = fbActivity.activeDuration / 1000

  // average_heart_rate
  if ('averageHeartRate' in fbActivity) {
    hgActivity.average_heart_rate = fbActivity.averageHeartRate
  }

  // total_calories
  if ('calories' in fbActivity) {
    hgActivity.total_calories = fbActivity.calories
  }

  // notes   - add some other info about the log entry
  hgActivity.notes = 'Exported from fitbit (test)\n'
  hgActivity.notes += `See https://www.fitbit.com/activities/exercise/${fbActivity.logId}\n`

  if ('steps' in fbActivity) {
    const stepAvg = fbActivity.steps / (fbActivity.activeDuration / 1000 / 60)
    hgActivity.notes += `Steps: ${fbActivity.steps} = ${stepAvg} / min\n`
  }

  if ('tcxLink' in fbActivity) {
    const start       = moment(fbActivity.startTime)
    const tcxActivity = aawait(getFitbitTcx(fbActivity.logId))

    if ('Lap' in tcxActivity) {
      hgActivity.distance = []
      hgActivity.heart_rate = []
      hgActivity.path = []

      const maxI = tcxActivity.Lap.length - 1

      // FIXME: Ok, fitbit marks every km as a new lap in a free run.  Don't
      // mark them as pause/resume if no seconds have passed…

      tcxActivity.Lap.forEach((lap, i) => {
        const maxJ = lap.Track[0].Trackpoint.length - 1

        lap.Track[0].Trackpoint.forEach((trackpoint, j) => {
          const tpTime   = moment(trackpoint.Time[0])
          const position = tpTime.diff(start, 'seconds')

          // Make sure activity has started…
          // if (position < 0 || position > fbActivity.activeDuration - 1) return

          hgActivity.distance.push({
            timestamp: position,
            distance:  parseFloat(trackpoint.DistanceMeters[0]),
          })
          hgActivity.heart_rate.push({
            timestamp:  position,
            heart_rate: parseFloat(trackpoint.HeartRateBpm[0].Value[0]),
          })
          hgActivity.path.push({
            timestamp: position,
            latitude:  parseFloat(trackpoint.Position[0].LatitudeDegrees[0]),
            longitude: parseFloat(trackpoint.Position[0].LongitudeDegrees[0]),
            altitude:  parseFloat(trackpoint.AltitudeMeters[0]),
            type:      i === 0    && j === 0    ? 'start'
              :                      j === 0    ? 'resume'
                :        i === maxI && j === maxJ ? 'end'
                  :                      j === maxJ ? 'pause'
                    :                                   'gps',
          })
        })
      })
    }
  }

  return hgActivity
})
