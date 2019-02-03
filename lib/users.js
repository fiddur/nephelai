const esClient = require('node-eventstore-client')
const uuid     = require('uuid')

const UserEvents = {
  UserAdded: (user, { id, displayName }) => ({ ...user, id, displayName }),

  AccountConnected: (user, { accessToken, refreshToken, atExpiration, provider, profile }) => {
    const newUser = { ...user }

    if (!newUser.accounts) newUser.accounts = {}
    if (!newUser.accounts[provider]) newUser.accounts[provider] = {}
    newUser.accounts[provider].profile = profile
    newUser.accounts[provider].accessToken = accessToken
    newUser.accounts[provider].atExpiration = atExpiration

    if (typeof refreshToken === 'string') {
      newUser.accounts[provider].refreshToken = refreshToken
    }

    return newUser
  },

  TokensRefreshed: (user, { accessToken, refreshToken, provider, atExpiration }) => {
    const newUser = { ...user }
    newUser.accounts[provider].accessToken = accessToken
    newUser.accounts[provider].atExpiration = atExpiration
    if (typeof refreshToken === 'string') {
      newUser.accounts[provider].refreshToken = refreshToken
    }
    return newUser
  },
}

const belongsToAUserAggregate = (resolvedEvent) =>
  resolvedEvent.originalEvent.eventStreamId.startsWith('User-')

const getEventData = (resolvedEvent) =>
  JSON.parse(resolvedEvent.event.data.toString())

const Users = (es) => ({
  getById: async (id) => {
    const slice = await es.readStreamEventsForward(`User-${id}`, 0, 100)
    if (slice.status === 'streamNotFound') return null

    return slice.events.reduce(
      (user, resolvedEvent) =>
        UserEvents[resolvedEvent.event.eventType](user, getEventData(resolvedEvent)),
      { id }
    )
  },

  create: async ({ id }) => {
    console.log(await es.appendToStream(
      `User-${id}`, esClient.expectedVersion.noStream, [
        esClient.createJsonEventData(
          uuid.v4(), { id }, null, 'UserAdded'
        ),
      ]
    ))
    return id
  },

  connectAccount: ({ id, provider, profile, accessToken, refreshToken, atExpiration }) =>
    es.appendToStream(
      `User-${id}`, esClient.expectedVersion.any, [
        esClient.createJsonEventData(
          uuid.v4(), { id, provider, profile, accessToken, refreshToken, atExpiration },
          null, 'AccountConnected'
        ),
      ]
    ),

  refreshTokens: ({ id, provider, accessToken, refreshToken, atExpiration }) =>
    es.appendToStream(
      `User-${id}`, esClient.expectedVersion.any, [
        esClient.createJsonEventData(
          uuid.v4(), { id, provider, accessToken, refreshToken, atExpiration },
          null, 'TokensRefreshed'
        ),
      ]
    ),


  getByProvider: async (provider, providerId) => {
    // TODO use listByProvider
    const slice = await es.readAllEventsBackward(esClient.positions.end, 4096, false)

    return slice.events
      .filter(belongsToAUserAggregate)
      .filter((resolvedEvent) => resolvedEvent.event.eventType === 'AccountConnected')
      .map(getEventData)
      .filter((eventData) => eventData.provider === provider)
      .filter((eventData) => eventData.profile.id === providerId)
      .reduce((id, eventData) => eventData.id, null)
  },

  getAll: async () => new Promise((res, rej) => {
    const allUsers = {}
    const eventAppeared = (stream, resolvedEvent) => {
      if (!belongsToAUserAggregate(resolvedEvent)) return
      // console.log({ stream, resolvedEvent })

      const id = resolvedEvent.event.eventStreamId
      if (!allUsers[id]) allUsers[id] = { id }
      allUsers[id] = UserEvents[resolvedEvent.event.eventType](
        allUsers[id], getEventData(resolvedEvent)
      )
    }
    const liveProcessingStarted = () => res(allUsers)
    const subscriptionDropped = (subscription, reason, error) => {
      console.log('Subscription dropped.', { reason, error })
      rej(error)
    }

    es.subscribeToAllFrom(
      null, true, eventAppeared, liveProcessingStarted, subscriptionDropped
    )
  }),

  listByProvider: async (provider) => {
    const slice = await es.readAllEventsBackward(esClient.positions.end, 4096, false)
    return slice.events
      .filter(belongsToAUserAggregate)
      .filter((resolvedEvent) => resolvedEvent.event.eventType === 'AccountConnected')
      .map(getEventData)
      .filter((eventData) => eventData.provider === provider)
      .map((eventData) => eventData.id)
  },
})

module.exports = Users
