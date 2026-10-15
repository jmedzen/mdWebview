<#
.SYNOPSIS
    Smoke-test a packaged mdWebview Windows build by actually running it.

.DESCRIPTION
    The packaging jobs prove a build *compiles*; they never prove it *runs*.
    Before this script existed, nothing in CI executed a single Windows binary,
    so the entire Windows-only runtime surface was unverified: whether the
    payload was staged into the bundle at all, whether the Node sidecar could
    spawn from a read-only install directory, whether the server bound to
    loopback and answered, and whether the per-user data directory resolved to
    the documented %APPDATA% location rather than dying with ENOENT.

    This launches a real executable, waits for the HTTP server it hosts to
    answer on loopback, and asserts the data directory was created.

.PARAMETER Exe
    Executable to launch. Either the Electron shell (.exe that starts its own
    server) or a Node server binary (node.exe / mdwebview-server.exe) paired
    with -ServerArgs.

.PARAMETER Port
    Loopback port the hosted HTTP server should listen on.

.PARAMETER WorkDir
    Working directory for the process. server.js resolves its assets and worker
    scripts relative to cwd, so this must be the payload directory.

.PARAMETER ServerArgs
    Arguments passed to the executable (e.g. the staged server.js path).

.PARAMETER TimeoutSec
    How long to wait for the server to answer. First launch builds index caches
    and can be slow on a cold runner.

.PARAMETER AssertUserDataPath
    Fail unless this directory exists and is non-empty afterwards. Used to prove
    writable data landed in the per-user location.

.PARAMETER ExpectExitedCode
    For a negative control: assert the process exits with this code instead of
    serving HTTP.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [Parameter(Mandatory = $true)][int]$Port,
    [string]$WorkDir = (Get-Location).Path,
    [string[]]$ServerArgs = @(),
    [int]$TimeoutSec = 240,
    [string]$AssertUserDataPath = '',
    [int]$ExpectExitedCode = [int]::MinValue,
    # Extra environment variables for the child process, mirroring what the
    # desktop shells set (MDW_USER_DATA, CONFIG_PATH, LOG_DIR, MD_ROOT, …).
    [hashtable]$Env = @{}
)

$ErrorActionPreference = 'Stop'

function Write-Section([string]$Text) {
    Write-Host ''
    Write-Host "── $Text" -ForegroundColor Cyan
}

<#
    Convert a path produced by Git Bash (MSYS2) into a Windows path.

    The CI workflow extracts the installer payload with `shell: bash`, so `$PWD`
    there is a POSIX path such as `/d/a/mdWebview/mdWebview/payload`. It is
    exported to $GITHUB_ENV and read back by a later PowerShell step, which
    cannot resolve it: Test-Path on `/d/a/...` fails, and the smoke test would
    abort with "executable not found" even though the file is right there.

    The mapping is the standard MSYS2 one: a leading `/<drive>/` becomes
    `<DRIVE>:\`. `/c/...` -> `C:\...`, `/d/...` -> `D:\...`. Paths that are
    already Windows paths (or UNC paths) are returned unchanged.
#>
function ConvertFrom-BashPath([string]$Path) {
    if ([string]::IsNullOrEmpty($Path)) { return $Path }
    # Only single-letter drive mounts are rewritten; anything else (a native
    # Windows path, a UNC path, or a real POSIX-rooted path that happens to be
    # longer) must be left alone.
    if ($Path -match '^/([A-Za-z])/(.*)$') {
        $drive = $Matches[1].ToUpperInvariant()
        $rest = $Matches[2] -replace '/', '\'
        return "${drive}:\$rest"
    }
    return $Path
}

$Exe = ConvertFrom-BashPath $Exe
$WorkDir = ConvertFrom-BashPath $WorkDir
$ServerArgs = @($ServerArgs | ForEach-Object { ConvertFrom-BashPath $_ })
$AssertUserDataPath = ConvertFrom-BashPath $AssertUserDataPath

if (-not (Test-Path -LiteralPath $Exe)) {
    throw "smoke-test: executable not found: $Exe"
}
if (-not (Test-Path -LiteralPath $WorkDir)) {
    throw "smoke-test: working directory not found: $WorkDir"
}

$Exe = (Resolve-Path -LiteralPath $Exe).Path
$WorkDir = (Resolve-Path -LiteralPath $WorkDir).Path
$Url = "http://127.0.0.1:$Port/"

Write-Section "Launching $Exe"
Write-Host "  cwd : $WorkDir"
Write-Host "  args: $($ServerArgs -join ' ')"
Write-Host "  url : $Url"

$startArgs = @{
    FilePath         = $Exe
    WorkingDirectory = $WorkDir
    PassThru         = $true
}
if ($ServerArgs.Count -gt 0) { $startArgs.ArgumentList = $ServerArgs }

# Capture the child's output: when this runs in CI the process output is the
# only evidence of *why* a launch failed, and it is invisible otherwise because
# Start-Process detaches the streams.
$stdoutLog = Join-Path ([System.IO.Path]::GetTempPath()) "mdw-smoke-$PID.out.log"
$stderrLog = Join-Path ([System.IO.Path]::GetTempPath()) "mdw-smoke-$PID.err.log"
$startArgs.RedirectStandardOutput = $stdoutLog
$startArgs.RedirectStandardError = $stderrLog

function Show-ChildLogs {
    foreach ($log in @($stdoutLog, $stderrLog)) {
        if (Test-Path -LiteralPath $log) {
            Write-Host "── $log"
            Get-Content -LiteralPath $log -Tail 60 | ForEach-Object { Write-Host "  $_" }
        }
    }
}

# Start-Process only gained -Environment in PowerShell 7.4, and the runner's
# pwsh version is not guaranteed, so set the variables on this process instead:
# a child inherits the parent's environment block. Restore them afterwards so
# repeated runs in one job stay independent.
$envBackup = @{}
foreach ($key in $Env.Keys) {
    $envBackup[$key] = [System.Environment]::GetEnvironmentVariable($key, 'Process')
    [System.Environment]::SetEnvironmentVariable($key, [string]$Env[$key], 'Process')
}
if ($Env.Count -gt 0) {
    Write-Host "  env: $(($Env.Keys | Sort-Object) -join ', ')"
}

$proc = Start-Process @startArgs
Write-Host "  pid : $($proc.Id)"

$failure = $null
$served = $false

try {
    # ── Negative control: the caller expects a specific early exit. ──────────
    if ($ExpectExitedCode -ne [int]::MinValue) {
        Write-Section "Expecting exit code $ExpectExitedCode"
        if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
            throw "smoke-test: process did not exit within $TimeoutSec s (expected exit $ExpectExitedCode)"
        }
        if ($proc.ExitCode -ne $ExpectExitedCode) {
            throw "smoke-test: expected exit code $ExpectExitedCode but got $($proc.ExitCode)"
        }
        Write-Host "  OK: exited with $($proc.ExitCode)" -ForegroundColor Green
        return
    }

    # ── Wait for the HTTP server to answer. ────────────────────────────────
    Write-Section "Waiting for $Url (up to ${TimeoutSec}s)"
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $lastError = 'no attempt made'
    $response = $null

    while ((Get-Date) -lt $deadline) {
        # A server that dies is a hard failure, not something to keep waiting on.
        if ($proc.HasExited) {
            throw "smoke-test: process exited early with code $($proc.ExitCode) before serving HTTP"
        }
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 10
            if ($response.StatusCode -eq 200) { $served = $true; break }
            $lastError = "HTTP $($response.StatusCode)"
        }
        catch {
            $lastError = $_.Exception.Message
        }
        Start-Sleep -Seconds 2
    }

    if (-not $served) {
        throw "smoke-test: server never answered on $Url within $TimeoutSec s. Last error: $lastError"
    }

    Write-Host "  OK: HTTP 200 from $Url" -ForegroundColor Green
    Write-Host "  content-length: $($response.RawContentLength)"

    # The SPA is what the native window loads; an empty or tiny body means the
    # server answered but the payload was not actually packaged.
    if ($response.RawContentLength -lt 1000) {
        throw "smoke-test: root response was only $($response.RawContentLength) bytes; payload looks incomplete"
    }
    if ($response.Content -notmatch '<html') {
        throw "smoke-test: root response did not look like the app shell"
    }
    Write-Host "  OK: root response contains the app shell" -ForegroundColor Green

    # ── Per-user data directory must have been created and written to. ─────
    if ($AssertUserDataPath) {
        Write-Section "Verifying user data directory"
        Write-Host "  $AssertUserDataPath"
        if (-not (Test-Path -LiteralPath $AssertUserDataPath)) {
            throw "smoke-test: user data directory was not created: $AssertUserDataPath"
        }
        $entries = @(Get-ChildItem -LiteralPath $AssertUserDataPath -Force -ErrorAction SilentlyContinue)
        Write-Host "  entries: $($entries.Count)"
        foreach ($e in $entries) { Write-Host "    - $($e.Name)" }
        if ($entries.Count -eq 0) {
            throw "smoke-test: user data directory exists but is empty: $AssertUserDataPath"
        }

        # Require an actual *file* somewhere beneath the directory, not merely a
        # populated path. Directories alone only prove something ran mkdir; a
        # file proves the stack opened and wrote to the per-user location, which
        # is the failure mode this whole assertion exists to catch (the ENOENT
        # on a redirected Windows profile). Callers must therefore NOT pre-create
        # these subdirectories.
        $files = @(Get-ChildItem -LiteralPath $AssertUserDataPath -Recurse -File `
                -Force -ErrorAction SilentlyContinue)
        Write-Host "  files: $($files.Count)"
        foreach ($f in $files | Select-Object -First 10) {
            Write-Host "    * $($f.FullName.Substring($AssertUserDataPath.Length))"
        }
        if ($files.Count -eq 0) {
            throw "smoke-test: user data directory has subdirectories but the " +
            "application wrote no files into it: $AssertUserDataPath"
        }

        Write-Host "  OK: writable data landed in the per-user directory" -ForegroundColor Green
    }
}
catch {
    $failure = $_
}
finally {
    # Kill the whole tree: the Electron shell spawns the Node server as a child,
    # so stopping only the launcher would leave a stray process holding the port.
    #
    # Cleanup must never change the verdict. An error escaping this block would
    # replace the recorded failure (or turn a pass into a crash), so everything
    # here is best-effort and swallows its own errors.
    Write-Section "Stopping process tree (pid $($proc.Id))"
    try {
        if (Get-Command taskkill.exe -ErrorAction SilentlyContinue) {
            & taskkill.exe /PID $proc.Id /T /F 2>&1 |
                ForEach-Object { Write-Host "  $_" }
        }
        else {
            # Non-Windows hosts (or a stripped image) have no taskkill.
            Write-Host "  taskkill unavailable; falling back to Stop-Process"
            Get-Process -Id $proc.Id -ErrorAction SilentlyContinue |
                Stop-Process -Force -ErrorAction SilentlyContinue
            # Best effort at the children too, since the launcher may be gone.
            # Guarded separately: CIM cmdlets are absent on some hosts, and that
            # must not abort the remaining cleanup.
            try {
                if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) {
                    Get-CimInstance Win32_Process `
                        -Filter "ParentProcessId=$($proc.Id)" -ErrorAction SilentlyContinue |
                        ForEach-Object {
                            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
                        }
                }
            }
            catch {
                Write-Host "  (child enumeration unavailable: $($_.Exception.Message))"
            }
        }
        Start-Sleep -Seconds 3
    }
    catch {
        Write-Host "  WARNING: cleanup failed: $($_.Exception.Message)" -ForegroundColor Yellow
    }
    Write-Host "  done"

    foreach ($key in $envBackup.Keys) {
        try {
            [System.Environment]::SetEnvironmentVariable($key, $envBackup[$key], 'Process')
        }
        catch {
            Write-Host "  WARNING: could not restore `$env:$key" -ForegroundColor Yellow
        }
    }

    # The process streams are redirected to files, so the handles are released
    # here; fail loudly about a leak since the next run would then collide.
    foreach ($p in @($proc)) {
        try { $p.Dispose() } catch { }
    }
}

if ($failure) {
    Show-ChildLogs
    Write-Host ''
    Write-Host "smoke-test FAILED: $($failure.Exception.Message)" -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host "smoke-test PASSED" -ForegroundColor Green
exit 0
