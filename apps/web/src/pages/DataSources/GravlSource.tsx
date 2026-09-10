import type { ProviderSyncStatus } from '@aurboda/api-spec'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

import {
  disconnectGravl,
  fetchGravlSyncStatus,
  fetchUserSettings,
  getGravlConnectUrl,
  syncGravl,
  updateUserSettings,
} from '../../state/api'
import { auth } from '../../state/auth'
import {
  type DataTypeItem,
  DataTypesList,
  LoginRequired,
  type SaveStatus,
  SaveStatusIndicator,
  StatusBanner,
  SyncIntervalField,
  SyncStatusBar,
} from './shared'
import './style.css'

const DATA_TYPES: DataTypeItem[] = [
  { label: 'Strength workouts (as strength_training activities)' },
  { label: 'Sets per exercise: weight, reps, set type, RPE' },
  { label: 'Timed and distance sets (planks, carries)' },
  { label: 'Workout volume, calories and personal-record count' },
]

type GravlConnection = 'oauth' | 'token' | null

const connectionLabel = (connection: GravlConnection): string => {
  if (connection === 'oauth') return 'Gravl is connected (OAuth)'
  if (connection === 'token') return 'Gravl is connected (personal token)'
  return 'Gravl not connected'
}

function GravlOAuthSection({
  connection,
  isConfigured,
  onDisconnected,
}: {
  connection: GravlConnection
  isConfigured: boolean
  onDisconnected: () => Promise<void>
}) {
  const [error, setError] = useState('')
  const [disconnecting, setDisconnecting] = useState(false)

  const handleConnect = useCallback(async () => {
    try {
      const url = await getGravlConnectUrl()
      window.location.href = url
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start Gravl connection')
    }
  }, [])

  const handleDisconnect = useCallback(async () => {
    setDisconnecting(true)
    try {
      await disconnectGravl()
      await onDisconnected()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect')
    } finally {
      setDisconnecting(false)
    }
  }, [onDisconnected])

  return (
    <section class="settings-section">
      <h2>Connect with OAuth</h2>
      {connection === 'oauth' ? (
        <div class="garmin-connected-actions">
          <p class="connected-status">Connected</p>
          <button
            type="button"
            class="connect-button disconnect-button"
            disabled={disconnecting}
            onClick={handleDisconnect}
          >
            {disconnecting ? 'Disconnecting...' : 'Disconnect'}
          </button>
        </div>
      ) : !isConfigured ? (
        <>
          <button type="button" class="connect-button" disabled>
            Connect Gravl
          </button>
          <p class="field-description">
            Gravl OAuth is not configured on this server, so use a personal token below. An administrator can
            register an OAuth app with Gravl and enter its client ID and secret in Admin Settings.
          </p>
        </>
      ) : (
        <>
          <button type="button" class="connect-button" onClick={handleConnect}>
            Connect Gravl
          </button>
          <p class="field-description">
            You will be redirected to Gravl to grant Aurboda read access to your workouts.
            {connection === 'token' && ' An OAuth connection takes precedence over the personal token.'}
          </p>
        </>
      )}
      {error && <p class="garmin-sync-message error">{error}</p>}
    </section>
  )
}

function GravlTokenSection({ connection }: { connection: GravlConnection }) {
  const queryClient = useQueryClient()
  const [token, setToken] = useState('')
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ status: 'idle' })

  const save = useCallback(
    async (value: string | null) => {
      setSaveStatus({ status: 'saving' })
      try {
        const result = await updateUserSettings({ gravl_api_token: value })
        queryClient.setQueryData(['userSettings'], result)
        setSaveStatus({ status: 'saved' })
      } catch (err) {
        setSaveStatus({ error: err instanceof Error ? err.message : 'Failed to save', status: 'error' })
      }
    },
    [queryClient],
  )

  const handleBlur = () => {
    if (!token) return
    void save(token)
    setToken('')
  }

  return (
    <section class="settings-section">
      <div class="section-header-row">
        <h2>Personal access token</h2>
        <SaveStatusIndicator state={saveStatus} />
      </div>
      {connection === 'token' && <p class="connected-status">Configured</p>}
      <div class="form-field">
        <input
          type="password"
          value={token}
          onInput={(e) => setToken((e.target as HTMLInputElement).value)}
          onBlur={handleBlur}
          placeholder={connection === 'token' ? 'Enter new token to update' : 'gat_…'}
        />
        <p class="field-description">
          Create a token with the <code>workouts:read</code> scope at{' '}
          <a href="https://gravl.ai/developers/personal-tokens" target="_blank" rel="noopener noreferrer">
            gravl.ai/developers/personal-tokens
          </a>
          . Saves automatically when you leave the field.
        </p>
        {connection === 'token' && (
          <button type="button" class="clear-button" onClick={() => void save(null)}>
            Remove token
          </button>
        )}
      </div>
    </section>
  )
}

function GravlSyncSection({
  syncStates,
  syncStatusLoading,
}: {
  syncStates: ProviderSyncStatus[] | undefined
  syncStatusLoading: boolean
}) {
  const queryClient = useQueryClient()
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'done' | 'error'>('idle')
  const [syncMessage, setSyncMessage] = useState('')

  const isSyncing = syncStates?.some((s) => s.status === 'syncing') ?? false
  const prevSyncingRef = useRef(false)
  useEffect(() => {
    if (prevSyncingRef.current && !isSyncing && syncStatus === 'syncing') {
      setSyncStatus('done')
      queryClient.invalidateQueries()
    }
    prevSyncingRef.current = isSyncing
  }, [isSyncing, syncStatus, queryClient])

  const handleSync = useCallback(
    async (fullResync: boolean) => {
      setSyncStatus('syncing')
      setSyncMessage('')
      try {
        const response = await syncGravl(fullResync)
        const result = response.result
        if (result?.status === 'success') {
          setSyncStatus('done')
          setSyncMessage(
            `${result.workouts_processed} workout(s): ${result.activities_enriched} enriched, ${result.activities_created} created` +
              (result.activities_retracted > 0
                ? `, ${result.activities_retracted} stale import(s) removed`
                : ''),
          )
          await queryClient.invalidateQueries()
        } else {
          setSyncStatus('error')
          setSyncMessage(result?.error ?? `Sync ${result?.status ?? 'failed'}`)
        }
        await queryClient.invalidateQueries({ queryKey: ['gravlSyncStatus'] })
      } catch (err) {
        setSyncStatus('error')
        setSyncMessage(err instanceof Error ? err.message : 'Sync failed')
      }
    },
    [queryClient],
  )

  const handleSyncNow = useCallback(() => handleSync(false), [handleSync])
  const handleFullResync = useCallback(() => handleSync(true), [handleSync])

  return (
    <>
      <SyncStatusBar states={syncStates} isLoading={syncStatusLoading} onSyncNow={handleSyncNow} />
      <div class="garmin-button-row">
        <button
          type="button"
          class="connect-button"
          disabled={syncStatus === 'syncing'}
          onClick={handleFullResync}
        >
          {syncStatus === 'syncing' ? 'Syncing...' : 'Full Re-sync (90 days)'}
        </button>
      </div>
      {syncMessage && <p class={`garmin-sync-message ${syncStatus}`}>{syncMessage}</p>}
    </>
  )
}

export function GravlSource() {
  const isLoggedIn = auth.value.token
  const queryClient = useQueryClient()

  const { data: userSettings, isLoading } = useQuery({
    enabled: !!isLoggedIn,
    queryFn: fetchUserSettings,
    queryKey: ['userSettings'],
  })

  const connection: GravlConnection = userSettings?.gravl_connection ?? null
  const isConfigured = userSettings?.gravl_configured ?? false
  const isConnected = connection !== null

  const { data: syncStatusData, isLoading: syncStatusLoading } = useQuery({
    enabled: !!isLoggedIn && isConnected,
    queryFn: fetchGravlSyncStatus,
    queryKey: ['gravlSyncStatus'],
    refetchInterval: isConnected ? 5000 : false,
  })

  const refreshSettings = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['userSettings'] })
  }, [queryClient])

  if (!isLoggedIn) return <LoginRequired />

  return (
    <div class="data-sources-page">
      <div class="page-header">
        <h1>Gravl</h1>
      </div>

      <div class="data-source-detail">
        <p class="source-description">
          <a href="https://gravl.ai/" target="_blank" rel="noopener noreferrer">
            Gravl
          </a>{' '}
          is a strength-training log. Aurboda reads your workouts through the Gravl API and attaches the
          actual sets — exercise, weight, reps, RPE — to the strength session Health Connect already
          delivered, or creates the activity when Health Connect did not. A session that arrives via Health
          Connect is enriched within minutes; everything else is picked up by the background poll.
        </p>

        <DataTypesList types={DATA_TYPES} />
        <StatusBanner connected={isConnected} label={connectionLabel(connection)} />

        <div class="links-row">
          <a
            href="https://github.com/fiddur/aurboda/blob/develop/docs/gravl.md"
            target="_blank"
            rel="noopener noreferrer"
            class="doc-link"
          >
            Gravl integration documentation
          </a>
          <a
            href="https://gravl.ai/developers"
            target="_blank"
            rel="noopener noreferrer"
            class="external-link"
          >
            Gravl developer docs
          </a>
        </div>

        {isConnected && (
          <GravlSyncSection syncStates={syncStatusData?.states} syncStatusLoading={syncStatusLoading} />
        )}

        {isLoading ? (
          <div class="loading">Loading...</div>
        ) : (
          <>
            <GravlOAuthSection
              connection={connection}
              isConfigured={isConfigured}
              onDisconnected={refreshSettings}
            />
            <GravlTokenSection connection={connection} />
            <SyncIntervalField provider="gravl" />
          </>
        )}
      </div>
    </div>
  )
}
