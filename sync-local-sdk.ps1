param(
    [string]$SdkRepoPath = "..\shimmer-web-sdk"
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Split-Path -Parent $MyInvocation.MyCommand.Path)
# Two targets, and the duplication is deliberate. `vendor` is the shared copy
# every page and every module under common/ imports.
# `shimmer-extension\vendor` belongs to the Chrome extension: only that folder
# is packed for the store, and manifest.json lists vendor/shimmer-web-sdk.esm.js
# as a web-accessible resource, so it cannot reach a copy outside itself. Both
# must be written, or the extension silently ships an older SDK than the pages
# beside it.
$vendorTargets = @(
    (Join-Path $repoRoot "vendor"),
    (Join-Path $repoRoot "shimmer-extension\vendor")
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