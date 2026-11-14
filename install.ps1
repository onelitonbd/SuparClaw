# SuparClaw installer for native Windows (PowerShell 5.1+ or PowerShell 7+). No WSL, no admin rights.
#
#   irm https://raw.githubusercontent.com/onelitonbd/SuparClaw/main/install.ps1 | iex
#
# Options are environment variables, because `irm | iex` cannot pass parameters:
#   $env:SUPARCLAW_REF           branch to install (default: main)
#   $env:SUPARCLAW_DIR           install location (default: %USERPROFILE%\.suparclaw-install)
#   $env:SUPARCLAW_GITHUB_TOKEN  token for a private fork
#   $env:SUPARCLAW_UNINSTALL     set to 1 to remove the launcher and the install directory
#
# Installs the same runtime files as install.sh (dist, skills, README, LICENSE, package.json)
# into <dir>\current, writes a suparclaw.cmd launcher into <dir>\bin, and adds that bin
# directory to your user PATH.
#
# The command is `suparclaw`, not `sc`: in PowerShell `sc` is an alias for Set-Content,
# and in cmd.exe `sc` is the built-in Windows service tool (System32\sc.exe).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest's progress bar makes PS 5.1 very slow
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

$Repo     = 'onelitonbd/SuparClaw'
$Ref      = if ($env:SUPARCLAW_REF) { $env:SUPARCLAW_REF.Trim() } else { 'main' }
$MinNode  = [version]'24.16.0'
$InstallDir = if ($env:SUPARCLAW_DIR) { $env:SUPARCLAW_DIR.Trim() } else { Join-Path $env:USERPROFILE '.suparclaw-install' }
$CurrentDir = Join-Path $InstallDir 'current'
$BinDir     = Join-Path $InstallDir 'bin'
$Launcher   = Join-Path $BinDir 'suparclaw.cmd'

function Write-Step([string]$msg) { Write-Host ''; Write-Host "  $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "  + $msg" -ForegroundColor Green }
function Write-Info([string]$msg) { Write-Host "    $msg" -ForegroundColor DarkGray }
function Write-Warn2([string]$msg){ Write-Host "  ! $msg" -ForegroundColor Yellow }
function Fail([string]$msg)       { Write-Host "  x $msg" -ForegroundColor Red; throw $msg }

function Get-UserPathEntries {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $userPath) { return @() }
  return @($userPath.Split(';') | Where-Object { $_ })
}

function Test-SamePath([string]$a, [string]$b) {
  return $a.TrimEnd('\') -ieq $b.TrimEnd('\')
}

Write-Host ''
Write-Host '  suparclaw' -ForegroundColor White
Write-Host '  your phone is the machine. (this one is your PC.)' -ForegroundColor DarkGray

# ------------------------------------------------------------ uninstall
if ($env:SUPARCLAW_UNINSTALL -eq '1') {
  Write-Step 'Uninstalling SuparClaw'
  $entries = Get-UserPathEntries
  $kept = @($entries | Where-Object { -not (Test-SamePath $_ $BinDir) })
  if ($kept.Count -ne $entries.Count) {
    [Environment]::SetEnvironmentVariable('Path', ($kept -join ';'), 'User')
    Write-Ok 'removed the launcher directory from your user PATH'
  }
  if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
  Write-Ok "removed $InstallDir"
  Write-Info 'your ~/.suparclaw data was left untouched'
  return
}

# ------------------------------------------------------------ [1/5] node
Write-Step '[1/5] Checking your device'
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Fail "Node.js is not installed. Install Node $MinNode or newer from https://nodejs.org, open a new PowerShell window, and run this again."
}
$nodeVersionText = (& node -p 'process.versions.node' 2>$null | Out-String).Trim()
$nodeVersion = $null
try { $nodeVersion = [version]$nodeVersionText } catch { }
if (-not $nodeVersion -or $nodeVersion -lt $MinNode) {
  Fail "Node $nodeVersionText is too old. SuparClaw needs Node $MinNode or newer. Install it from https://nodejs.org and run this again."
}
Write-Ok "node v$nodeVersionText ($env:PROCESSOR_ARCHITECTURE)"

# ------------------------------------------------------------ [2/5] download
Write-Step '[2/5] Downloading SuparClaw'
Write-Info "source: $Repo@$Ref"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('suparclaw-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
  $zipPath = Join-Path $tmp 'source.zip'
  $headers = @{}
  if ($env:SUPARCLAW_GITHUB_TOKEN) {
    $headers['Authorization'] = "token $($env:SUPARCLAW_GITHUB_TOKEN.Trim())"
    Write-Info 'using a GitHub token (private repo mode)'
  }
  $url = "https://codeload.github.com/$Repo/zip/refs/heads/$Ref"
  try {
    Invoke-WebRequest -Uri $url -Headers $headers -OutFile $zipPath -UseBasicParsing
  } catch {
    Fail "download failed ($url). Private repo? Set `$env:SUPARCLAW_GITHUB_TOKEN and run again. Details: $($_.Exception.Message)"
  }
  Write-Ok 'source archive ready'

  # ---------------------------------------------------------- [3/5] unpack
  Write-Step '[3/5] Unpacking files'
  $extractDir = Join-Path $tmp 'src'
  Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
  $srcRoot = Get-ChildItem -Path $extractDir -Directory | Where-Object { $_.Name -like 'SuparClaw-*' } | Select-Object -First 1
  if (-not $srcRoot) { Fail 'archive did not contain a SuparClaw-* folder' }

  if (Test-Path $CurrentDir) { Remove-Item $CurrentDir -Recurse -Force }
  New-Item -ItemType Directory -Path $CurrentDir -Force | Out-Null
  foreach ($item in @('dist', 'skills', 'README.md', 'LICENSE', 'package.json')) {
    $p = Join-Path $srcRoot.FullName $item
    if (Test-Path $p) { Copy-Item -Path $p -Destination $CurrentDir -Recurse -Force }
  }
  if (-not (Test-Path (Join-Path $CurrentDir 'dist\sc.js'))) { Fail 'archive did not contain dist\sc.js' }
  # Same marker install.sh writes, so `sc update` keeps following this ref.
  Set-Content -Path (Join-Path $CurrentDir '.suparclaw-ref') -Value $Ref -Encoding ASCII
  Write-Ok "installed to $CurrentDir"
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

# ------------------------------------------------------------ [4/5] launcher
Write-Step '[4/5] Wiring the suparclaw command'
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
# %~dp0 is this launcher's own folder, so the install can be moved without editing it.
$launcherText = "@echo off`r`nnode `"%~dp0..\current\dist\sc.js`" %*`r`n"
Set-Content -Path $Launcher -Value $launcherText -Encoding ASCII
Write-Ok "launcher: $Launcher"

$entries = Get-UserPathEntries
if (-not ($entries | Where-Object { Test-SamePath $_ $BinDir })) {
  [Environment]::SetEnvironmentVariable('Path', (($entries + $BinDir) -join ';'), 'User')
  Write-Ok 'added to your user PATH'
  Write-Info 'open a new PowerShell window for the PATH change to apply'
}
if (-not ($env:Path.Split(';') | Where-Object { Test-SamePath $_ $BinDir })) {
  $env:Path = "$env:Path;$BinDir"
}

# ------------------------------------------------------------ [5/5] verify
Write-Step '[5/5] Verifying install'
$version = (& $Launcher version 2>$null | Out-String).Trim()
if (-not $version) { Fail "suparclaw did not run. Try: node `"$CurrentDir\dist\sc.js`" version" }
Write-Ok "suparclaw $version ready"

Write-Host ''
Write-Host "  SuparClaw $version is installed." -ForegroundColor Green
Write-Host ''
Write-Host '  next steps (open a new PowerShell window first)' -ForegroundColor White
Write-Host '    suparclaw init          workspace + gateway token'
Write-Host '    suparclaw doctor        check this device'
Write-Host '    suparclaw chat          say hello'
Write-Host '    suparclaw gateway       run the daemon'
Write-Host ''
Write-Host '  connect a model'
Write-Host '    suparclaw setup         guided provider setup'
Write-Host ''
Write-Warn2 'use `suparclaw`, not `sc`: sc means Set-Content in PowerShell and the Windows service tool in cmd.'
Write-Host ''
