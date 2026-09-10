/**
 * Native rendering of a timeline post's Aurboda structured data. An `activity`
 * post renders natively (#997): title, the author's personal message, the
 * activity's own date (#998), a Strava-style stat grid from the typed scalars,
 * and — just like the activity detail view (#1011) — ONE combined multi-metric
 * chart with per-metric toggles plus a time-synced interactive map that marks
 * the position at the hovered chart time. An `article` post renders the full
 * inline article (title + resolved blocks — see `TimelineArticle`). Only
 * rendered for posts from Aurboda instances (which carry `structured`);
 * Mastodon posts have none.
 */
import type { FeedStructuredActivity, FeedStructuredPost } from '@aurboda/api-spec'

import { useMemo, useState } from 'preact/hooks'

import { CombinedMetricChart } from '../../components/charts/CombinedMetricChart'
import { RouteMap } from '../../components/charts/RouteMap'
import { formatEntryWindow } from './activity-stats'
import { ActivityStatGrid } from './ActivityStatGrid'
import {
  structuredCombinedSeries,
  structuredHasNativeMap,
  structuredRoutePoints,
} from './timeline-structured'
import { TimelineArticle } from './TimelineArticle'
import './TimelineStructured.css'

function ActivityStructured({ structured }: { structured: FeedStructuredActivity }) {
  const [hoverTime, setHoverTime] = useState<Date | null>(null)
  // Stable identities across the hover-driven re-renders (`structured` comes
  // from query data): the chart memoises its overlays on the series identity,
  // and RouteMap's init effect is keyed on `points` — a fresh array per
  // mousemove would redraw the chart and rebuild the Leaflet map mid-hover.
  const series = useMemo(() => structuredCombinedSeries(structured), [structured])
  const routePoints = useMemo(() => structuredRoutePoints(structured), [structured])
  const showMap = structuredHasNativeMap(structured)

  return (
    <div class="timeline-structured">
      <p class="feed-post-title">
        <strong>{structured.title ?? 'Shared activity'}</strong>
      </p>
      {structured.message && <p class="feed-post-message">{structured.message}</p>}
      <p class="feed-post-window">{formatEntryWindow(structured.start_time, structured.end_time)}</p>
      <ActivityStatGrid metrics={structured.metrics} />
      {series.length > 0 && structured.end_time && (
        <div class="timeline-chart">
          <CombinedMetricChart
            series={series}
            start={new Date(structured.start_time)}
            end={new Date(structured.end_time)}
            onHoverTime={setHoverTime}
            // Axis priority goes to the LAST metrics in toggle order, so without
            // a default the card's axes fall to whatever the payload happens to
            // end with and heart rate — the most-shared series — loses its own
            // (#1017). The activity detail view pins it the same way.
            defaultMetrics={['heart_rate']}
          />
        </div>
      )}
      {showMap && <RouteMap points={routePoints} hoverTime={hoverTime} />}
    </div>
  )
}

export function TimelineStructured({ structured }: { structured: FeedStructuredPost }) {
  if (structured.kind === 'article') return <TimelineArticle article={structured} />
  return <ActivityStructured structured={structured} />
}
