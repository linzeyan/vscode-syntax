<#
.SYNOPSIS
    Verify release assets against SHA256SUMS.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Tag,
    [ValidateSet('win32-x64', 'win32-arm64')][string]$Platform = 'win32-x64',
    [switch]$KeepDownloads
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$base = "https://github.com/linzeyan/vscode-syntax/releases/download/$Tag"
$dest = Join-Path $env:TEMP "poly-$Tag"
New-Item -ItemType Directory -Force -Path $dest | Out-Null

try {
    Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile "$dest\SHA256SUMS"
    $expected = Get-Content "$dest\SHA256SUMS" |
        Where-Object { $_ -match "poly-lint-$Platform-.*\.vsix$" } |
        ForEach-Object { ($_ -split '\s+')[0] }

    $vsix = "$dest\poly-lint-$Platform.vsix"
    Invoke-WebRequest -Uri "$base/poly-lint-$Platform-0.2.0.vsix" -OutFile $vsix
    $actual = (Get-FileHash -Algorithm SHA256 -Path $vsix).Hash.ToLower()

    if ($actual -ne $expected) {
        throw "checksum mismatch: expected $expected, got $actual"
    }
    Write-Host "OK $Platform" -ForegroundColor Green
}
finally {
    if (-not $KeepDownloads) { Remove-Item -Recurse -Force $dest }
}
