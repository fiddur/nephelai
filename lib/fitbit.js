// @FIXME old copy

const Immutable = require('immutable')
const Promise   = require('bluebird')
const url       = require('url')
const extend    = require('util')._extend
const xml2js    = require('xml2js')

/**
 * @param options Immutable.Map
 */
const fitbitRp = ({ rp, config, onNewTokens }) => (user, options) => {
  console.log('fitbitRp', { user, options })

  const Authorization = `Bearer ${user.accounts.fitbit.accessToken}`

  return rp(options.mergeDeep({ headers: { Authorization } }).toJS())
    .then(response => {
      console.log('fbRp response', response)
      return response
    })
    .catch(err => {
      console.log(err.name, err.statusCode, err.message, err.error)

      if (err.statusCode === 401 && err.error.errors[0].errorType === 'expired_token') {
        const basic = new Buffer(`${config.clientID}:${config.clientSecret}`)
          .toString('base64')

        return rp({
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
        }).then(newTokens => {
          console.log('newTokens', newTokens)
          onNewTokens(user.id, newTokens)

          return rp(options.mergeDeep({
            headers: { Authorization: `Bearer ${newTokens.access_token}` },
          }).toJS())
        })
      }

      return err
    })
}

/*
 * @param function  options.rp        A requst-promise implementation
 * @param object    options.config    Fitbit configuration with clientID and clientSecret
 * @param function  onNewAccessToken  Callback called with ({ accessToken, userId })
 */
module.exports = ({ rp, config, onNewTokens }) => {
  const fbRp = fitbitRp({ rp, config, onNewTokens })

  const activitiesUrl = url.parse('https://api.fitbit.com/1/user/-/activities/')

  return {
    getActivities: (user, date) => {
      const uri = extend({}, activitiesUrl)
      uri.pathname += 'list.json'
      uri.query = {
        beforeDate: date.format('YYYY-MM-DD'),
        sort:       'desc',
        limit:      10,
        offset:     0,
      }

      return fbRp(user, new Immutable.Map({ json: true, uri: url.format(uri) }))
        .then(result => result.activities)
    },

    // Returns Promise of TCX data.
    getTcx: user => logId => fbRp(
      user, new Immutable.Map({ uri: `https://api.fitbit.com/1/user/-/activities/${logId}.tcx` })
    ).then(tcxRaw => {
      const parser = Promise.promisifyAll(new xml2js.Parser())
      return parser.parseStringAsync(tcxRaw)
    }).then(tcxData => tcxData.TrainingCenterDatabase.Activities[0].Activity[0]),

    listSubscriptions: user => fbRp(user, new Immutable.Map({
      json: true,
      uri:  'https://api.fitbit.com/1/user/-/activities/apiSubscriptions.json',
    })).then(result => result.apiSubscriptions),

    // Subscribes user, returns promise
    subscribe: user => fbRp(user, new Immutable.Map({
      method: 'POST',
      uri:    `https://api.fitbit.com/1/user/${user.fitbitId}`
        + `/activities/apiSubscriptions/${user.id}.json`,
    })),
  }
}
