#Requires -RunAsAdministrator
<#
.SYNOPSIS
    RealSyncDynamics OpenClaw Gateway — Windows Installer

.DESCRIPTION
    Installs the OpenClaw Gateway as a Windows background service.
    Supports NSSM (Non-Sucking Service Manager) as primary method,
    with Task Scheduler as a fallback for environments without NSSM.

.EXAMPLE
    # Run from PowerShell (Administrator):
    Set-ExecutionPolicy Bypass -Scope Process -Force
    irm https://install.realsync.io/gateway/windows | iex

.NOTES
    Requires: PowerShell 5.1+, Node.js 20+ (auto-installed if missing)
#>

[CmdletBinding()]
param(
    [string]$InstallDir    = "C:\realsync-gateway",
    [string]$ServiceName   = "RealSyncGateway",
    [int]   $Port          = 8443,
    [switch]$SkipNssm,
    [switch]$NoService
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Helpers ───────────────────────────────────────────────────────────────────
function Write-Header { param([string]$Text)
    Write-Host "`n══ $Text ══" -ForegroundColor Cyan -NoNewline
    Write-Host ""
}
function Write-Info    { param([string]$Text) Write-Host "[INFO]  $Text" -ForegroundColor Cyan }
function Write-Success { param([string]$Text) Write-Host "[OK]    $Text" -ForegroundColor Green }
function Write-Warn    { param([string]$Text) Write-Host "[WARN]  $Text" -ForegroundColor Yellow }
function Write-Fail    { param([string]$Text) Write-Host "[ERROR] $Text" -ForegroundColor Red; throw $Text }

# ── Node.js check / install ───────────────────────────────────────────────────
function Get-NodeVersion {
    try {
        $v = (node --version 2>$null).TrimStart('v')
        return [int]($v.Split('.')[0])
    } catch {
        return 0
    }
}

function Install-NodeJs {
    Write-Header "Installing Node.js 20"

    # Try winget first (Windows 10 1709+)
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Info "Using winget to install Node.js LTS"
        winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
        # Refresh PATH
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                    [System.Environment]::GetEnvironmentVariable("Path","User")
        if (Get-NodeVersion -ge 20) {
            Write-Success "Node.js installed via winget"
            return
        }
    }

    # Fallback: download installer from nodejs.org
    Write-Info "Downloading Node.js 20 MSI installer"
    $nodeUrl  = "https://nodejs.org/dist/latest-v20.x/node-v20.0.0-x64.msi"
    $nodeMsi  = "$env:TEMP\nodejs-installer.msi"

    try {
        Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeMsi -UseBasicParsing
        Start-Process msiexec.exe -ArgumentList "/i `"$nodeMsi`" /qn ADDLOCAL=ALL" -Wait -NoNewWindow
        Remove-Item $nodeMsi -Force -ErrorAction SilentlyContinue
    } catch {
        Write-Fail "Failed to download Node.js MSI: $_. Please install Node.js 20 manually from https://nodejs.org"
    }

    # Refresh PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path","User")

    if (Get-NodeVersion -lt 20) {
        Write-Fail "Node.js installation failed. Please install v20+ manually from https://nodejs.org"
    }
    Write-Success "Node.js $(node --version) installed"
}

# ── Directory setup ───────────────────────────────────────────────────────────
function New-GatewayDirectory {
    Write-Header "Creating Gateway Directory"

    foreach ($sub in @("", "\src", "\scripts", "\logs")) {
        $path = "${InstallDir}${sub}"
        if (-not (Test-Path $path)) {
            New-Item -ItemType Directory -Path $path -Force | Out-Null
        }
    }
    Write-Success "Directory structure created at $InstallDir"
}

# ── npm install ───────────────────────────────────────────────────────────────
function Install-Dependencies {
    Write-Header "Installing npm Dependencies"
    $sourceDir = Split-Path $PSCommandPath -Parent | Split-Path -Parent

    if (Test-Path "$sourceDir\package.json") {
        Write-Info "Copying source files from $sourceDir"
        Copy-Item "$sourceDir\src"     -Destination $InstallDir -Recurse -Force
        Copy-Item "$sourceDir\package.json" -Destination $InstallDir -Force
        if (Test-Path "$sourceDir\package-lock.json") {
            Copy-Item "$sourceDir\package-lock.json" -Destination $InstallDir -Force
        }
    } else {
        Write-Warn "No local source files found. Ensure you copy the gateway source to $InstallDir manually."
    }

    Push-Location $InstallDir
    try {
        Write-Info "Running npm ci --only=production"
        npm ci --only=production --quiet
        Write-Success "npm install complete"
    } finally {
        Pop-Location
    }
}

# ── Generate API key ──────────────────────────────────────────────────────────
function New-ApiKey {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return ([BitConverter]::ToString($bytes) -replace '-','').ToLower()
}

# ── Write .env ────────────────────────────────────────────────────────────────
function Write-EnvFile {
    param([string]$ApiKey)

    $hostname   = $env:COMPUTERNAME.ToLower() -replace '[^a-z0-9\-]', ''
    $randSuffix = ([System.Convert]::ToBase64String((New-Object byte[] 4 | ForEach-Object { [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($_); $_ }))).Substring(0,6) -replace '[^a-zA-Z0-9]',''
    $gatewayId  = "gateway-$hostname-$randSuffix"

    $envContent = @"
GATEWAY_API_KEY=$ApiKey
GATEWAY_ID=$gatewayId
PORT=$Port
SCRIPTS_DIR=$InstallDir\scripts
LOG_LEVEL=info
LOG_FILE=$InstallDir\logs\gateway.log
MAX_JOB_TIMEOUT_MS=300000
ALLOWED_SCRIPT_EXTENSIONS=.sh,.ps1,.py
NODE_ENV=production
"@
    Set-Content -Path "$InstallDir\.env" -Value $envContent -Encoding UTF8

    # Restrict file permissions to current user + SYSTEM only
    $acl = Get-Acl "$InstallDir\.env"
    $acl.SetAccessRuleProtection($true, $false)
    $rule1 = New-Object System.Security.AccessControl.FileSystemAccessRule(
        [System.Security.Principal.WindowsIdentity]::GetCurrent().Name,
        "FullControl", "Allow")
    $rule2 = New-Object System.Security.AccessControl.FileSystemAccessRule(
        "SYSTEM", "FullControl", "Allow")
    $acl.AddAccessRule($rule1)
    $acl.AddAccessRule($rule2)
    Set-Acl "$InstallDir\.env" $acl

    Write-Success "Configuration written to $InstallDir\.env"
}

# ── NSSM service ──────────────────────────────────────────────────────────────
function Install-NssmService {
    Write-Header "Registering Windows Service via NSSM"

    # Check if nssm is available
    $nssmPath = Get-Command nssm -ErrorAction SilentlyContinue
    if (-not $nssmPath) {
        # Try to download nssm
        Write-Info "Downloading NSSM"
        $nssmUrl  = "https://nssm.cc/release/nssm-2.24.zip"
        $nssmZip  = "$env:TEMP\nssm.zip"
        $nssmDir  = "$env:TEMP\nssm-extract"

        try {
            Invoke-WebRequest -Uri $nssmUrl -OutFile $nssmZip -UseBasicParsing
            Expand-Archive -Path $nssmZip -DestinationPath $nssmDir -Force
            $nssmExe = Get-ChildItem -Path $nssmDir -Filter "nssm.exe" -Recurse |
                       Where-Object { $_.FullName -like "*win64*" } |
                       Select-Object -First 1
            if (-not $nssmExe) {
                $nssmExe = Get-ChildItem -Path $nssmDir -Filter "nssm.exe" -Recurse | Select-Object -First 1
            }
            Copy-Item $nssmExe.FullName -Destination "C:\Windows\System32\nssm.exe" -Force
            Remove-Item $nssmZip,$nssmDir -Recurse -Force -ErrorAction SilentlyContinue
            Write-Success "NSSM installed"
        } catch {
            Write-Warn "Could not download NSSM: $_"
            Write-Warn "Falling back to Task Scheduler"
            Install-TaskSchedulerFallback
            return
        }
    }

    $nodePath = (Get-Command node).Source

    # Remove existing service if present
    $existing = & nssm status $ServiceName 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Info "Removing existing service '$ServiceName'"
        & nssm stop $ServiceName 2>$null
        & nssm remove $ServiceName confirm 2>$null
    }

    & nssm install $ServiceName $nodePath
    & nssm set $ServiceName AppParameters "src\server.js"
    & nssm set $ServiceName AppDirectory $InstallDir
    & nssm set $ServiceName AppEnvironmentExtra "NODE_ENV=production"
    & nssm set $ServiceName AppStdout "$InstallDir\logs\service-stdout.log"
    & nssm set $ServiceName AppStderr "$InstallDir\logs\service-stderr.log"
    & nssm set $ServiceName AppRotateFiles 1
    & nssm set $ServiceName AppRotateBytes 10485760
    & nssm set $ServiceName Start SERVICE_AUTO_START
    & nssm set $ServiceName Description "RealSyncDynamics OpenClaw Gateway Remote Execution Service"

    Start-Service $ServiceName
    Start-Sleep -Seconds 2

    $svcStatus = (Get-Service $ServiceName -ErrorAction SilentlyContinue).Status
    if ($svcStatus -eq "Running") {
        Write-Success "Service '$ServiceName' is running"
    } else {
        Write-Warn "Service status: $svcStatus. Check logs at $InstallDir\logs\"
    }
}

# ── Task Scheduler fallback ───────────────────────────────────────────────────
function Install-TaskSchedulerFallback {
    Write-Header "Registering via Task Scheduler (NSSM fallback)"

    $nodePath   = (Get-Command node).Source
    $taskAction = New-ScheduledTaskAction -Execute $nodePath -Argument "src\server.js" -WorkingDirectory $InstallDir
    $taskTrigger= New-ScheduledTaskTrigger -AtStartup
    $taskPrinc  = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    $taskSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

    Unregister-ScheduledTask -TaskName $ServiceName -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $ServiceName -Action $taskAction -Trigger $taskTrigger `
        -Principal $taskPrinc -Settings $taskSettings -Description "RealSyncDynamics OpenClaw Gateway" -Force | Out-Null

    Start-ScheduledTask -TaskName $ServiceName
    Write-Success "Scheduled task '$ServiceName' created and started"
}

# ── Firewall rule ─────────────────────────────────────────────────────────────
function Add-FirewallRule {
    Write-Info "Adding Windows Firewall inbound rule for port $Port"
    try {
        New-NetFirewallRule -DisplayName "RealSync OpenClaw Gateway ($Port)" `
            -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow `
            -ErrorAction Stop | Out-Null
        Write-Success "Firewall rule added for port $Port"
    } catch {
        Write-Warn "Could not add firewall rule automatically: $_"
        Write-Warn "Manually allow TCP port $Port in Windows Firewall if needed."
    }
}

# ── Main ──────────────────────────────────────────────────────────────────────
function Main {
    Write-Host "`nRealSyncDynamics OpenClaw Gateway — Windows Installer" -ForegroundColor White -BackgroundColor DarkBlue
    Write-Host "─────────────────────────────────────────────────────`n"

    # Node.js
    $nodeVer = Get-NodeVersion
    if ($nodeVer -ge 20) {
        Write-Success "Node.js v$(node --version) already installed"
    } else {
        Install-NodeJs
    }

    New-GatewayDirectory
    Install-Dependencies

    $ApiKey = New-ApiKey
    Write-EnvFile -ApiKey $ApiKey

    if (-not $NoService) {
        if ($SkipNssm) {
            Install-TaskSchedulerFallback
        } else {
            Install-NssmService
        }
    }

    Add-FirewallRule

    Write-Host ""
    Write-Host "════════════════════════════════════════════════" -ForegroundColor Green
    Write-Host "  OpenClaw Gateway installed successfully!" -ForegroundColor Green
    Write-Host "════════════════════════════════════════════════" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Install dir  : $InstallDir"
    Write-Host "  Port         : $Port"
    Write-Host "  Service name : $ServiceName"
    Write-Host ""
    Write-Host "  SAVE YOUR API KEY — it will not be shown again:" -ForegroundColor Yellow -BackgroundColor DarkRed
    Write-Host ""
    Write-Host "  $ApiKey" -ForegroundColor White -BackgroundColor DarkBlue
    Write-Host ""
    Write-Host "  Health check : curl http://localhost:${Port}/health"
    Write-Host "  Logs         : $InstallDir\logs\"
    Write-Host ""
}

Main
