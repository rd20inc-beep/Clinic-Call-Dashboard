'use strict';

/**
 * Installer Service
 *
 * Generates the PowerShell monitor script (.ps1) and the Windows batch
 * installer (.bat) that agents download from the dashboard.
 *
 * CHANGE vs. original server.js:
 *   - Both functions now accept a `monitorToken` parameter.
 *   - The generated PS1 sends an `X-Monitor-Token` header alongside
 *     `X-Webhook-Secret` in all Invoke-RestMethod calls.
 *   - The generated BAT passes the monitor token through to the
 *     download URL and webhook self-test.
 */

/**
 * Derive the base URL that monitors should use to reach the server.
 * Prefers the MONITOR_URL environment variable; falls back to request origin.
 *
 * @param {import('express').Request} req
 * @param {string|null} envMonitorUrl  Value of process.env.MONITOR_URL (may be null)
 * @returns {string}
 */
function getMonitorBaseUrl(req, envMonitorUrl) {
  if (envMonitorUrl) return envMonitorUrl;
  return `${req.protocol}://${req.get('host')}`;
}

/**
 * Generate the PowerShell call-monitor script.
 *
 * This is the script that runs in the background on the agent's Windows PC,
 * watches for Phone Link / WhatsApp call notifications via WinRT, and POSTs
 * them to the server's /incoming_call endpoint.
 *
 * @param {string} baseUrl       Server URL (e.g. https://calls.example.com)
 * @param {string} secret        Webhook secret (X-Webhook-Secret)
 * @param {string} agent         Agent username (e.g. "agent1")
 * @param {string} monitorToken  Per-agent monitor token (X-Monitor-Token)
 * @returns {string} Complete PS1 script content
 */
function generateMonitorScript(baseUrl, secret, agent, monitorToken) {
  return `# Clinicea Call Monitor — Phone Link + WhatsApp
$ErrorActionPreference = 'Continue'
$webhookUrl = "${baseUrl}/incoming_call"
$heartbeatUrl = "${baseUrl}/heartbeat"
$webhookSecret = "${secret}"
$monitorToken = "${monitorToken}"
$agentName = "${agent}"
$baseDir = "$env:APPDATA\\ClinicaCallMonitor"
$logFile = "$baseDir\\monitor.log"
$crashLog = "$baseDir\\crash.log"

if (-not (Test-Path $baseDir)) { New-Item -ItemType Directory -Path $baseDir -Force | Out-Null }

function Write-Log { param([string]$Msg)
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    try { Add-Content -Path $logFile -Value "[$ts] $Msg" -ErrorAction SilentlyContinue } catch {}
}

# Trim log if > 1MB
if (Test-Path $logFile) {
    try { if ((Get-Item $logFile).Length -gt 1MB) { Get-Content $logFile -Tail 200 | Set-Content "$logFile.tmp"; Move-Item "$logFile.tmp" $logFile -Force } } catch {}
}

if (-not $agentName) {
    Write-Log "FATAL: agentName is empty — this monitor was installed without an agent. Re-download from dashboard."
    Start-Sleep -Seconds 10
    exit 1
}

# === STARTUP DIAGNOSTICS ===
Write-Log "=== Monitor starting ==="
Write-Log "DIAG: Agent = $agentName"
Write-Log "DIAG: WebhookUrl = $webhookUrl"
Write-Log "DIAG: HeartbeatUrl = $heartbeatUrl"
Write-Log "DIAG: User = $env:USERNAME"
Write-Log "DIAG: Computer = $env:COMPUTERNAME"
Write-Log "DIAG: CWD = $(Get-Location)"
Write-Log "DIAG: Script = $PSCommandPath"
Write-Log "DIAG: PS Version = $($PSVersionTable.PSVersion)"
Write-Log "DIAG: OS = $([System.Environment]::OSVersion.VersionString)"

# Check Phone Link availability
$phoneLinkRunning = $false
try {
    $pl = Get-Process -Name "PhoneExperienceHost" -ErrorAction SilentlyContinue
    if ($pl) { $phoneLinkRunning = $true }
} catch {}
Write-Log "DIAG: Phone Link process running = $phoneLinkRunning"

# Write heartbeat file so installer can verify we're alive
$heartbeatFile = "$baseDir\\heartbeat.txt"
try { Set-Content -Path $heartbeatFile -Value (Get-Date -Format "yyyy-MM-dd HH:mm:ss") -ErrorAction SilentlyContinue } catch {}

# Send initial heartbeat immediately (before WinRT setup) so dashboard shows online
try {
    $hbBody = "Agent=$([uri]::EscapeDataString($agentName))"
    Write-Log "DIAG: Sending initial heartbeat — Body: $hbBody"
    $hbResp = Invoke-RestMethod -Uri $heartbeatUrl -Method POST -Body $hbBody -ContentType "application/x-www-form-urlencoded" -Headers @{ "X-Webhook-Secret" = $webhookSecret; "X-Monitor-Token" = $monitorToken } -TimeoutSec 5
    Write-Log "Initial heartbeat sent OK — Response: $($hbResp | ConvertTo-Json -Compress -ErrorAction SilentlyContinue)"
} catch { Write-Log "Initial heartbeat FAILED: $_" }

# Wrap all WinRT setup in a function so we can retry on crash
function Start-Monitor {
    try {
        [void][Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType = WindowsRuntime]
        [void][Windows.UI.Notifications.NotificationKinds, Windows.UI.Notifications, ContentType = WindowsRuntime]
        [void][Windows.UI.Notifications.KnownNotificationBindings, Windows.UI.Notifications, ContentType = WindowsRuntime]
        [void][Windows.UI.Notifications.UserNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
        Write-Log "WinRT APIs loaded"
    } catch {
        Write-Log "ERROR: Cannot load WinRT APIs: $_"
        Add-Content -Path $crashLog -Value "[$(Get-Date)] WinRT load failed: $_" -ErrorAction SilentlyContinue
        return $false
    }

    try {
        Add-Type -AssemblyName System.Runtime.WindowsRuntime
    } catch {
        Write-Log "ERROR: Cannot load System.Runtime.WindowsRuntime: $_"
        Add-Content -Path $crashLog -Value "[$(Get-Date)] Runtime load failed: $_" -ErrorAction SilentlyContinue
        return $false
    }

    $asTaskGeneric = $null
    try {
        $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
            $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
        })[0]
        if (-not $asTaskGeneric) { throw "AsTask method not found" }
    } catch {
        Write-Log "ERROR: Cannot find AsTask generic method: $_"
        Add-Content -Path $crashLog -Value "[$(Get-Date)] AsTask reflection failed: $_" -ErrorAction SilentlyContinue
        return $false
    }

    function Await-AsyncOp { param($AsyncOp, [Type]$ResultType)
        $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
        $netTask = $asTask.Invoke($null, @($AsyncOp))
        $netTask.Wait(15000) | Out-Null
        return $netTask.Result
    }

    $listener = $null
    try {
        $listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
        if (-not $listener) { throw "UserNotificationListener.Current returned null" }
    } catch {
        Write-Log "ERROR: Cannot get notification listener: $_"
        Add-Content -Path $crashLog -Value "[$(Get-Date)] Listener failed: $_" -ErrorAction SilentlyContinue
        return $false
    }

    $accessOk = $false
    for ($i = 1; $i -le 5; $i++) {
        try {
            $status = Await-AsyncOp ($listener.RequestAccessAsync()) ([Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus])
            if ($status -eq [Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus]::Allowed) {
                $accessOk = $true; Write-Log "Notification access granted"; break
            }
            Write-Log "Access attempt $i : $status"
        } catch { Write-Log "Access error (attempt $i): $_" }
        Start-Sleep -Seconds 3
    }
    if (-not $accessOk) {
        Write-Log "ERROR: Notification access denied. Enable at Settings > Privacy > Notifications"
        Add-Content -Path $crashLog -Value "[$(Get-Date)] Notification access denied after 5 attempts" -ErrorAction SilentlyContinue
        return $false
    }

    $seenIds = @{}; $recentCalls = @{}
    $lastHeartbeat = [DateTimeOffset]::Now.ToUnixTimeSeconds() - 999
    $consecutiveErrors = 0
    $startTime = [DateTimeOffset]::Now.ToUnixTimeSeconds()
    $lastNotifCount = -1
    Write-Log "Monitoring calls (Phone Link + WhatsApp)..."
    Write-Log "DIAGNOSTIC: Logging ALL notifications permanently"

    while ($true) {
        try {
            $notifications = Await-AsyncOp ($listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)) ([System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]])
            $consecutiveErrors = 0
            $totalCount = 0
            if ($notifications) { $totalCount = $notifications.Count }

            # Log notification count changes so we know the API is working
            if ($totalCount -ne $lastNotifCount) {
                Write-Log "DIAG: GetNotificationsAsync returned $totalCount notifications (was $lastNotifCount)"
                $lastNotifCount = $totalCount
            }

            foreach ($notif in $notifications) {
                $nid = $notif.Id
                if ($seenIds.ContainsKey($nid)) { continue }
                $seenIds[$nid] = $true

                # Get app name — try multiple methods
                $appName = ""
                $appId = ""
                try { $appName = $notif.AppInfo.DisplayInfo.DisplayName } catch {}
                try { $appId = $notif.AppInfo.Id } catch {}
                if (-not $appName) { $appName = "(unknown)" }

                # Get notification text — try binding first, then raw
                $fullText = ""
                $textParts = @()
                try {
                    $binding = $notif.Notification.Visual.GetBinding([Windows.UI.Notifications.KnownNotificationBindings]::ToastGeneric)
                    if ($binding) {
                        $textElements = $binding.GetTextElements()
                        foreach ($elem in $textElements) { $textParts += $elem.Text }
                        $fullText = $textParts -join " | "
                    }
                } catch { $fullText = "(binding error: $_)" }

                # DIAGNOSTIC: Log EVERY notification with full detail
                Write-Log "NOTIF [$appName] id=$appId : $fullText"

                # Match phone/call apps — extremely broad matching
                $appLower = $appName.ToLower()
                $isPhoneApp = $appLower -match "phone|link|tel|call|dialer|samsung|android|mobile|microsoft"
                $isWhatsApp = $appLower -match "whatsapp"
                if (-not $isPhoneApp -and -not $isWhatsApp) {
                    # Also check appId for Phone Link
                    if ($appId -match "PhoneExperienceHost|YourPhone|PhoneLink|Microsoft.YourPhone") {
                        $isPhoneApp = $true
                        Write-Log "MATCHED by appId: $appId"
                    }
                }
                if (-not $isPhoneApp -and -not $isWhatsApp) { continue }

                Write-Log ">>> PHONE APP MATCH [$appName] appId=$appId : $fullText"

                # Detect if this is a call — very broad matching on individual text parts too
                $isCall = $false
                $allTextLower = $fullText.ToLower()
                if ($isPhoneApp) {
                    $isCall = $allTextLower -match "incoming|call|calling|ringing|answer|decline|dial|ring|missed"
                }
                if ($isWhatsApp) {
                    $isCall = $allTextLower -match "voice call|video call|incoming|calling|ringing|audio call"
                }

                # Also check individual text elements for call indicators
                if (-not $isCall -and $isPhoneApp) {
                    foreach ($part in $textParts) {
                        if ($part.ToLower() -match "incoming|call|calling|ringing|answer|decline|ring|missed") {
                            $isCall = $true
                            Write-Log "Call keyword found in text part: $part"
                            break
                        }
                    }
                }

                # Fallback: ANY phone app notification with a phone number pattern = treat as call
                if (-not $isCall -and $isPhoneApp) {
                    if ($fullText -match '(\\+?[\\d][\\d\\s\\-\\(\\)]{6,18}[\\d])') {
                        Write-Log "POSSIBLE CALL (number without keywords) [$appName]: $fullText"
                        $isCall = $true
                    }
                }

                # LAST RESORT: if it is from Phone Link and has any content, treat as potential call
                if (-not $isCall -and ($appLower -match "phone link" -or $appId -match "PhoneExperienceHost|YourPhone")) {
                    Write-Log "FORCE TREATING as call (Phone Link app, any content): $fullText"
                    $isCall = $true
                }

                if ($isCall) {
                    try {
                        Write-Log "=== CALL DETECTED [$appName]: $fullText ==="

                        # Try to extract phone number from all available text
                        $phone = $null

                        # Method 1: strip call keywords then find number
                        $stripped = $fullText -replace '(?i)(incoming\\s*(voice\\s*|video\\s*|audio\\s*)?(call)?|calling|ringing|answer|decline|voice\\s*call|video\\s*call|audio\\s*call|missed call)', ''
                        $stripped = $stripped -replace '\\|', ' '
                        $stripped = $stripped.Trim()
                        if ($stripped -match '(\\+?[\\d][\\d\\s\\-\\(\\)]{6,18}[\\d])') {
                            $phone = $Matches[1] -replace '[\\s\\-\\(\\)]', ''
                        }

                        # Method 2: search original full text
                        if (-not $phone) {
                            if ($fullText -match '(\\+?[\\d][\\d\\s\\-\\(\\)]{6,18}[\\d])') {
                                $phone = $Matches[1] -replace '[\\s\\-\\(\\)]', ''
                                Write-Log "Phone from fullText fallback: $phone"
                            }
                        }

                        # Method 3: search each text part individually
                        if (-not $phone) {
                            foreach ($part in $textParts) {
                                if ($part -match '(\\+?[\\d][\\d\\s\\-\\(\\)]{6,18}[\\d])') {
                                    $phone = $Matches[1] -replace '[\\s\\-\\(\\)]', ''
                                    Write-Log "Phone from text part: $phone (part: $part)"
                                    break
                                }
                            }
                        }

                        # If still no phone, use contact name as identifier
                        if (-not $phone) {
                            # Use first text element as contact identifier
                            if ($textParts.Count -gt 0 -and $textParts[0].Length -gt 0) {
                                $phone = "contact:" + $textParts[0].Trim()
                                Write-Log "No phone number found — using contact name: $phone"
                            } else {
                                $phone = "unknown-" + [DateTimeOffset]::Now.ToUnixTimeSeconds()
                                Write-Log "No phone or contact found — using fallback: $phone"
                            }
                        }

                        $now = [DateTimeOffset]::Now.ToUnixTimeSeconds()
                        if ($recentCalls.ContainsKey($phone) -and ($now - $recentCalls[$phone]) -lt 30) {
                            Write-Log "Skipping duplicate: $phone (within 30s)"
                            continue
                        }
                        $recentCalls[$phone] = $now
                        $body = "From=$([uri]::EscapeDataString($phone))&CallSid=local-$now&Agent=$([uri]::EscapeDataString($agentName))"
                        Write-Log "SENDING WEBHOOK: $phone -> $webhookUrl | Body: $body"
                        for ($wRetry = 1; $wRetry -le 3; $wRetry++) {
                            try {
                                $resp = Invoke-RestMethod -Uri $webhookUrl -Method POST -Body $body -ContentType "application/x-www-form-urlencoded" -Headers @{ "X-Webhook-Secret" = $webhookSecret; "X-Monitor-Token" = $monitorToken } -TimeoutSec 10
                                Write-Log "Webhook OK (attempt $wRetry) — Response: $($resp | ConvertTo-Json -Compress -ErrorAction SilentlyContinue)"
                                break
                            } catch {
                                Write-Log "Webhook FAIL (attempt $wRetry): $($_.Exception.Message) | Status: $($_.Exception.Response.StatusCode)"
                                if ($wRetry -lt 3) { Start-Sleep -Seconds 2 }
                            }
                        }
                    } catch { Write-Log "Call processing error: $_" }
                }
            }
            if ($seenIds.Count -gt 1000) { $seenIds = @{} }
            $now = [DateTimeOffset]::Now.ToUnixTimeSeconds()
            $expired = @($recentCalls.Keys | Where-Object { ($now - $recentCalls[$_]) -gt 60 })
            foreach ($k in $expired) { $recentCalls.Remove($k) }
        } catch {
            $consecutiveErrors++
            Write-Log "Loop error ($consecutiveErrors): $_"
            if ($consecutiveErrors -ge 10) {
                Write-Log "Too many consecutive errors, restarting monitor..."
                Add-Content -Path $crashLog -Value "[$(Get-Date)] Restarting after $consecutiveErrors consecutive errors: $_" -ErrorAction SilentlyContinue
                return $false
            }
        }

        $now = [DateTimeOffset]::Now.ToUnixTimeSeconds()
        if (($now - $lastHeartbeat) -ge 30) {
            $hbOk = $false
            for ($hbRetry = 1; $hbRetry -le 3; $hbRetry++) {
                try {
                    Invoke-RestMethod -Uri $heartbeatUrl -Method POST -Body "Agent=$([uri]::EscapeDataString($agentName))" -ContentType "application/x-www-form-urlencoded" -Headers @{ "X-Webhook-Secret" = $webhookSecret; "X-Monitor-Token" = $monitorToken } -TimeoutSec 10 | Out-Null
                    $lastHeartbeat = $now
                    $hbOk = $true
                    break
                } catch {
                    Write-Log "Heartbeat attempt $hbRetry failed: $_"
                    if ($hbRetry -lt 3) { Start-Sleep -Seconds 2 }
                }
            }
            if (-not $hbOk) { Write-Log "WARNING: All 3 heartbeat attempts failed — server may be down" }
            # Upload last 50 lines of log to server so it can be viewed remotely
            try {
                $logUploadUrl = $heartbeatUrl -replace '/heartbeat$', '/api/monitor-log'
                $tail = ""
                if (Test-Path $logFile) { $tail = (Get-Content $logFile -Tail 50) -join [char]10 }
                Invoke-RestMethod -Uri $logUploadUrl -Method POST -Body "Agent=$([uri]::EscapeDataString($agentName))&Log=$([uri]::EscapeDataString($tail))" -ContentType "application/x-www-form-urlencoded" -Headers @{ "X-Webhook-Secret" = $webhookSecret; "X-Monitor-Token" = $monitorToken } -TimeoutSec 5 | Out-Null
            } catch {}
        }
        Start-Sleep -Seconds 1
    }
    return $true
}

# Auto-restart loop — if monitor crashes, wait and retry (up to 20 times)
$maxRestarts = 20
for ($restart = 0; $restart -lt $maxRestarts; $restart++) {
    if ($restart -gt 0) {
        $waitSec = [Math]::Min(30, 5 * $restart)
        Write-Log "Restarting monitor in $waitSec seconds (attempt $($restart + 1) / $maxRestarts)..."
        # Keep sending heartbeats while waiting to restart
        try {
            Invoke-RestMethod -Uri $heartbeatUrl -Method POST -Body "Agent=$([uri]::EscapeDataString($agentName))" -ContentType "application/x-www-form-urlencoded" -Headers @{ "X-Webhook-Secret" = $webhookSecret; "X-Monitor-Token" = $monitorToken } -TimeoutSec 5 | Out-Null
        } catch {}
        Start-Sleep -Seconds $waitSec
    }
    $result = Start-Monitor
    if ($result -eq $true) { break }
}
Write-Log "Monitor exiting after $maxRestarts restart attempts. Please re-install."
`;
}

/**
 * Generate the Windows batch installer that downloads the PS1 script,
 * sets up scheduled tasks and startup-folder persistence, and verifies
 * the installation.
 *
 * @param {string} baseUrl       Server URL
 * @param {string} secret        Webhook secret
 * @param {string} agent         Agent username
 * @param {string} monitorToken  Per-agent monitor token
 * @returns {string} Complete BAT file content (CRLF line endings)
 */
function generateInstallerBat(baseUrl, secret, agent, monitorToken) {
  // All PowerShell commands are on SINGLE lines — no ^ continuation (breaks CMD->PS handoff)
  // Scheduled task uses /RL LIMITED (no admin needed), falls through on failure
  const lines = [
    '@echo off',
    'setlocal EnableExtensions EnableDelayedExpansion',
    'title Clinicea Call Monitor Installer - ' + agent,
    '',
    'set "AGENT=' + agent + '"',
    'set "SERVER_URL=' + baseUrl + '"',
    'set "WEBHOOK_SECRET=' + secret + '"',
    'set "MONITOR_TOKEN=' + monitorToken + '"',
    '',
    'set "APP_DIR=%APPDATA%\\ClinicaCallMonitor"',
    'set "PS1_FILE=%APP_DIR%\\call_monitor.ps1"',
    'set "VBS_FILE=%APP_DIR%\\start_monitor.vbs"',
    'set "LOG_FILE=%APP_DIR%\\install_%AGENT%.log"',
    'set "TASK_NAME=Clinicea Call Monitor - %AGENT%"',
    'set "STARTUP_VBS=%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\CliniceaCallMonitor_%AGENT%.vbs"',
    'set "TASK_OK=0"',
    'set "STARTUP_OK=0"',
    'set "LAUNCH_OK=0"',
    '',
    'if not exist "%APP_DIR%" mkdir "%APP_DIR%"',
    '',
    'call :log "============================================"',
    'call :log "Starting installer for %AGENT%"',
    'call :log "App dir: %APP_DIR%"',
    'call :log "Server: %SERVER_URL%"',
    'call :log "User: %USERNAME%"',
    'echo.',
    'echo === Clinicea Call Monitor Installer ===',
    'echo Agent: %AGENT%',
    'echo.',
    '',
    'REM === Step 1: Kill ALL old monitors ===',
    'echo [1/7] Stopping ALL previous monitor instances...',
    'call :log "Stopping ALL old monitor tasks/processes"',
    'schtasks /Query /TN "%TASK_NAME%" >nul 2>&1 && schtasks /End /TN "%TASK_NAME%" >nul 2>&1',
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq \'powershell.exe\' -and $_.CommandLine -like \'*call_monitor*\' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force; Write-Output (\'Killed PID \' + $_.ProcessId) } catch {} }" >> "%LOG_FILE%" 2>&1',
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq \'wscript.exe\' -and $_.CommandLine -like \'*CliniceaCallMonitor*\' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force; Write-Output (\'Killed WScript PID \' + $_.ProcessId) } catch {} }" >> "%LOG_FILE%" 2>&1',
    'echo Done.',
    '',
    'REM === Step 2: Download PS1 (via temp script to avoid CMD escaping issues) ===',
    'echo [2/7] Downloading monitor script...',
    'call :log "Downloading call_monitor.ps1"',
    'set "DL_SCRIPT=%APP_DIR%\\dl_temp.ps1"',
    '> "%DL_SCRIPT%" echo [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
    '>> "%DL_SCRIPT%" echo $url = "%SERVER_URL%/api/monitor-script?agent=%AGENT%^&secret=%WEBHOOK_SECRET%^&token=%MONITOR_TOKEN%"',
    '>> "%DL_SCRIPT%" echo $out = "%PS1_FILE%"',
    '>> "%DL_SCRIPT%" echo Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing',
    '>> "%DL_SCRIPT%" echo if (!(Test-Path $out)) { exit 11 }',
    '>> "%DL_SCRIPT%" echo $len = (Get-Item $out).Length',
    '>> "%DL_SCRIPT%" echo if ($len -lt 100) { exit 12 }',
    '>> "%DL_SCRIPT%" echo Write-Output ("Downloaded bytes=" + $len)',
    'powershell -NoProfile -ExecutionPolicy Bypass -File "%DL_SCRIPT%" >> "%LOG_FILE%" 2>&1',
    'del /Q "%DL_SCRIPT%" >nul 2>&1',
    'if not exist "%PS1_FILE%" (',
    '    echo ERROR: Failed to download monitor script.',
    '    call :log "ERROR: Monitor script missing after download"',
    '    pause',
    '    exit /b 1',
    ')',
    'for %%A in ("%PS1_FILE%") do set "PS1_SIZE=%%~zA"',
    'if "%PS1_SIZE%"=="0" (',
    '    echo ERROR: Downloaded script is empty.',
    '    pause',
    '    exit /b 1',
    ')',
    'echo Downloaded: %PS1_SIZE% bytes',
    'call :log "Downloaded script: %PS1_SIZE% bytes"',
    'set "CHK_SCRIPT=%APP_DIR%\\chk_temp.ps1"',
    '> "%CHK_SCRIPT%" echo $content = Get-Content "%PS1_FILE%" -Raw',
    '>> "%CHK_SCRIPT%" echo if ($content -match "agentName\\s*=\\s*.+") { Write-Output "PS1 agent check: OK" } else { Write-Output "PS1 agent check: MISSING" }',
    'powershell -NoProfile -ExecutionPolicy Bypass -File "%CHK_SCRIPT%" >> "%LOG_FILE%" 2>&1',
    'del /Q "%CHK_SCRIPT%" >nul 2>&1',
    '',
    'REM === Step 3: Write VBS launcher ===',
    'echo [3/7] Writing silent launcher...',
    'call :log "Writing VBS launcher"',
    '> "%VBS_FILE%" echo Set ws = CreateObject("WScript.Shell")',
    '>> "%VBS_FILE%" echo appDir = ws.ExpandEnvironmentStrings("%APPDATA%") ^& "\\ClinicaCallMonitor"',
    '>> "%VBS_FILE%" echo ws.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ ^& appDir ^& "\\call_monitor.ps1""", 0, False',
    'if not exist "%VBS_FILE%" (',
    '    echo ERROR: Failed to create VBS launcher.',
    '    pause',
    '    exit /b 1',
    ')',
    'echo Done.',
    '',
    'REM === Step 4: Scheduled task — try LIMITED first (no admin), then HIGHEST ===',
    'echo [4/7] Creating scheduled task...',
    'call :log "Creating scheduled task: %TASK_NAME%"',
    'schtasks /Delete /TN "%TASK_NAME%" /F >nul 2>&1',
    'schtasks /Create /TN "%TASK_NAME%" /SC ONLOGON /RL LIMITED /TR "wscript.exe \\"%VBS_FILE%\\"" /F >> "%LOG_FILE%" 2>&1',
    'if errorlevel 1 (',
    '    call :log "LIMITED task failed, trying HIGHEST"',
    '    schtasks /Create /TN "%TASK_NAME%" /SC ONLOGON /RL HIGHEST /TR "wscript.exe \\"%VBS_FILE%\\"" /F >> "%LOG_FILE%" 2>&1',
    ')',
    'if errorlevel 1 (',
    '    echo WARNING: Scheduled task failed — using startup folder only.',
    '    call :log "WARNING: Scheduled task creation failed — will rely on startup folder"',
    ') else (',
    '    set "TASK_OK=1"',
    '    call :log "Scheduled task created OK"',
    ')',
    'echo Done.',
    '',
    'REM === Step 5: Startup folder fallback (always install as backup) ===',
    'echo [5/7] Adding startup-folder fallback...',
    'call :log "Adding startup folder fallback"',
    'del /Q "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\CliniceaCallMonitor*.vbs" >nul 2>&1',
    'copy /Y "%VBS_FILE%" "%STARTUP_VBS%" >nul 2>&1',
    'if exist "%STARTUP_VBS%" (',
    '    set "STARTUP_OK=1"',
    '    call :log "Startup folder: OK"',
    ') else (',
    '    call :log "WARNING: Startup folder copy failed"',
    ')',
    'echo Done.',
    '',
    'REM === Step 6: Start monitor + verify ===',
    'echo [6/7] Starting monitor...',
    'call :log "Starting monitor immediately"',
    'start "" wscript.exe "%VBS_FILE%"',
    'echo Waiting for monitor to start...',
    'timeout /t 5 /nobreak >nul',
    'set "VFY_SCRIPT=%APP_DIR%\\vfy_temp.ps1"',
    '> "%VFY_SCRIPT%" echo $p = Get-CimInstance Win32_Process ^| Where-Object { $_.Name -eq "powershell.exe" -and $_.CommandLine -like "*call_monitor*" }',
    '>> "%VFY_SCRIPT%" echo if ($p) { Write-Output ("Monitor running: PID " + ($p ^| Select-Object -First 1).ProcessId) } else { Write-Output "WARNING: Monitor process NOT found after launch"; exit 1 }',
    'powershell -NoProfile -ExecutionPolicy Bypass -File "%VFY_SCRIPT%" >> "%LOG_FILE%" 2>&1',
    'del /Q "%VFY_SCRIPT%" >nul 2>&1',
    'if errorlevel 1 (',
    '    echo WARNING: Monitor may not have started. Check log: %LOG_FILE%',
    '    call :log "WARNING: Monitor process not detected after launch"',
    ') else (',
    '    set "LAUNCH_OK=1"',
    '    echo Monitor started successfully.',
    ')',
    '',
    'REM === Step 7: Webhook self-test ===',
    'echo [7/7] Testing webhook connection...',
    'set "WHK_SCRIPT=%APP_DIR%\\whk_temp.ps1"',
    '> "%WHK_SCRIPT%" echo [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
    '>> "%WHK_SCRIPT%" echo try {',
    '>> "%WHK_SCRIPT%" echo   $r = Invoke-RestMethod -Uri "%SERVER_URL%/heartbeat" -Method POST -Body ("Agent=" + [uri]::EscapeDataString("%AGENT%")) -ContentType "application/x-www-form-urlencoded" -Headers @{"X-Webhook-Secret"="%WEBHOOK_SECRET%";"X-Monitor-Token"="%MONITOR_TOKEN%"} -TimeoutSec 10',
    '>> "%WHK_SCRIPT%" echo   Write-Output ("Webhook test: OK — " + ($r ^| ConvertTo-Json -Compress))',
    '>> "%WHK_SCRIPT%" echo } catch {',
    '>> "%WHK_SCRIPT%" echo   Write-Output ("Webhook test: FAILED — " + $_.Exception.Message)',
    '>> "%WHK_SCRIPT%" echo   exit 1',
    '>> "%WHK_SCRIPT%" echo }',
    'powershell -NoProfile -ExecutionPolicy Bypass -File "%WHK_SCRIPT%" >> "%LOG_FILE%" 2>&1',
    'del /Q "%WHK_SCRIPT%" >nul 2>&1',
    'if errorlevel 1 (',
    '    echo WARNING: Webhook self-test FAILED. Check server connection.',
    '    call :log "WARNING: Webhook self-test failed"',
    ') else (',
    '    echo Webhook test: OK',
    '    call :log "Webhook self-test passed"',
    ')',
    '',
    'REM === Install summary ===',
    'echo.',
    'echo ============================================',
    'echo   INSTALL SUMMARY',
    'echo ============================================',
    'echo   Agent:          %AGENT%',
    'echo   Dashboard:      %SERVER_URL%',
    'echo   Install dir:    %APP_DIR%',
    'echo   Script size:    %PS1_SIZE% bytes',
    'if "%TASK_OK%"=="1" (echo   Scheduled task:  OK) else (echo   Scheduled task:  FAILED)',
    'if "%STARTUP_OK%"=="1" (echo   Startup folder:  OK) else (echo   Startup folder:  FAILED)',
    'if "%LAUNCH_OK%"=="1" (echo   Monitor running: OK) else (echo   Monitor running: FAILED)',
    'echo   Log file:       %LOG_FILE%',
    'echo ============================================',
    '',
    'call :log "=== SUMMARY: task=%TASK_OK% startup=%STARTUP_OK% launch=%LAUNCH_OK% ==="',
    '',
    'if "%TASK_OK%"=="0" if "%STARTUP_OK%"=="0" (',
    '    echo.',
    '    echo *** WARNING: No auto-start persistence installed! ***',
    '    echo *** Monitor will not survive reboot. ***',
    '    call :log "CRITICAL: No persistence method installed"',
    ')',
    '',
    'echo.',
    'pause',
    'exit /b 0',
    '',
    ':log',
    'echo [%date% %time%] %~1>> "%LOG_FILE%"',
    'goto :eof',
  ];
  return lines.join('\r\n') + '\r\n';
}

module.exports = {
  getMonitorBaseUrl,
  generateMonitorScript,
  generateInstallerBat,
};
