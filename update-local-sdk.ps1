param(
    [string]$SdkRepoPath = "..\shimmer-web-sdk",
    [switch]$InstallDeps,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Split-Path -Parent $MyInvocation.MyCommand.Path)
$sdkSourceConfigPath = Join-Path $repoRoot "sdk-source.json"

if (-not (Test-Path $sdkSourceConfigPath)) {
    throw "SDK source config not found: $sdkSourceConfigPath"
}

$sourceConfig = Get-Content $sdkSourceConfigPath -Raw | ConvertFrom-Json
$sourceMode = $sourceConfig.sourceMode
$version = $sourceConfig.version

if (-not $sourceMode) {
    throw "sdk-source.json is missing required field: sourceMode"
}

$resolvedVersion = if ($version) { $version } else { "(none)" }
Write-Host "SDK source config: sourceMode='$sourceMode', version='$resolvedVersion'"

if (-not $SkipBuild -and $sourceMode -in @("local-repo", "local-version", "local-latest")) {
    $sdkRoot = Resolve-Path (Join-Path $repoRoot $SdkRepoPath)
    if (-not (Test-Path (Join-Path $sdkRoot "package.json"))) {
        throw "Could not find package.json in SDK repo path: $sdkRoot"
    }

    $sdkBuildScript = Join-Path $sdkRoot "build-local-sdk.ps1"
    if (-not (Test-Path $sdkBuildScript)) {
        throw "SDK build script not found: $sdkBuildScript"
    }

    Write-Host "Running SDK-owned build script..."
    if ($sourceMode -eq "local-version") {
        if (-not $version) {
            throw "sdk-source.json must set version when sourceMode is local-version"
        }

        if ($InstallDeps.IsPresent) {
            & $sdkBuildScript -Version $version -InstallDeps
        }
        else {
            & $sdkBuildScript -Version $version
        }
    }
    elseif ($sourceMode -eq "local-latest") {
        if ($InstallDeps.IsPresent) {
            & $sdkBuildScript -Latest -InstallDeps
        }
        else {
            & $sdkBuildScript -Latest
        }
    }
    else {
        if ($InstallDeps.IsPresent) {
            & $sdkBuildScript -InstallDeps
        }
        else {
            & $sdkBuildScript
        }
    }

    if ($LASTEXITCODE -ne 0) {
        throw "build-local-sdk.ps1 failed with exit code $LASTEXITCODE"
    }
}
elseif ($sourceMode -notin @("local-repo", "local-version", "local-latest")) {
    throw "Unsupported sourceMode '$sourceMode' in sdk-source.json. Supported: local-repo, local-version, local-latest"
}

$syncScript = Join-Path $repoRoot "sync-local-sdk.ps1"
if (-not (Test-Path $syncScript)) {
    throw "Sync script not found: $syncScript"
}

Write-Host "Syncing built SDK artifacts into webBLEDemos vendor targets..."
powershell -ExecutionPolicy Bypass -File $syncScript -SdkRepoPath $SdkRepoPath
if ($LASTEXITCODE -ne 0) {
    throw "sync-local-sdk.ps1 failed with exit code $LASTEXITCODE"
}

Write-Host "Done: SDK built and synced successfully."
