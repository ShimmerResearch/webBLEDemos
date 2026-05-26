param(
    [string]$SdkRepoPath = "..\shimmer-web-sdk"
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Split-Path -Parent $MyInvocation.MyCommand.Path)
$sdkRoot = Resolve-Path (Join-Path $repoRoot $SdkRepoPath)
$distDir = Join-Path $sdkRoot "dist"
$vendorDir = Join-Path $repoRoot "shimmer-extension\vendor"

if (-not (Test-Path $distDir)) {
    throw "SDK dist folder not found: $distDir"
}

if (-not (Test-Path $vendorDir)) {
    throw "Vendor folder not found: $vendorDir"
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

foreach ($name in $files) {
    $src = Join-Path $distDir $name
    $dst = Join-Path $vendorDir $name

    if (-not (Test-Path $src)) {
        throw "Missing SDK artifact: $src"
    }

    Copy-Item -Path $src -Destination $dst -Force
}

Write-Host "Synced SDK artifacts from '$distDir' to '$vendorDir'."