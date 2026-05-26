param(
  [string]$SdkRepoPath = "..\shimmer-web-sdk",
  [switch]$InstallDeps,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Split-Path -Parent $MyInvocation.MyCommand.Path)
$sdkRoot = Resolve-Path (Join-Path $repoRoot $SdkRepoPath)

if (-not (Test-Path (Join-Path $sdkRoot "package.json"))) {
  throw "Could not find package.json in SDK repo path: $sdkRoot"
}

if (-not $SkipBuild) {
  $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
  if (-not $npmCmd) {
    throw "npm was not found in PATH. Install Node.js (includes npm) to build SDK changes, or rerun with -SkipBuild to only sync existing dist files."
  }

  if ($InstallDeps -or -not (Test-Path (Join-Path $sdkRoot "node_modules"))) {
    Write-Host "Installing SDK dependencies..."
    Push-Location $sdkRoot
    try {
      npm install
      if ($LASTEXITCODE -ne 0) {
        throw "npm install failed with exit code $LASTEXITCODE"
      }
    }
    finally {
      Pop-Location
    }
  }

  Write-Host "Building SDK..."
  Push-Location $sdkRoot
  try {
    npm run build
    if ($LASTEXITCODE -ne 0) {
      throw "npm run build failed with exit code $LASTEXITCODE"
    }
  }
  finally {
    Pop-Location
  }
}

$syncScript = Join-Path $repoRoot "sync-local-sdk.ps1"
if (-not (Test-Path $syncScript)) {
  throw "Sync script not found: $syncScript"
}

Write-Host "Syncing built SDK artifacts into webBLEDemos..."
powershell -ExecutionPolicy Bypass -File $syncScript -SdkRepoPath $SdkRepoPath
if ($LASTEXITCODE -ne 0) {
  throw "sync-local-sdk.ps1 failed with exit code $LASTEXITCODE"
}

Write-Host "Done: SDK built and synced successfully."
