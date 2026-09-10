package net.aurboda

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.AlertDialog
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.changes.DeletionChange
import androidx.health.connect.client.changes.UpsertionChange
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.*
import androidx.health.connect.client.request.ChangesTokenRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import net.aurboda.ui.theme.AurbodaAppTheme
import net.aurboda.update.DownloadState
import net.aurboda.update.UpdateAvailableDialog
import net.aurboda.update.UpdateCheckResult
import net.aurboda.update.UpdateDownloadingDialog
import net.aurboda.update.UpdateErrorDialog
import net.aurboda.update.UpdateReadyToInstallDialog
import net.aurboda.update.VersionInfo
import net.aurboda.update.checkForUpdate
import net.aurboda.update.downloadUpdate
import net.aurboda.update.getExistingDownloadState
import net.aurboda.update.installApk
// Import record type lists from HealthDataModels
import net.aurboda.allRecordTypes
import net.aurboda.writableRecordTypes
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.temporal.ChronoUnit
import kotlin.reflect.KClass

private const val PREFS_NAME = "AurbodaAppPrefs"
private const val CHANGES_TOKEN_KEY = "healthConnectChangesToken"
private const val BACKGROUND_SYNC_ENABLED_KEY = "backgroundSyncEnabled"
private const val GRANTED_TYPES_KEY = "grantedRecordTypeNames"

private fun isBackgroundSyncEnabled(context: Context): Boolean {
  val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
  return prefs.getBoolean(BACKGROUND_SYNC_ENABLED_KEY, false)
}

private fun setBackgroundSyncEnabled(
  context: Context,
  enabled: Boolean,
) {
  val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
  prefs.edit().putBoolean(BACKGROUND_SYNC_ENABLED_KEY, enabled).apply()
  if (enabled) {
    SyncWorker.schedule(context)
  } else {
    SyncWorker.cancel(context)
  }
}

private fun saveChangesToken(
  context: Context,
  token: String?,
) {
  val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
  Log.d("TokenManager", "Saving token: ${token?.take(10)}...")
  prefs.edit().putString(CHANGES_TOKEN_KEY, token).apply()
}

private fun loadChangesToken(context: Context): String? {
  val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
  val token = prefs.getString(CHANGES_TOKEN_KEY, null)
  Log.d("TokenManager", "Loaded token: ${token?.take(10)}...")
  return token
}

/**
 * Check if the set of granted record types has changed since last fetch.
 * If changed, invalidate the changes token to force a full re-fetch.
 */
private fun invalidateTokenIfGrantedTypesChanged(
  context: Context,
  currentGrantedTypes: List<KClass<out Record>>,
) {
  val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
  val currentNames = currentGrantedTypes.map { it.simpleName ?: "" }.sorted().joinToString(",")
  val savedNames = prefs.getString(GRANTED_TYPES_KEY, null)

  if (savedNames != null && savedNames != currentNames) {
    Log.d("TokenManager", "Granted types changed, invalidating changes token")
    prefs
      .edit()
      .remove(CHANGES_TOKEN_KEY)
      .putString(GRANTED_TYPES_KEY, currentNames)
      .apply()
  } else {
    prefs.edit().putString(GRANTED_TYPES_KEY, currentNames).apply()
  }
}

class MainActivity : ComponentActivity() {
  companion object {
    const val EXTRA_OPEN_TAB = "open_tab"
    const val TAB_ADD = "add"
    const val TAB_FEED = "feed"
    const val TAB_MORE = "more"

    /** With [EXTRA_OPEN_TAB] = [TAB_MORE], the More web page to open (e.g. "/goals"). */
    const val EXTRA_MORE_PATH = "more_path"
  }

  /**
   * A deep link delivered while the activity was already running. Wrapped with a
   * sequence number so tapping the same widget twice re-navigates (a plain
   * DeepLink would compare equal and not retrigger the effect).
   */
  private var runningDeepLink by mutableStateOf<DeepLinkEvent?>(null)
  private var deepLinkSeq = 0L

  // Deep links (widget / notification) steer the initial screen on a cold start
  // and, because the activity is `singleTop`, arrive in onNewIntent when the app
  // is already open — where they navigate the running app to the same place.
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val link = deepLinkFrom(intent)
    setContent {
      AurbodaAppShell {
        AutoEnablePostNotifications()
        AurbodaApp(initialTab = link?.tab, initialMorePath = link?.morePath, deepLinkEvent = runningDeepLink)
      }
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    deepLinkFrom(intent)?.let { runningDeepLink = DeepLinkEvent(++deepLinkSeq, it) }
  }

  private fun deepLinkFrom(intent: Intent?): DeepLink? =
    deepLinkFrom(intent?.getStringExtra(EXTRA_OPEN_TAB), intent?.getStringExtra(EXTRA_MORE_PATH))
}

/** A deep link that arrived at a running activity; [seq] makes every arrival distinct. */
data class DeepLinkEvent(val seq: Long, val link: DeepLink)

/**
 * The themed surface every screen is drawn on, sized to keep [content] above the
 * soft keyboard.
 *
 * Apps targeting API 35+ are edge-to-edge, so the window no longer resizes for
 * the IME (`adjustResize` is ignored) and the keyboard covers whatever is
 * focused — a native text field, or an input in an embedded web page. Consuming
 * [keyboardInsets] here shrinks the WebView too, which is what makes it scroll
 * the focused element into view. It also zeroes the navigation-bar inset the
 * bottom bar would otherwise add on top, so the bar lands flush above the
 * keyboard.
 *
 * [keyboardInsets] is a parameter so tests can supply a fixed inset instead of
 * driving the platform's IME.
 */
@Composable
fun AurbodaAppShell(
  keyboardInsets: WindowInsets = WindowInsets.ime,
  content: @Composable () -> Unit,
) {
  AurbodaAppTheme {
    Surface(
      modifier = Modifier.fillMaxSize().windowInsetsPadding(keyboardInsets),
      color = MaterialTheme.colorScheme.background,
    ) {
      content()
    }
  }
}

private const val VERSION_JSON_URL = "https://github.com/fiddur/aurboda/releases/latest/download/version.json"

@Suppress("ASSIGNED_VALUE_IS_NEVER_READ") // Compose state vars trigger false "assigned but never read" warnings
@Composable
fun AurbodaApp(
  initialTab: MainTab? = null,
  initialMorePath: String? = null,
  deepLinkEvent: DeepLinkEvent? = null,
) {
  // A widget/notification deep link into a More web page opens it on first
  // composition; tapping More later returns to the hub (AppState.selectTab).
  val appState = rememberAppState(initialTab = initialTab, initialMorePath = initialMorePath)
  // ...and one that arrives while the app is running (onNewIntent) navigates in place.
  LaunchedEffect(deepLinkEvent) { deepLinkEvent?.let { appState.open(it.link) } }
  val context = LocalContext.current
  val scope = rememberCoroutineScope()
  val ktorHttpClient = remember { syncHttpClient() }

  // Update check state
  var updateAvailable by remember { mutableStateOf<VersionInfo?>(null) }
  var showUpdateDialog by remember { mutableStateOf(false) }
  var showDownloadingDialog by remember { mutableStateOf(false) }
  var showInstallDialog by remember { mutableStateOf(false) }
  var downloadedApkFile by remember { mutableStateOf<File?>(null) }
  var updateError by remember { mutableStateOf<String?>(null) }

  // Check for updates on app launch
  LaunchedEffect(Unit) {
    val currentVersionCode = BuildConfig.VERSION_CODE_INT
    Log.d("UpdateChecker", "Checking for updates. Current version code: $currentVersionCode")
    when (val result = checkForUpdate(ktorHttpClient, VERSION_JSON_URL, currentVersionCode)) {
      is UpdateCheckResult.UpdateAvailable -> {
        Log.d("UpdateChecker", "Update available: ${result.versionInfo.versionName}")
        updateAvailable = result.versionInfo

        // Check if we already have this download in progress or finished
        when (val downloadState = getExistingDownloadState(context, result.versionInfo.versionName)) {
          is DownloadState.Downloaded -> {
            Log.d("UpdateChecker", "APK already downloaded: ${downloadState.apkFile.name}")
            downloadedApkFile = downloadState.apkFile
            showInstallDialog = true
          }
          is DownloadState.InProgress -> {
            Log.d("UpdateChecker", "Download already in progress")
            showDownloadingDialog = true
          }
          is DownloadState.None -> {
            showUpdateDialog = true
          }
        }
      }
      is UpdateCheckResult.NoUpdate -> {
        Log.d("UpdateChecker", "No update available")
      }
      is UpdateCheckResult.Error -> {
        Log.w("UpdateChecker", "Error checking for updates: ${result.message}")
      }
    }
  }

  // Update dialogs
  if (showUpdateDialog && updateAvailable != null) {
    UpdateAvailableDialog(
      versionInfo = updateAvailable!!,
      onUpdate = {
        showUpdateDialog = false
        showDownloadingDialog = true
        downloadUpdate(
          context = context,
          downloadUrl = updateAvailable!!.downloadUrl,
          versionName = updateAvailable!!.versionName,
          onDownloadComplete = { apkFile ->
            scope.launch {
              showDownloadingDialog = false
              downloadedApkFile = apkFile
              showInstallDialog = true
            }
          },
          onDownloadFailed = { error ->
            scope.launch {
              showDownloadingDialog = false
              updateError = error
            }
          },
        )
      },
      onDismiss = { showUpdateDialog = false },
    )
  }

  if (showInstallDialog && updateAvailable != null && downloadedApkFile != null) {
    UpdateReadyToInstallDialog(
      versionInfo = updateAvailable!!,
      onInstall = {
        showInstallDialog = false
        installApk(context, downloadedApkFile!!)
      },
      onDismiss = { showInstallDialog = false },
    )
  }

  if (showDownloadingDialog) {
    UpdateDownloadingDialog(
      onDismiss = { showDownloadingDialog = false },
    )
  }

  updateError?.let { error ->
    UpdateErrorDialog(
      errorMessage = error,
      onDismiss = { updateError = null },
    )
  }

  when (appState.currentScreen) {
    AppScreen.Login -> {
      val context = LocalContext.current
      net.aurboda.ui.screens.LoginScreen(
        initialServerUrl = appState.pendingServerUrl,
        onSaveCredentials = { serverUrl, username, token ->
          CredentialsManager.saveCredentials(context, serverUrl, username, token)
        },
        onLoginSuccess = { appState.onLoginSuccess() },
      )
    }
    AppScreen.Main -> {
      val credentials = appState.credentials
      if (credentials != null) {
        net.aurboda.ui.screens.MainScreen(
          currentTab = appState.currentTab,
          onTabSelected = { appState.selectTab(it) },
          homeContent = { modifier ->
            net.aurboda.ui.screens.EmbeddedWebScreen(
              url = "${credentials.serverUrl.trimEnd('/')}/?embed=1",
              baseUrl = credentials.serverUrl,
              username = credentials.username,
              authToken = credentials.authToken,
              modifier = modifier,
            )
          },
          syncContent = { modifier ->
            HealthConnectScreen(
              apiUrl = credentials.apiUrl,
              authToken = credentials.authToken,
              modifier = modifier,
            )
          },
          addContent = { modifier ->
            net.aurboda.ui.screens.AddDataScreen(
              apiUrl = credentials.apiUrl,
              authToken = credentials.authToken,
              modifier = modifier,
            )
          },
          feedContent = { modifier ->
            net.aurboda.ui.screens.EmbeddedWebScreen(
              url = "${credentials.serverUrl.trimEnd('/')}/feed?embed=1",
              baseUrl = credentials.serverUrl,
              username = credentials.username,
              authToken = credentials.authToken,
              modifier = modifier,
            )
          },
          moreContent = { modifier ->
            net.aurboda.ui.screens.MoreScreen(
              credentials = credentials,
              destination = appState.moreDestination,
              onSelect = { destination -> appState.openMoreDestination(destination) },
              onBack = { appState.closeMoreDestination() },
              onServerUrlChange = { newUrl -> appState.changeServerUrl(newUrl) },
              onLogout = { appState.logout() },
              modifier = modifier,
            )
          },
        )
      } else {
        // Should not happen, but handle gracefully
        appState.logout()
      }
    }
  }
}

@Suppress("ASSIGNED_VALUE_IS_NEVER_READ") // Compose state vars trigger false "assigned but never read" warnings
@Composable
fun HealthConnectScreen(
  apiUrl: String,
  authToken: String,
  modifier: Modifier = Modifier,
) {
  val context = LocalContext.current
  val lifecycleOwner = LocalLifecycleOwner.current
  val healthConnectClient = remember { HealthConnectClient.getOrCreate(context) }

  // -- Permission state (partial permissions support) --
  var grantedPermissions by remember { mutableStateOf<Set<String>>(emptySet()) }
  val grantedRecordTypes by remember(grantedPermissions) {
    derivedStateOf { getGrantedRecordTypes(grantedPermissions) }
  }
  val hasAnyPermissions by remember(grantedRecordTypes) {
    derivedStateOf { grantedRecordTypes.isNotEmpty() }
  }
  val hasAllReadPermissions by remember(grantedPermissions) {
    derivedStateOf {
      val readPerms = allRecordTypes.map { HealthPermission.getReadPermission(it) }.toSet()
      grantedPermissions.containsAll(readPerms)
    }
  }
  val hasAllWritePermissions by remember(grantedPermissions) {
    derivedStateOf {
      val writePerms = writableRecordTypes.map { HealthPermission.getWritePermission(it) }.toSet()
      grantedPermissions.containsAll(writePerms)
    }
  }
  val hasAllPermissions by remember(hasAllReadPermissions, hasAllWritePermissions) {
    derivedStateOf { hasAllReadPermissions && hasAllWritePermissions }
  }
  val categoryStatuses by remember(grantedPermissions) {
    derivedStateOf { getCategoryStatuses(grantedPermissions) }
  }

  val reporter = remember(context) { context.syncProgressReporter() }
  val progressState by reporter.state.collectAsState()
  val isProcessing = progressState.isRunning
  var permissionStatusMessage by remember { mutableStateOf("Checking permissions...") }
  var backgroundSyncEnabled by remember { mutableStateOf(isBackgroundSyncEnabled(context)) }
  var showBatteryOptimizationDialog by remember { mutableStateOf(false) }
  val bgSyncStatusFlow = remember(context) {
    (context.applicationContext as? AurbodaApplication)?.backgroundSyncStatus
      ?: kotlinx.coroutines.flow.MutableStateFlow(BackgroundSyncStatus())
  }
  val bgSyncStatus by bgSyncStatusFlow.collectAsState()

  // -- ActivityWatch state --
  var awSyncEnabled by remember { mutableStateOf(isActivityWatchSyncEnabled(context)) }
  var awSyncResult by remember { mutableStateOf<ActivityWatchSyncResult?>(null) }

  val batteryOptimizationLauncher =
    rememberLauncherForActivityResult(
      contract = ActivityResultContracts.StartActivityForResult(),
    ) {
      if (isIgnoringBatteryOptimizations(context)) {
        Log.d("BatteryOptimization", "Battery optimization exemption granted")
      } else {
        Log.d("BatteryOptimization", "Battery optimization exemption was not granted")
      }
    }

  val scope = rememberCoroutineScope()
  val allPermissions =
    remember(allRecordTypes) {
      val readPerms = allRecordTypes.map { HealthPermission.getReadPermission(it) }
      val writePerms = writableRecordTypes.map { HealthPermission.getWritePermission(it) }
      (readPerms + writePerms + HC_BACKGROUND_READ_PERMISSION).toSet()
    }
  val hasBackgroundReadPermission by remember(grantedPermissions) {
    derivedStateOf { HC_BACKGROUND_READ_PERMISSION in grantedPermissions }
  }
  val ktorHttpClient = remember { syncHttpClient() }

  /**
   * Sync Health Connect data incrementally: fetch and send page by page.
   *
   * For initial sync (no token): reads last 7 days per record type and sends each type immediately.
   * For incremental sync (has token): processes each getChanges() page and sends immediately.
   * Saves the changes token after each successful send so progress is never lost.
   */
  suspend fun syncHealthData(currentActiveContext: Context) {
    if (grantedRecordTypes.isEmpty()) {
      reporter.updateStage(SyncStage.HealthConnect) {
        it.copy(status = SyncStageStatus.Skipped, message = "No permissions granted")
      }
      Log.d("SyncData", "syncHealthData called but no granted types.")
      return
    }
    val typesToFetch = grantedRecordTypes
    Log.d("SyncData", "Starting sync for ${typesToFetch.size} granted types...")
    invalidateTokenIfGrantedTypesChanged(currentActiveContext, typesToFetch)
    val lastTokenFromPrefs = loadChangesToken(currentActiveContext)

    reporter.updateStage(SyncStage.HealthConnect) {
      it.copy(status = SyncStageStatus.Active, message = "Reading from Health Connect…", sentRecords = 0, sentDeletions = 0)
    }

    if (lastTokenFromPrefs == null) {
      Log.d("SyncData", "No token found. Performing initial sync.")
      try {
        val sevenDaysAgo = ZonedDateTime.now().minusDays(7).toInstant()
        val now = Instant.now()
        var totalSent = 0

        for (recordType: KClass<out Record> in typesToFetch) {
          try {
            @Suppress("UNCHECKED_CAST")
            val specificRecordType = recordType as KClass<Record>
            val request =
              ReadRecordsRequest(
                recordType = specificRecordType,
                timeRangeFilter = TimeRangeFilter.between(sevenDaysAgo, now),
                ascendingOrder = false,
              )
            val recordsOfType =
              healthConnectClient
                .readRecords(request)
                .records
                .filterNotOwnOrigin()

            if (recordsOfType.isNotEmpty()) {
              Log.d("SyncData", "Fetched ${recordsOfType.size} ${recordType.simpleName} records, sending...")
              recordsOfType.oldestModifiedTime()?.let(reporter::reportDataInstant)
              val result = sendRecords(recordsOfType, apiUrl, authToken, ktorHttpClient, reporter, "SyncData")
              if (!result.isSuccess) {
                reporter.updateStage(SyncStage.HealthConnect) {
                  it.copy(status = SyncStageStatus.Failed, errorMessage = result.errorMessage())
                }
                Log.w("SyncData", "Failed to send ${recordType.simpleName}: ${result.errorMessage()}")
                return
              }
              totalSent += recordsOfType.size
              reporter.updateStage(SyncStage.HealthConnect) { it.copy(sentRecords = totalSent) }
            }
          } catch (e: Exception) {
            Log.w("SyncData", "Error fetching ${recordType.simpleName}: ${e.message}")
          }
        }

        try {
          val initialToken = healthConnectClient.getChangesToken(ChangesTokenRequest(typesToFetch.toSet()))
          saveChangesToken(currentActiveContext, initialToken)
          Log.d("SyncData", "Initial sync complete. Sent $totalSent records. Token saved.")
          reporter.updateStage(SyncStage.HealthConnect) {
            it.copy(
              status = SyncStageStatus.Done,
              message = if (totalSent > 0) "Initial sync: $totalSent records" else "No records found",
            )
          }
        } catch (e: Exception) {
          Log.e("SyncData", "Failed to get/save initial changes token.", e)
          reporter.updateStage(SyncStage.HealthConnect) {
            it.copy(status = SyncStageStatus.Failed, errorMessage = "token error: ${e.message}")
          }
        }
      } catch (e: Exception) {
        Log.e("SyncData", "Error during initial sync.", e)
        reporter.updateStage(SyncStage.HealthConnect) {
          it.copy(status = SyncStageStatus.Failed, errorMessage = e.message)
        }
      }
    } else {
      Log.d("SyncData", "Token found: ${lastTokenFromPrefs.take(10)}... Fetching changes.")
      try {
        var currentToken: String = lastTokenFromPrefs
        var hasMore = true
        var pageNum = 0
        var totalRecords = 0
        var totalDeletions = 0

        while (hasMore) {
          pageNum++
          val changesResponse = healthConnectClient.getChanges(currentToken)

          val upsertions =
            changesResponse.changes
              .mapNotNull { if (it is UpsertionChange) it.record else null }
              .filterNotOwnOrigin()

          val deletionIds =
            changesResponse.changes
              .filterIsInstance<DeletionChange>()
              .map { it.recordId }

          if (upsertions.isNotEmpty() || deletionIds.isNotEmpty()) {
            Log.d("SyncData", "Page $pageNum: ${upsertions.size} records, ${deletionIds.size} deletions")
            upsertions.oldestModifiedTime()?.let(reporter::reportDataInstant)
            reporter.updateStage(SyncStage.HealthConnect) {
              it.copy(
                currentPage = pageNum,
                message = "Page $pageNum (${upsertions.size} records, ${deletionIds.size} deletions)",
              )
            }
            val result = sendPage(upsertions, deletionIds, apiUrl, authToken, ktorHttpClient, reporter, "SyncData")
            if (!result.isSuccess) {
              reporter.updateStage(SyncStage.HealthConnect) {
                it.copy(status = SyncStageStatus.Failed, errorMessage = result.errorMessage())
              }
              Log.w("SyncData", "Page $pageNum failed: ${result.errorMessage()}")
              return
            }
            totalRecords += upsertions.size
            totalDeletions += deletionIds.size
            reporter.updateStage(SyncStage.HealthConnect) {
              it.copy(sentRecords = totalRecords, sentDeletions = totalDeletions)
            }
          }

          currentToken = changesResponse.nextChangesToken
          saveChangesToken(currentActiveContext, currentToken)
          hasMore = changesResponse.hasMore
        }

        if (totalRecords > 0 || totalDeletions > 0) {
          val parts = buildList {
            if (totalRecords > 0) add("$totalRecords records")
            if (totalDeletions > 0) add("$totalDeletions deletions")
          }
          reporter.updateStage(SyncStage.HealthConnect) {
            it.copy(
              status = SyncStageStatus.Done,
              totalPages = pageNum,
              message = "${parts.joinToString(", ")} ($pageNum pages)",
            )
          }
          Log.d("SyncData", "Incremental sync complete: ${parts.joinToString(", ")} across $pageNum pages")
        } else {
          reporter.updateStage(SyncStage.HealthConnect) {
            it.copy(status = SyncStageStatus.Done, message = "Up to date")
          }
          Log.d("SyncData", "No new changes found")
        }
      } catch (e: Exception) {
        Log.e("SyncData", "Error during incremental sync.", e)
        reporter.updateStage(SyncStage.HealthConnect) {
          it.copy(status = SyncStageStatus.Failed, errorMessage = e.message)
        }
      }
    }
  }

  /** Re-query actual granted permissions from system after launcher returns. */
  suspend fun refreshPermissions() {
    grantedPermissions = healthConnectClient.permissionController.getGrantedPermissions()
    val count = grantedRecordTypes.size
    Log.d("HealthConnect", "Permissions refreshed: $count/${allRecordTypes.size} types granted")
    permissionStatusMessage =
      if (count > 0) "$count of ${allRecordTypes.size} data types authorized."
      else "No permissions granted."
  }

  val requestPermissionLauncher =
    rememberLauncherForActivityResult(
      contract = ActivityResultContracts.RequestMultiplePermissions(),
    ) { _ ->
      // Don't trust the launcher result -- re-query actual permissions from system
      scope.launch {
        refreshPermissions()
        if (grantedRecordTypes.isNotEmpty() && !reporter.state.value.isRunning) {
          reporter.begin()
          try {
            syncHealthData(context)
          } finally {
            reporter.end()
          }
        }
      }
    }

  suspend fun checkPermissionsAndSync(
    coroutineScope: CoroutineScope,
    currentContext: Context,
  ) {
    grantedPermissions = healthConnectClient.permissionController.getGrantedPermissions()
    val grantedCount = grantedRecordTypes.size
    Log.d("HealthConnect", "Permission check: $grantedCount/${allRecordTypes.size} types granted")

    if (grantedCount > 0) {
      permissionStatusMessage = "$grantedCount of ${allRecordTypes.size} data types authorized."
      coroutineScope.launch {
        if (reporter.state.value.isRunning) return@launch
        reporter.begin()
        try {
          syncHealthData(currentContext)
        } finally {
          reporter.end()
        }
      }
    } else {
      permissionStatusMessage = "No permissions granted. Requesting access..."
      requestPermissionLauncher.launch(allPermissions.toTypedArray())
    }
  }

  /** Perform full sync: aggregates + Health Connect data + outbound + ActivityWatch. */
  suspend fun syncNow(currentContext: Context) {
    if (reporter.state.value.isRunning) return
    reporter.begin()
    var fatal: String? = null
    try {
      // Daily aggregates
      try {
        val aggregates = fetchDailyAggregates(healthConnectClient, grantedRecordTypes.toSet(), days = 7)
        if (aggregates.isNotEmpty()) {
          sendDailyAggregates(aggregates, apiUrl, authToken, ktorHttpClient, reporter)
        } else {
          reporter.updateStage(SyncStage.DailyAggregates) {
            it.copy(status = SyncStageStatus.Done, message = "Nothing to send")
          }
        }
      } catch (e: Exception) {
        Log.w("SyncNow", "Daily aggregate sync failed: ${e.message}", e)
        reporter.updateStage(SyncStage.DailyAggregates) {
          it.copy(status = SyncStageStatus.Failed, errorMessage = e.message)
        }
      }

      syncHealthData(currentContext)

      try {
        processOutboundSync(
          apiUrl = apiUrl,
          authToken = authToken,
          httpClient = ktorHttpClient,
          healthConnectClient = healthConnectClient,
          grantedPermissions = grantedPermissions,
          reporter = reporter,
        )
      } catch (e: Exception) {
        Log.w("OutboundSync", "Outbound sync failed in syncNow: ${e.message}", e)
        reporter.updateStage(SyncStage.Outbound) {
          it.copy(status = SyncStageStatus.Failed, errorMessage = e.message)
        }
      }

      if (awSyncEnabled) {
        reporter.updateStage(SyncStage.ActivityWatch) {
          it.copy(status = SyncStageStatus.Active, message = "Syncing app usage…")
        }
        try {
          val r =
            processActivityWatchSync(
              apiUrl = apiUrl,
              authToken = authToken,
              httpClient = ktorHttpClient,
              context = currentContext,
            )
          awSyncResult = r
          reporter.updateStage(SyncStage.ActivityWatch) {
            when {
              r.error != null -> it.copy(status = SyncStageStatus.Failed, errorMessage = r.error)
              !r.available -> it.copy(status = SyncStageStatus.Skipped, message = "Not detected")
              else -> it.copy(status = SyncStageStatus.Done, message = "${r.eventsPushed} events synced", sentRecords = r.eventsPushed)
            }
          }
        } catch (e: Exception) {
          Log.w("ActivityWatch", "AW sync failed in syncNow: ${e.message}", e)
          awSyncResult = ActivityWatchSyncResult(error = e.message)
          reporter.updateStage(SyncStage.ActivityWatch) {
            it.copy(status = SyncStageStatus.Failed, errorMessage = e.message)
          }
        }
      }
    } catch (e: Exception) {
      fatal = e.message
      Log.e("SyncNow", "syncNow fatal: ${e.message}", e)
    } finally {
      reporter.end(fatal)
    }
  }

  LaunchedEffect(Unit) {
    Log.d("HealthConnectScreen", "LaunchedEffect: Initial check")
    checkPermissionsAndSync(this, context)
    if (backgroundSyncEnabled) {
      SyncWorker.schedule(context)
    }
  }

  DisposableEffect(lifecycleOwner) {
    val observer =
      LifecycleEventObserver { _, event ->
        if (event == Lifecycle.Event.ON_RESUME) {
          Log.d("HealthConnectScreen", "App resumed. HasAny: $hasAnyPermissions, IsProcessing: $isProcessing")
          if (hasAnyPermissions && !reporter.state.value.isRunning) {
            scope.launch {
              refreshPermissions()
              if (reporter.state.value.isRunning) return@launch
              reporter.begin()
              try {
                syncHealthData(context)
                try {
                  processOutboundSync(
                    apiUrl = apiUrl,
                    authToken = authToken,
                    httpClient = ktorHttpClient,
                    healthConnectClient = healthConnectClient,
                    grantedPermissions = grantedPermissions,
                    reporter = reporter,
                  )
                } catch (e: Exception) {
                  Log.w("OutboundSync", "Outbound sync failed on resume: ${e.message}")
                  reporter.updateStage(SyncStage.Outbound) {
                    it.copy(status = SyncStageStatus.Failed, errorMessage = e.message)
                  }
                }
              } finally {
                reporter.end()
              }
              net.aurboda.widget.HrZoneWidgetProvider
                .triggerUpdate(context)
              net.aurboda.widget.ChallengeWidgetProvider
                .triggerUpdate(context)
            }
          }
        }
      }
    lifecycleOwner.lifecycle.addObserver(observer)
    onDispose {
      lifecycleOwner.lifecycle.removeObserver(observer)
    }
  }

  // Periodic sync while app is open (when background sync is enabled)
  LaunchedEffect(backgroundSyncEnabled, hasAnyPermissions) {
    if (backgroundSyncEnabled && hasAnyPermissions) {
      Log.d("HealthConnectScreen", "Starting periodic sync loop (60s interval)")
      while (true) {
        delay(60_000L)
        if (!reporter.state.value.isRunning) {
          Log.d("HealthConnectScreen", "Periodic sync: fetching and sending data")
          syncNow(context)
        }
      }
    }
  }

  // --- UI ---

  LazyColumn(
    modifier = modifier.fillMaxSize().padding(16.dp),
    verticalArrangement = Arrangement.spacedBy(12.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    // -- Sync Status Card --
    item {
      androidx.compose.material3.Card(
        modifier = Modifier.fillMaxWidth(),
      ) {
        Column(
          modifier = Modifier.padding(16.dp),
          verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
          Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
          ) {
            Text(
              "Health Connect Sync",
              style = MaterialTheme.typography.titleMedium,
              fontWeight = FontWeight.Bold,
            )
            if (isProcessing) {
              androidx.compose.material3.CircularProgressIndicator(
                modifier = Modifier.height(16.dp).width(16.dp),
                strokeWidth = 2.dp,
              )
            }
          }

          SyncProgressView(
            state = progressState,
            permissionStatusMessage = permissionStatusMessage,
            activityWatchEnabled = awSyncEnabled,
          )

          Text(
            "${grantedRecordTypes.size} of ${allRecordTypes.size} data types authorized",
            style = MaterialTheme.typography.bodyMedium,
          )

          Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
          ) {
            Text("Background Sync", style = MaterialTheme.typography.bodyMedium)
            Switch(
              checked = backgroundSyncEnabled,
              onCheckedChange = { enabled ->
                backgroundSyncEnabled = enabled
                setBackgroundSyncEnabled(context, enabled)
                if (enabled && !isIgnoringBatteryOptimizations(context)) {
                  showBatteryOptimizationDialog = true
                }
              },
            )
          }

          if (backgroundSyncEnabled) {
            BackgroundSyncStatusRow(bgSyncStatus)
          }

          // Background read permission is granted separately from foreground reads:
          // Health Connect requires the user to grant at least one foreground read first,
          // then offers a separate "all the time" / "while in use" prompt for this one.
          if (hasAnyPermissions && !hasBackgroundReadPermission) {
            androidx.compose.material3.Surface(
              shape = MaterialTheme.shapes.small,
              color = MaterialTheme.colorScheme.surfaceVariant,
              modifier = Modifier.fillMaxWidth(),
            ) {
              Column(modifier = Modifier.padding(12.dp)) {
                Text(
                  "Background access not granted",
                  style = MaterialTheme.typography.bodyMedium,
                  fontWeight = FontWeight.Bold,
                )
                androidx.compose.foundation.layout
                  .Spacer(modifier = Modifier.height(4.dp))
                Text(
                  "Periodic background sync needs Health Connect to allow reads " +
                    "while Aurboda is closed. Without it, the every-15-minute job " +
                    "fails until you open the app.",
                  style = MaterialTheme.typography.bodySmall,
                  color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                androidx.compose.foundation.layout
                  .Spacer(modifier = Modifier.height(8.dp))
                androidx.compose.material3.OutlinedButton(
                  onClick = {
                    requestPermissionLauncher.launch(arrayOf(HC_BACKGROUND_READ_PERMISSION))
                  },
                  modifier = Modifier.fillMaxWidth(),
                ) {
                  Text("Allow Background Access")
                }
              }
            }
          }

          Button(
            onClick = { scope.launch { syncNow(context) } },
            enabled = hasAnyPermissions && !isProcessing,
            modifier = Modifier.fillMaxWidth(),
          ) {
            Text("Sync Now")
          }

          if (!hasAllPermissions) {
            var permissionsExpanded by remember { mutableStateOf(false) }
            val missingLabel =
              if (!hasAllReadPermissions && !hasAllWritePermissions) {
                "Read & write permissions pending"
              } else if (!hasAllReadPermissions) {
                "Read permissions pending"
              } else {
                "Write permissions pending"
              }

            androidx.compose.material3.Surface(
              onClick = { permissionsExpanded = !permissionsExpanded },
              shape = MaterialTheme.shapes.small,
              color = MaterialTheme.colorScheme.surfaceVariant,
              modifier = Modifier.fillMaxWidth(),
            ) {
              Column(modifier = Modifier.padding(12.dp)) {
                Row(
                  verticalAlignment = Alignment.CenterVertically,
                  horizontalArrangement = Arrangement.SpaceBetween,
                  modifier = Modifier.fillMaxWidth(),
                ) {
                  Text(
                    missingLabel,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                  )
                  Text(
                    if (permissionsExpanded) "\u25B2" else "\u25BC",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                  )
                }

                if (permissionsExpanded) {
                  androidx.compose.foundation.layout
                    .Spacer(modifier = Modifier.height(8.dp))
                  if (hasAllReadPermissions && !hasAllWritePermissions) {
                    Text(
                      "Write access allows outbound sync (pushing data to Health Connect). " +
                        "If the button has no effect, use Health Connect Settings.",
                      style = MaterialTheme.typography.bodySmall,
                      color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    androidx.compose.foundation.layout
                      .Spacer(modifier = Modifier.height(8.dp))
                  }
                  androidx.compose.material3.OutlinedButton(
                    onClick = {
                      requestPermissionLauncher.launch(allPermissions.toTypedArray())
                    },
                    modifier = Modifier.fillMaxWidth(),
                  ) {
                    Text(if (hasAllReadPermissions) "Grant Write Permissions" else "Grant All Permissions")
                  }
                  androidx.compose.material3.TextButton(
                    onClick = {
                      val intent =
                        Intent("androidx.health.ACTION_MANAGE_HEALTH_PERMISSIONS")
                          .putExtra(Intent.EXTRA_PACKAGE_NAME, context.packageName)
                      try {
                        context.startActivity(intent)
                      } catch (e: Exception) {
                        Log.w("HealthConnect", "Could not open HC settings: ${e.message}")
                      }
                    },
                  ) {
                    Text(
                      "Open Health Connect Settings",
                      style = MaterialTheme.typography.bodySmall,
                    )
                  }
                }
              }
            }
          }

          Text(
            "Build ${BuildConfig.BUILD_TIMESTAMP}",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
            modifier = Modifier.align(Alignment.End),
          )
        }
      }
    }

    // -- ActivityWatch Sync Card --
    item {
      androidx.compose.material3.Card(
        modifier = Modifier.fillMaxWidth(),
      ) {
        Column(
          modifier = Modifier.padding(16.dp),
          verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
          Text(
            "ActivityWatch",
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
          )
          Text(
            "Sync app usage data from ActivityWatch for Android.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
          )

          Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
          ) {
            Text("ActivityWatch Sync", style = MaterialTheme.typography.bodyMedium)
            Switch(
              checked = awSyncEnabled,
              onCheckedChange = { enabled ->
                awSyncEnabled = enabled
                setActivityWatchSyncEnabled(context, enabled)
              },
            )
          }

          if (awSyncEnabled) {
            val result = awSyncResult
            val awStatusText =
              when {
                result == null -> "Sync on next run"
                result.error != null -> "Error: ${result.error}"
                !result.available -> "ActivityWatch not detected"
                result.eventsPushed > 0 -> "${result.eventsPushed} events synced"
                result.bucketsFound == 0 -> "No app-usage buckets found"
                else -> "Up to date"
              }
            val awStatusColor =
              when {
                result == null -> MaterialTheme.colorScheme.onSurfaceVariant
                result.error != null -> MaterialTheme.colorScheme.error
                !result.available -> MaterialTheme.colorScheme.onSurfaceVariant
                result.eventsPushed > 0 -> MaterialTheme.colorScheme.primary
                else -> MaterialTheme.colorScheme.onSurfaceVariant
              }
            Text(
              awStatusText,
              style = MaterialTheme.typography.bodySmall,
              color = awStatusColor,
            )

            if (result != null && !result.available) {
              Text(
                "Install ActivityWatch for Android to sync app usage data.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
              )
            }
          }
        }
      }
    }

    // -- Data Source Category Cards --
    items(categoryStatuses.size) { index ->
      val status = categoryStatuses[index]
      val iconText =
        when {
          status.allGranted -> "\u2705" // green check
          status.partiallyGranted -> "\u26A0\uFE0F" // amber warning
          else -> "\u274C" // red X
        }
      val iconColor =
        when {
          status.allGranted -> MaterialTheme.colorScheme.primary
          status.partiallyGranted -> MaterialTheme.colorScheme.tertiary
          else -> MaterialTheme.colorScheme.error
        }

      androidx.compose.material3.Card(
        modifier = Modifier.fillMaxWidth(),
      ) {
        Row(
          modifier = Modifier.padding(12.dp).fillMaxWidth(),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
          Text(iconText, style = MaterialTheme.typography.titleLarge)

          Column(modifier = Modifier.weight(1f)) {
            Text(
              status.category.name,
              style = MaterialTheme.typography.titleSmall,
              fontWeight = FontWeight.Bold,
            )
            Text(
              status.category.description,
              style = MaterialTheme.typography.bodySmall,
              color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (!status.allGranted) {
              Text(
                "${status.grantedCount}/${status.totalCount} types",
                style = MaterialTheme.typography.bodySmall,
                color = iconColor,
              )
            }
          }

          if (!status.allGranted) {
            androidx.compose.material3.OutlinedButton(
              onClick = {
                val categoryPermissions =
                  status.category.recordTypes
                    .flatMap { type ->
                      buildList {
                        add(HealthPermission.getReadPermission(type))
                        if (type in writableRecordTypes) add(HealthPermission.getWritePermission(type))
                      }
                    }.toTypedArray()
                requestPermissionLauncher.launch(categoryPermissions)
              },
            ) {
              Text("Grant")
            }
          }
        }
      }
    }

    // -- Empty state --
    if (!hasAnyPermissions && !isProcessing) {
      item {
        Text(
          "Grant at least one data category to start syncing your health data.",
          style = MaterialTheme.typography.bodyMedium,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
          textAlign = TextAlign.Center,
          modifier = Modifier.padding(vertical = 16.dp),
        )
      }
    }
  }

  // Battery optimization dialog
  if (showBatteryOptimizationDialog) {
    AlertDialog(
      onDismissRequest = { showBatteryOptimizationDialog = false },
      title = { Text("Battery Optimization") },
      text = {
        Text(
          "For reliable background sync, allow Aurboda to run " +
            "without battery restrictions. This helps ensure your " +
            "health data syncs even when the app is closed.",
        )
      },
      confirmButton = {
        Button(
          onClick = {
            showBatteryOptimizationDialog = false
            batteryOptimizationLauncher.launch(
              createBatteryOptimizationIntent(context),
            )
          },
        ) {
          Text("Allow")
        }
      },
      dismissButton = {
        Button(
          onClick = { showBatteryOptimizationDialog = false },
        ) {
          Text("Not Now")
        }
      },
    )
  }
}

@Preview(showBackground = true)
@Composable
fun HealthConnectScreenPreview() {
  AurbodaAppTheme {
    HealthConnectScreen(
      apiUrl = "https://example.com/api",
      authToken = "preview-token",
    )
  }
}
