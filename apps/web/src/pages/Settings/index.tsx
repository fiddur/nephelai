import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'preact/hooks'

import type { BiologicalSex, HrZoneThresholds, UpdateSettingsInput } from '../../state/api'

import { AvatarSettings } from '../../components/AvatarSettings'
import { MealPreferencesSettings } from '../../components/MealPreferencesSettings'
import { PasskeySettings } from '../../components/PasskeySettings'
import { type SaveStatus, SaveStatusIndicator } from '../../components/SaveStatusIndicator'
import { SettingsSection } from '../../components/SettingsSection'
import { fetchUserSettings, updateUserSettings } from '../../state/api'
import { auth } from '../../state/auth'
import { defaultHrZoneThresholds } from '../../utils/hrZones'
import { parseZoneValue, updateZoneThreshold, validateHrZoneThresholds } from '../../utils/settings'
import './style.css'

export function Settings() {
  const isLoggedIn = auth.value.token
  const queryClient = useQueryClient()

  const { data: userSettings, isLoading } = useQuery({
    enabled: !!isLoggedIn,
    queryFn: fetchUserSettings,
    queryKey: ['userSettings'],
  })

  // Form state
  const [birthDate, setBirthDate] = useState<string>('')
  const [sex, setSex] = useState<BiologicalSex | null>(null)
  const [hrZones, setHrZones] = useState<HrZoneThresholds | null>(null)
  const [manualApproval, setManualApproval] = useState(false)
  const [showReplies, setShowReplies] = useState(false)

  // Save status for each section
  const [personalInfoStatus, setPersonalInfoStatus] = useState<SaveStatus>({ status: 'idle' })
  const [hrZonesStatus, setHrZonesStatus] = useState<SaveStatus>({ status: 'idle' })
  const [followersStatus, setFollowersStatus] = useState<SaveStatus>({ status: 'idle' })

  // Initialize form when data loads
  const initializeForm = () => {
    setBirthDate(userSettings?.birth_date ?? '')
    setSex(userSettings?.sex ?? null)
    setHrZones(userSettings?.hr_zone_start ?? null)
    setManualApproval(userSettings?.manually_approve_followers ?? false)
    setShowReplies(userSettings?.timeline_show_replies ?? false)
  }

  // Track if form has been initialized
  const [initialized, setInitialized] = useState(false)
  if (userSettings && !initialized) {
    initializeForm()
    setInitialized(true)
  }

  // Generic save function for a section
  const saveSection = useCallback(
    async (params: UpdateSettingsInput, setStatus: (s: SaveStatus) => void) => {
      setStatus({ status: 'saving' })
      try {
        const result = await updateUserSettings(params)
        queryClient.setQueryData(['userSettings'], result)
        setStatus({ status: 'saved', time: new Date() })
      } catch (err) {
        setStatus({
          error: err instanceof Error ? err.message : 'Failed to save',
          status: 'error',
        })
      }
    },
    [queryClient],
  )

  const handleBirthDateChange = (e: Event) => {
    const value = (e.target as HTMLInputElement).value
    setBirthDate(value)
  }

  const handleBirthDateBlur = () => {
    const serverValue = userSettings?.birth_date ?? ''
    if (birthDate === serverValue) return

    // Validate format if not empty
    if (birthDate && !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
      setPersonalInfoStatus({ error: 'Invalid date format', status: 'error' })
      return
    }

    saveSection({ birth_date: birthDate || null }, setPersonalInfoStatus)
  }

  const handleSexChange = (e: Event) => {
    const value = (e.target as HTMLSelectElement).value
    const newSex = value === '' ? null : (value as BiologicalSex)
    setSex(newSex)
    saveSection({ sex: newSex }, setPersonalInfoStatus)
  }

  const handleZoneChange = (zone: keyof HrZoneThresholds, value: string) => {
    const numValue = parseZoneValue(value)
    if (numValue === null) return

    setHrZones(updateZoneThreshold(hrZones, zone, numValue))
  }

  const handleZoneBlur = () => {
    const currentZones = hrZones ?? defaultHrZoneThresholds
    const serverZones = userSettings?.hr_zone_start ?? defaultHrZoneThresholds

    if (JSON.stringify(currentZones) === JSON.stringify(serverZones)) return

    // Validate zones
    const validation = validateHrZoneThresholds(currentZones)
    if (!validation.valid) {
      setHrZonesStatus({ error: validation.error, status: 'error' })
      return
    }

    saveSection({ hr_zone_start: hrZones }, setHrZonesStatus)
  }

  const handleResetZones = () => {
    setHrZones(null)
    saveSection({ hr_zone_start: null }, setHrZonesStatus)
  }

  const handleManualApprovalChange = (e: Event) => {
    const checked = (e.target as HTMLInputElement).checked
    setManualApproval(checked)
    saveSection({ manually_approve_followers: checked }, setFollowersStatus)
  }

  const handleShowRepliesChange = (e: Event) => {
    const checked = (e.target as HTMLInputElement).checked
    setShowReplies(checked)
    saveSection({ timeline_show_replies: checked }, setFollowersStatus)
  }

  if (!isLoggedIn) {
    return (
      <div class="settings-page">
        <h1>Settings</h1>
        <p>Please log in to view and edit your settings.</p>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div class="settings-page">
        <h1>Settings</h1>
        <p class="loading">Loading...</p>
      </div>
    )
  }

  const displayZones = hrZones ?? defaultHrZoneThresholds

  return (
    <div class="settings-page">
      <h1>Settings</h1>

      <AvatarSettings />

      <SettingsSection
        title="Personal Information"
        headerExtra={<SaveStatusIndicator state={personalInfoStatus} />}
      >
        <div class="form-field">
          <label for="birth-date">Birth Date</label>
          <input
            id="birth-date"
            type="date"
            value={birthDate}
            onInput={handleBirthDateChange}
            onBlur={handleBirthDateBlur}
          />
          <p class="field-description">
            Used to calculate age-based HR zone thresholds if custom zones are not set.
          </p>
        </div>

        <div class="form-field">
          <label for="sex">Biological Sex</label>
          <select id="sex" value={sex ?? ''} onChange={handleSexChange}>
            <option value="">Not set</option>
            <option value="male">Male</option>
            <option value="female">Female</option>
          </select>
          <p class="field-description">
            Required for calorie burn estimation from heart rate data. Setting this enables automatic calorie
            computation.
          </p>
        </div>
      </SettingsSection>

      <SettingsSection
        title="HR Zone Thresholds"
        description="Customize the heart rate thresholds for each zone. These values represent the starting BPM for each zone. Changes save automatically."
        headerExtra={<SaveStatusIndicator state={hrZonesStatus} />}
      >
        <div class="hr-zones-form">
          {([1, 2, 3, 4, 5] as const).map((zone) => (
            <div class="zone-input" key={zone}>
              <label for={`zone-${zone}`}>Zone {zone} starts at</label>
              <div class="input-with-unit">
                <input
                  id={`zone-${zone}`}
                  type="number"
                  min="40"
                  max="220"
                  value={displayZones[zone]}
                  onInput={(e) => handleZoneChange(zone, (e.target as HTMLInputElement).value)}
                  onBlur={handleZoneBlur}
                />
                <span class="unit">bpm</span>
              </div>
            </div>
          ))}
        </div>

        <button type="button" class="reset-zones-button" onClick={handleResetZones}>
          Reset to defaults
        </button>
        {hrZones === null && (
          <p class="field-description">Using default thresholds (or age-based if birth date is set).</p>
        )}
      </SettingsSection>

      <SettingsSection
        title="Feed & Followers"
        description="Control who can follow your federated feed."
        headerExtra={<SaveStatusIndicator state={followersStatus} />}
      >
        <div class="form-field">
          <label class="checkbox-field">
            <input type="checkbox" checked={manualApproval} onChange={handleManualApprovalChange} />
            <span>Manually approve new followers</span>
          </label>
          <p class="field-description">
            When on, incoming follows become requests you approve or reject, and only approved followers see
            your <code>followers</code>-only posts. When off (the default), anyone can follow you
            automatically.
          </p>
        </div>
        <div class="form-field">
          <label class="checkbox-field">
            <input type="checkbox" checked={showReplies} onChange={handleShowRepliesChange} />
            <span>Show replies in your timeline</span>
          </label>
          <p class="field-description">
            When on, every reply the people you follow write shows as its own timeline card. When off (the
            default), replies to posts that aren’t in your timeline are hidden — replies to your own posts,
            posts mentioning you, and replies within a thread you already see always show.
          </p>
        </div>
      </SettingsSection>

      <MealPreferencesSettings />

      <PasskeySettings />

      <section class="settings-section">
        <p class="section-description">
          Data source settings (Oura, RescueTime, Last.fm, ActivityWatch, Calendars) and related configuration
          (screen time categories, tag mappings, custom metrics, goals) have moved to{' '}
          <a href="/data-sources">Data Sources</a>.
        </p>
      </section>

      <section class="settings-section">
        <h2>Audit Log</h2>
        <p class="section-description">
          View recent system events, sync operations, and errors. <a href="/audit-log">View audit log</a>
        </p>
      </section>
    </div>
  )
}
