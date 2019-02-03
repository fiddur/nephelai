const express        = require('express')
const cookieSession  = require('cookie-session')
const exphbs         = require('express-handlebars')
const passport       = require('passport')
const rp             = require('request-promise')
const uuid           = require('uuid')
const GoogleStrategy = require('passport-google-oauth20').Strategy
const FitbitStrategy = require('passport-fitbit-oauth2').FitbitOAuth2Strategy

module.exports = (config, users) => {
  const onAuthenticated = async (req, accessToken, refreshToken, params, profile, done) => {
    console.log({ accessToken, refreshToken, params })
    const id = (req.user && req.user.id)
          || await users.getByProvider(profile.provider, profile.id)
          || await users.create({ id: uuid.v4() })
    await users.connectAccount({
      atExpiration: (params.expires_in * 1000) + Date.now(),
      provider:     profile.provider,
      id,
      profile,
      accessToken,
      refreshToken,
    })
    done(null, await users.getById(id))
  }

  const app = express()
  app.use(express.static('static'))
  app.engine('.hbs', exphbs({ defaultLayout: 'main', extname: '.hbs' }))
  app.set('view engine', '.hbs')
  app.use(cookieSession(config.cookie))
  app.use(passport.initialize())
  app.use(passport.session())

  app.use((err, req, res, next) => {
    console.error(err.stack)
    res.status(500).send(err.message)
  })

  // Google OAuth 2
  passport.use(new GoogleStrategy({
    clientID:          config.google.clientID,
    clientSecret:      config.google.secret,
    callbackURL:       `${config.server.full}/auth/google/callback`,
    passReqToCallback: true,
  }, onAuthenticated))
  app.get('/auth/google', passport.authenticate('google', {
    scope: [
      'https://www.googleapis.com/auth/fitness.body.read',
      'https://www.googleapis.com/auth/fitness.body.write',
      'profile',
    ],
    accessType: 'offline',
  }))
  app.get(
    '/auth/google/callback', passport.authenticate('google'),
    (req, res) => res.redirect('/home')
  )

  // Fitbit OAuth 2
  passport.use(new FitbitStrategy({
    clientID:          config.fitbit.clientID,
    clientSecret:      config.fitbit.secret,
    callbackURL:       `${config.server.full}/auth/fitbit/callback`,
    passReqToCallback: true,
  }, onAuthenticated))
  app.get('/auth/fitbit', passport.authenticate('fitbit', {
    scope: ['activity', 'heartrate', 'location', 'profile'],
  }))
  app.get('/auth/fitbit/callback', passport.authenticate(
    'fitbit', { successRedirect: '/home' }
  ))

  // Utils
  const isAuthenticated = (req, res, next) => {
    if (req.isAuthenticated()) next()
    else res.redirect('/')
  }

  passport.serializeUser((user, done) => done(null, user.id))
  passport.deserializeUser(
    (id, done) => users
      .getById(id)
      .then((user) => done(null, user))
  )

  // UI
  app.get('/', (req, res) => res.render('index', { user: req.user }))

  app.get('/home', isAuthenticated, async (req, res) => {
    //res.json(req.user)

    const hr = await rp({
      // url:     `https://api.fitbit.com/1/user/${req.user.accounts.fitbit.profile.id}/activities/heart/date/2016-06-06/1m.json`,
      url:     `https://api.fitbit.com/1/user/${req.user.accounts.fitbit.profile.id}/activities/heart/date/${req.query.date}/1d/1min.json`,
      method:  'GET',
      headers: { Authorization: `Bearer ${req.user.accounts.fitbit.accessToken}` },
      simple:  false,
    })

    res.json(JSON.parse(hr))


    // res.send(await rp({
    //   url:     'https://www.googleapis.com/fitness/v1/users/me/dataSources',
    //   method:  'GET',
    //   headers: { Authorization: `Bearer ${req.user.accounts.google.accessToken}` },
    //   simple:  false,
    // }))
  })

  return app
}
