param(
    [string]$SdkRepoPath = "..\shimmer-web-sdk"
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Split-Path -Parent $MyInvocation.MyCommand.Path)
$vendorTargets = @(
    (Join-Path $repoRoot "shimmer-extension\vendor"),
    (Join-Path $repoRoot "Verisense\vendor")
)
$sdkSourceConfigPath = Join-Path $repoRoot "sdk-source.json"

if (-not (Test-Path $sdkSourceConfigPath)) {
    throw "SDK source config not found: $sdkSourceConfigPath"
}

$sourceConfig = Get-Content $sdkSourceConfigPath -Raw | ConvertFrom-Json
$sourceMode = $sourceConfig.sourceMode

if (-not $sourceMode) {
    throw "sdk-source.json is missing required field: sourceMode"
}

if ($sourceMode -notin @("local-repo", "local-version", "local-latest")) {
    throw "Unsupported sourceMode '$sourceMode' in sdk-source.json. Supported: local-repo, local-version, local-latest"
}

foreach ($vendorDir in $vendorTargets) {
    if (-not (Test-Path $vendorDir)) {
        New-Item -ItemType Directory -Path $vendorDir -Force | Out-Null
    }
}

$files = @(
    "shimmer-web-sdk.esm.js",
    "shimmer-web-sdk.esm.js.map",
    "shimmer-web-sdk.cjs",
    "shimmer-web-sdk.cjs.map",
    "shimmer-web-sdk.umd.js",
    "shimmer-web-sdk.umd.js.map",
    "shimmer-web-sdk.d.ts"
)

$sdkRoot = Resolve-Path (Join-Path $repoRoot $SdkRepoPath)
$distDir = Join-Path $sdkRoot "dist"

if (-not (Test-Path $distDir)) {
    throw "SDK dist folder not found: $distDir"
}

foreach ($name in $files) {
    $src = Join-Path $distDir $name

    if (-not (Test-Path $src)) {
        throw "Missing SDK artifact: $src"
    }

    foreach ($vendorDir in $vendorTargets) {
        $dst = Join-Path $vendorDir $name
        Copy-Item -Path $src -Destination $dst -Force
    }
}

$targetList = $vendorTargets -join ", "
Write-Host "Synced SDK artifacts from '$distDir' to [$targetList] (sourceMode=$sourceMode)."