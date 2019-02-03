Quantified Nephelai
===================

The Νεφελαι were the Okeanid-nymphs of clouds and rain.

This repo aims to collect a user's self quantification data into single useful
places, like storing heart rate, steps taken, and sleep data, in Google
Fitness, and also doing useful aggregations.

**NB: This is a hobby project, not properly tested, nor cleanly implemented.**


Background
----------

I am using Google Data Studios to make visualization and dashboard of my
Quantified Self data.  Over the years, I have used different systems, and
mainly different fitness trackers.  I am tranferring my data from Fitbit,
Garmin, and Polar, into Google Fitness, to have it in a single place.

I will also add a RescueTime connector for Google Data Studios.


Current state
-------------

There are hackish scripts to transfer heart rate data from Fitbit and Garmin to
Google Fitness, but currently you need to change user ID etc in the scripts
themselves.


Planned structure
-----------------

Local storage backend: [EventStore](https://eventstore.org/)


Setup and use
-------------

* Setup EventStore.
* Set ENV
  * `COOKIE_SECRET`
  * `FITBIT_CLIENTID` and `FITBIT_SECRET`
  * `GOOGLE_CLIENTID` and `GOOGLE_SECRET`
  * `SERVER_HOST`, `SERVER_PORT`, `SERVER_PROTOCOL` (for external facing app)
  * `ES_ENDPOINT`, `ES_USER`, `ES_PASSWORD` for EventStore server
* `yarn`


### Caverats

* Garmin import only works for public data, it uses no authentication.
* There is no automatic setup of Google Fitness datasource, see commented bit in garmin2google.


Todo
----

* Add EventStore docker setup script?
