# OMP fork installer for Windows (arynyklas/oh-my-pi)
#
# The fork publishes binaries only -- no npm packages -- so this installs the
# release asset directly. Do not use upstream's scripts/install.ps1 here: its
# default path installs @oh-my-pi/pi-coding-agent from npm, which is upstream's
# build and does not carry the fork's auth-gateway work.
#
# Usage:
#   irm https://raw.githubusercontent.com/arynyklas/oh-my-pi/release/fork/scripts/install-fork.ps1 | iex
#
# With options:
#   $s = irm https://raw.githubusercontent.com/arynyklas/oh-my-pi/release/fork/scripts/install-fork.ps1
#   & ([scriptblock]::Create($s)) -Version v17.2.15-fork.1
#   & ([scriptblock]::Create($s)) -InstallDir C:\tools\omp
#   & ([scriptblock]::Create($s)) -NoPath

param(
    # Pin an exact release tag, e.g. v17.2.15-fork.1. Default: newest fork release.
    [string]$Version,
    # Target directory. Default: $env:PI_INSTALL_DIR, else %LOCALAPPDATA%\omp.
    [string]$InstallDir,
    # Skip the user PATH update.
    [switch]$NoPath
)

$ErrorActionPreference = "Stop"

$Repo = "arynyklas/oh-my-pi"
$BinaryName = "omp-windows-x64.exe"
$ChecksumName = "SHA256SUMS"
# Mirrors versionFromForkTag() in packages/coding-agent/src/cli/release-info.ts.
$ForkTagPattern = '^v(\d+)\.(\d+)\.(\d+)-fork\.(\d+)$'

if (-not $InstallDir) {
    $InstallDir = if ($env:PI_INSTALL_DIR) { $env:PI_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "omp" }
}

# Windows PowerShell 5.1 can still default to TLS 1.0, which api.github.com rejects.
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {}

function Invoke-GitHubApi {
    param([string]$Uri)

    $headers = @{ "User-Agent" = "omp-fork-installer"; "Accept" = "application/vnd.github+json" }
    # Optional, but keeps unauthenticated rate limits from biting on shared IPs.
    if ($env:GITHUB_TOKEN) { $headers["Authorization"] = "Bearer $env:GITHUB_TOKEN" }
    return Invoke-RestMethod -Uri $Uri -Headers $headers -TimeoutSec 60 -UseBasicParsing
}

function Get-ForkTagRank {
    param([string]$Tag)

    $m = [regex]::Match($Tag, $ForkTagPattern)
    if (-not $m.Success) { return $null }
    return @(
        [int]$m.Groups[1].Value,
        [int]$m.Groups[2].Value,
        [int]$m.Groups[3].Value,
        [int]$m.Groups[4].Value
    )
}

function Compare-Rank {
    param([int[]]$Left, [int[]]$Right)

    for ($i = 0; $i -lt 4; $i++) {
        if ($Left[$i] -ne $Right[$i]) { return $Left[$i] - $Right[$i] }
    }
    return 0
}

function Resolve-Release {
    if ($Version) {
        $tag = "v" + ($Version -replace '^v', '')
        if (-not (Get-ForkTagRank $tag)) {
            throw "Not a fork release tag: $Version (expected vX.Y.Z-fork.N)"
        }
        Write-Host "Fetching release $tag..."
        try {
            $release = Invoke-GitHubApi "https://api.github.com/repos/$Repo/releases/tags/$tag"
        } catch {
            throw "Release tag not found in ${Repo}: $tag"
        }
        if ($release.draft -or $release.prerelease) {
            throw "Release $tag is a draft or prerelease; omp update rejects that channel"
        }
        return $release
    }

    Write-Host "Fetching latest fork release..."
    # Same selection as getLatestForkRelease(): stable releases on the -fork.N
    # line only. The repo still carries retired -authgw.beta prereleases.
    $releases = Invoke-GitHubApi "https://api.github.com/repos/$Repo/releases?per_page=20"
    $best = $null
    $bestRank = $null
    foreach ($release in $releases) {
        if ($release.draft -or $release.prerelease) { continue }
        $rank = Get-ForkTagRank $release.tag_name
        if (-not $rank) { continue }
        if (-not $best -or (Compare-Rank $rank $bestRank) -gt 0) {
            $best = $release
            $bestRank = $rank
        }
    }
    if (-not $best) { throw "No stable vX.Y.Z-fork.N release found in $Repo" }
    return $best
}

function Get-AssetUrl {
    param($Release, [string]$Name)

    $asset = $Release.assets | Where-Object { $_.name -eq $Name }
    if (-not $asset) { throw "Release $($Release.tag_name) has no asset named $Name" }
    return $asset.browser_download_url
}

function Get-ExpectedHash {
    param([string]$ChecksumPath, [string]$Name)

    foreach ($line in Get-Content $ChecksumPath) {
        # Format: "<sha256>  <filename>"
        $parts = $line -split '\s+', 2
        if ($parts.Count -eq 2 -and $parts[1].Trim() -eq $Name) { return $parts[0].Trim() }
    }
    throw "$ChecksumName has no entry for $Name"
}

function Find-BashShell {
    $gitBash = "C:\Program Files\Git\bin\bash.exe"
    if (Test-Path $gitBash) { return $gitBash }
    try {
        return (Get-Command bash.exe -ErrorAction Stop).Source
    } catch {
        return $null
    }
}

function Set-BashShellPath {
    try {
        $settingsDir = Join-Path $env:USERPROFILE ".omp\agent"
        $settingsFile = Join-Path $settingsDir "settings.json"

        $settings = @{}
        if (Test-Path $settingsFile) {
            try {
                $parsed = Get-Content $settingsFile -Raw | ConvertFrom-Json
                foreach ($prop in $parsed.PSObject.Properties) { $settings[$prop.Name] = $prop.Value }
            } catch {
                $settings = @{}
            }
        }
        if ($settings["shellPath"]) {
            Write-Host "Bash shell already configured: $($settings['shellPath'])" -ForegroundColor Cyan
            return
        }

        $bashPath = Find-BashShell
        if (-not $bashPath) {
            Write-Host "No bash shell found - omp will use its built-in shell." -ForegroundColor Cyan
            Write-Host "  For shell snapshots and interactive terminals, install Git for Windows:" -ForegroundColor Cyan
            Write-Host "    https://git-scm.com/download/win" -ForegroundColor Cyan
            return
        }

        if (-not (Test-Path $settingsDir)) { New-Item -ItemType Directory -Force -Path $settingsDir | Out-Null }
        $settings["shellPath"] = $bashPath
        $settings | ConvertTo-Json -Depth 10 | Set-Content $settingsFile -Encoding UTF8
        Write-Host "[OK] Configured shell path in $settingsFile" -ForegroundColor Green
    } catch {
        Write-Host "[WARN] Could not configure bash shell: $_" -ForegroundColor Yellow
    }
}

function Install-ForkBinary {
    if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") {
        Write-Host "[WARN] ARM64 host: the fork publishes x64 only, running under emulation." -ForegroundColor Yellow
    }

    $release = Resolve-Release
    $tag = $release.tag_name
    Write-Host "Using version: $tag"

    $binaryUrl = Get-AssetUrl $release $BinaryName
    $checksumUrl = Get-AssetUrl $release $ChecksumName

    $work = Join-Path ([System.IO.Path]::GetTempPath()) ("omp-fork-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    try {
        $downloaded = Join-Path $work $BinaryName
        $checksums = Join-Path $work $ChecksumName

        # The progress bar makes Invoke-WebRequest crawl on a ~180 MB download in PS 5.1.
        $previousProgress = $ProgressPreference
        $ProgressPreference = "SilentlyContinue"
        try {
            Write-Host "Downloading $ChecksumName..."
            Invoke-WebRequest -Uri $checksumUrl -OutFile $checksums -TimeoutSec 120 -UseBasicParsing
            Write-Host "Downloading $BinaryName..."
            Invoke-WebRequest -Uri $binaryUrl -OutFile $downloaded -TimeoutSec 900 -UseBasicParsing
        } finally {
            $ProgressPreference = $previousProgress
        }

        $expected = (Get-ExpectedHash $checksums $BinaryName).ToLowerInvariant()
        $actual = (Get-FileHash -Path $downloaded -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($expected -ne $actual) {
            throw "Checksum mismatch for ${BinaryName}: expected $expected, got $actual"
        }
        Write-Host "[OK] SHA256 verified: $actual" -ForegroundColor Green

        New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
        $target = Join-Path $InstallDir "omp.exe"

        # Windows refuses to overwrite a running image, but it will rename one.
        # Move the old binary aside so an upgrade works with omp still open.
        if (Test-Path $target) {
            $stale = "$target.old-$(Get-Date -Format yyyyMMddHHmmss)"
            Move-Item -Path $target -Destination $stale -Force
            try {
                Remove-Item -Path $stale -Force -ErrorAction Stop
            } catch {
                Write-Host "[WARN] Previous binary still in use, left at $stale" -ForegroundColor Yellow
            }
        }
        Move-Item -Path $downloaded -Destination $target -Force
        Write-Host "[OK] Installed omp to $target" -ForegroundColor Green

        $reported = (& $target --version 2>&1 | Out-String).Trim()
        $expectedVersion = $tag.TrimStart("v")
        if ($reported -notmatch [regex]::Escape($expectedVersion)) {
            throw "Installed binary reports '$reported', expected $expectedVersion"
        }
        Write-Host "[OK] $reported" -ForegroundColor Green
    } finally {
        Remove-Item -Path $work -Recurse -Force -ErrorAction SilentlyContinue
    }

    $needsRestart = $false
    if (-not $NoPath) {
        $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
        $entries = @()
        if ($userPath) { $entries = $userPath -split ';' | ForEach-Object { $_.TrimEnd('\') } }
        if ($entries -notcontains $InstallDir.TrimEnd('\')) {
            Write-Host "Adding $InstallDir to PATH..."
            $updated = if ($userPath) { "$userPath;$InstallDir" } else { $InstallDir }
            [Environment]::SetEnvironmentVariable("Path", $updated, "User")
            $needsRestart = $true
        }
    }

    # An upstream install shadowing the fork on PATH is a silent downgrade.
    $onPath = Get-Command omp -ErrorAction SilentlyContinue
    if ($onPath -and (Split-Path $onPath.Source -Parent).TrimEnd('\') -ne $InstallDir.TrimEnd('\')) {
        Write-Host ""
        Write-Host "[WARN] Another omp is earlier on PATH: $($onPath.Source)" -ForegroundColor Yellow
        Write-Host "       Remove it, or that one keeps winning over the fork build." -ForegroundColor Yellow
    }

    Set-BashShellPath

    Write-Host ""
    if ($needsRestart) {
        Write-Host "Restart your terminal, then run 'omp' to get started!"
    } else {
        Write-Host "Run 'omp' to get started!"
    }
}

Install-ForkBinary
