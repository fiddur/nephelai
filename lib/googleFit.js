const { google } = require('googleapis')

// const gfit = googleFit({ ...process.env, ...user.accounts.google })
const googleFit = ({ clientID, secret, accessToken, refreshToken }) => {
  const oauth2Client = new google.auth.OAuth2(clientID, secret)

  // BEWARE!  Google setup is GLOBAL!
  google.options({ auth: oauth2Client })

  oauth2Client.setCredentials({ access_token: accessToken, refresh_token: refreshToken })

  return google.fitness('v1')
}

module.exports = googleFit

// Setup datasource
// const res1 = await fitness.users.dataSources.create({
//   userId:   'me',
//   resource: {
//     name:         'nephelai heart_rate raw',
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
