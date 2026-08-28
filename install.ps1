<#
.SYNOPSIS
Install the poly CLI on Windows.

.DESCRIPTION
    irm https://raw.githubusercontent.com/linzeyan/vscode-syntax/main/install.ps1 | iex

Windows PowerShell 5.1, which is what ships with the OS -- nothing here needs
PowerShell 7. The macOS/Linux twin is install.sh.

.PARAMETER Version
Release to install, without the leading v. Defaults to the latest one that
ships binaries.

.PARAMETER InstallDir
Where to put poly.exe. Defaults to %LOCALAPPDATA%\Programs\poly.
#>
[CmdletBinding()]
param(
    [string]$Version = $env:POLY_VERSION,
    [string]$InstallDir = $env:POLY_INSTALL_DIR
)

$ErrorActionPreference = 'Stop'
$repo = 'linzeyan/vscode-syntax'
if (-not $Version) { $Version = 'latest' }
if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\poly' }
# A relative -InstallDir would otherwise be written to PATH verbatim, where it
# means whatever the working directory happens to be in the next shell. Windows
# drive-relative paths ("C:poly") make that worse by looking absolute.
$InstallDir = [IO.Path]::GetFullPath($InstallDir)

# PowerShell 5.1 negotiates TLS 1.0 by default, which github.com refuses.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# PROCESSOR_ARCHITECTURE describes the *process*, not the machine. On Windows
# on ARM an x64-emulated process reports AMD64, and .NET's OSArchitecture says
# X64 there too, so both would quietly install the emulated build on an arm64
# box. Measured on the Win11 arm64 VM over ssh, where OpenSSH is itself x64:
# every in-process answer said X64, WMI said ARM64. Architecture is a number
# (12 = ARM64); OSArchitecture is a localized string and comes back as mojibake
# on a non-English install.
$cpu = @(Get-CimInstance Win32_Processor)[0]
$arch = if ($cpu.Architecture -eq 12) { 'arm64' } else { 'x64' }
$asset = "poly-win32-$arch.exe"

# "latest" is the newest release that ships binaries, which is not what
# /releases/latest returns. The v0 tag is the Marketplace listing for the
# action -- a release with no assets -- and GitHub is happy to call that one
# latest. Version-shaped tags (vX.Y.Z) are the ones a build publishes, and the
# same test excludes pre-releases, whose tags carry an -rc suffix.
if ($Version -eq 'latest') {
    try {
        $releases = Invoke-RestMethod "https://api.github.com/repos/$repo/releases?per_page=30" `
            -Headers @{ 'User-Agent' = 'poly-install' }
    }
    catch {
        # The anonymous budget is per IP, so an office or a VM behind the same
        # NAT as a busy machine hits it without having made a single request.
        # Raw, this surfaces as a WebException stack trace that reads like poly
        # is broken rather than like a limit that clears on its own.
        $code = $_.Exception.Response.StatusCode.value__
        if ($code -eq 403 -or $code -eq 429) {
            throw ("GitHub API rate limit reached (60 requests/hour per IP, " +
                "shared behind NAT). Retry later, or name a version to skip " +
                "the lookup: install.ps1 -Version 0.4.1")
        }
        throw
    }
    $tag = ($releases | Where-Object {
            -not $_.draft -and -not $_.prerelease -and $_.tag_name -match '^v\d+\.\d+\.\d+$'
        } | Select-Object -First 1).tag_name
    if (-not $tag) { throw 'no published release ships binaries yet' }
}
else {
    $tag = 'v' + $Version.TrimStart('v')
}

$base = "https://github.com/$repo/releases/download/$tag"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("poly-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
    Write-Host "install.ps1: downloading poly $tag ($asset)"
    # Invoke-WebRequest, not Invoke-RestMethod: the latter would try to parse
    # a 20MB executable as text.
    Invoke-WebRequest "$base/$asset" -OutFile "$tmp\poly.exe" -UseBasicParsing
    Invoke-WebRequest "$base/SHA256SUMS" -OutFile "$tmp\SHA256SUMS" -UseBasicParsing

    $line = Select-String -Path "$tmp\SHA256SUMS" -Pattern "  $([regex]::Escape($asset))$"
    if (-not $line) { throw "$asset is not listed in SHA256SUMS for $tag" }
    $want = $line.Line.Split(' ')[0]
    $got = (Get-FileHash "$tmp\poly.exe" -Algorithm SHA256).Hash.ToLower()
    # A truncated download otherwise surfaces much later as a process that
    # exits with no output, which reads like poly itself is broken.
    if ($want -ne $got) { throw "checksum mismatch for $asset (want $want, got $got)" }

    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Move-Item "$tmp\poly.exe" (Join-Path $InstallDir 'poly.exe') -Force
}
finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

$exe = Join-Path $InstallDir 'poly.exe'
Write-Host "install.ps1: installed $(& $exe --version) to $exe"

# Persisted to the user's PATH rather than just this session: the point of
# installing is that the next terminal has it too.
#
# Straight through the registry API, not Get-ItemProperty or
# [Environment]::GetEnvironmentVariable, because both read PATH with its
# %VARS% already expanded. Appending to that and writing it back would freeze
# a user's %USERPROFILE%\bin to today's value -- and nothing here would
# notice, because the result still works until the variable it inlined
# changes. The value kind is carried over rather than assumed, so a PATH that
# is REG_EXPAND_SZ (the Windows default) stays that way.
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
try {
    $userPath = $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
    $kind = if ($null -ne $key.GetValue('Path')) {
        $key.GetValueKind('Path')
    }
    else {
        [Microsoft.Win32.RegistryValueKind]::ExpandString
    }
    # Exact entry comparison, not -like "*$InstallDir*": a substring test says
    # C:\tools\poly is already installed when PATH holds C:\tools\poly-old, and
    # -like would read any [ ] in the path as a wildcard.
    $entries = @($userPath -split ';' | Where-Object { $_ })
    if ($entries -notcontains $InstallDir.TrimEnd('\')) {
        $updated = if ($userPath) { "$userPath;$InstallDir" } else { $InstallDir }
        $key.SetValue('Path', $updated, $kind)
        $env:PATH = "$env:PATH;$InstallDir"
        # ASCII only: PowerShell 5.1 writes UTF-8 bytes to a console that is
        # still on the OEM code page, so an em dash arrives as "??".
        Write-Host "install.ps1: added $InstallDir to your PATH. Open a new terminal for it to take effect."
    }
}
finally {
    $key.Close()
}
