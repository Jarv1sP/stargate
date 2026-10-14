param(
    [Parameter(Mandatory = $true)][string]$Installer,
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$TestRoot,
    [switch]$ShortPathRegression
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($ShortPathRegression) {
    if ($env:OS -ne 'Windows_NT') { throw '8.3 path regression requires Windows.' }
    $filesystem = New-Object -ComObject Scripting.FileSystemObject
    try { $shortRoot = $filesystem.GetFolder($TestRoot).ShortPath }
    finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($filesystem) }
    if ([string]::Equals($shortRoot, $TestRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Write-Output 'SKIP: this filesystem does not expose an 8.3 alias for the test directory'
        return
    }
    $TestRoot = $shortRoot
    Write-Output 'TESTING: 8.3 short-path installation root'
}
# GitHub runners can supply TEMP through an 8.3 alias (for example RUNNER~1).
# Normalize the existing parent before deriving expected paths for new children.
$TestRoot = [IO.Path]::GetFullPath($TestRoot)
. ([scriptblock]::Create([IO.File]::ReadAllText($Installer)))

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}
function Assert-Throws {
    param([scriptblock]$Action, [string]$Message)
    $failed = $false
    try { & $Action | Out-Null } catch { $failed = $true }
    Assert-True $failed $Message
}
function Get-GpuqPathValue {
    param([string]$Scope)
    return $script:Paths[$Scope]
}
function Set-GpuqPathValue {
    param([string]$Scope, [AllowNull()][string]$Value)
    $script:Paths[$Scope] = $Value
    if ($script:PathFailure -eq $Scope) {
        $script:PathFailure = ''
        throw 'Simulated partial PATH failure'
    }
}
function Receive-GpuqClient {
    param([string]$Origin, [string]$Destination)
    Assert-True ($Origin -eq 'https://gpu.example.com') 'Only the expected origin is downloaded'
    if ($script:DownloadFailure) { throw 'Simulated download failure' }
    [IO.File]::WriteAllText($Destination, $script:ClientSource, [Text.UTF8Encoding]::new($false))
}
$script:originalMove = ${function:Move-GpuqLauncher}
function Move-GpuqLauncher {
    param([string]$Source, [string]$Destination, [string]$Backup)
    if ($script:CommitFailure) { throw 'Simulated locked launcher' }
    & $script:originalMove -Source $Source -Destination $Destination -Backup $Backup
}

$script:Paths = @{ User = 'C:\Unrelated Path'; Process = $env:PATH }
$script:PathFailure = ''
$script:DownloadFailure = $false
$script:CommitFailure = $false
$script:ClientSource = 'console.log(JSON.stringify(process.argv.slice(2)));'
$unicode = [string][char]0x7528 + [char]0x6237
$root = Join-Path $TestRoot ("space $unicode ! & client")
$bin = Join-Path $root 'bin'
$launcher = Join-Path $bin 'gpuctl.cmd'
$install = {
    Install-GpuqClient -Origin 'https://gpu.example.com' -InstallRoot $root -NodePath $NodePath
}

foreach ($bad in @('http://gpu.example.com', 'https://user:pass@gpu.example.com', 'https://gpu.example.com/path', 'https://gpu.example.com/?x=1', 'https://gpu.example.com/#x', '__GPUQ_PUBLIC_ORIGIN__', "https://gpu.example.com`n")) {
    Assert-Throws { Resolve-GpuqOrigin $bad } "Reject invalid origin $bad"
}
Assert-True ((Resolve-GpuqOrigin 'https://gpu.example.com:8443/') -eq 'https://gpu.example.com:8443') 'Allow a valid HTTPS custom port'
foreach ($bad in @('v20.19.0', 'v22.12.9', 'unknown', 'v22.13.0-alpha')) {
    Assert-Throws { Assert-GpuqNodeVersion $bad } "Reject invalid/old Node $bad"
}
foreach ($good in @('v22.13.0', 'v22.20.0', 'v24.0.0')) { Assert-GpuqNodeVersion $good }
Assert-True ((Add-GpuqPathEntry -Value 'C:\Unrelated;;C:\Unrelated' -Entry $bin) -eq ('C:\Unrelated;;C:\Unrelated;' + $bin)) 'Do not rewrite unrelated PATH entries'

$first = & $install
Assert-True ($first -eq $launcher) 'New installation returns its launcher'
Assert-True ([IO.File]::Exists($launcher)) 'New launcher exists'
$firstLauncher = [IO.File]::ReadAllText($launcher)
Assert-True ($firstLauncher -match 'setlocal DisableDelayedExpansion') 'Disable delayed expansion for exclamation marks'
Assert-True ($firstLauncher -match 'node\.exe "%~dp0\.\.\\releases\\[a-f0-9]{32}\\gpuctl\.mjs" %\*') 'Quoted relative path and literal argument forwarding'
Assert-True ($script:Paths.User -eq ('C:\Unrelated Path;' + $bin)) 'Only append this installation to user PATH'
Assert-True ([IO.Directory]::GetDirectories((Join-Path $root 'releases')).Count -eq 1) 'One validated release installed'
$installedClient = [IO.Directory]::GetFiles((Join-Path $root 'releases'), 'gpuctl.mjs', [IO.SearchOption]::AllDirectories)[0]

$script:Paths.User = 'C:\Unrelated Path;' + $bin + ';"' + $bin.ToUpperInvariant() + '"'
$second = & $install
Assert-True ($script:Paths.User -eq ('C:\Unrelated Path;' + $bin)) 'Repeated installations deduplicate the same PATH entry'
$stableLauncher = [IO.File]::ReadAllText($launcher)
Assert-True ($stableLauncher -ne $firstLauncher) 'Update atomically selects a new release'
$stableUserPath = $script:Paths.User
$stableProcessPath = $script:Paths.Process
$stableReleaseCount = [IO.Directory]::GetDirectories((Join-Path $root 'releases')).Count

foreach ($failure in @('download', 'syntax', 'path', 'commit')) {
    $script:DownloadFailure = $failure -eq 'download'
    $script:CommitFailure = $failure -eq 'commit'
    $script:ClientSource = if ($failure -eq 'syntax') { 'export const broken = ;' } else { 'throw new Error("This downloaded code must not execute during installation");' }
    if ($failure -eq 'path') { $script:Paths.User = 'C:\Unrelated Path'; $script:PathFailure = 'User' }
    $beforeUserPath = $script:Paths.User
    $beforeProcessPath = $script:Paths.Process
    Assert-Throws $install "Failed $failure must fail the installation"
    Assert-True ([IO.File]::ReadAllText($launcher) -eq $stableLauncher) "Keep previous launcher on $failure failure"
    Assert-True ($script:Paths.User -eq $beforeUserPath) "Restore user PATH on $failure failure"
    Assert-True ($script:Paths.Process -eq $beforeProcessPath) "Restore process PATH on $failure failure"
    Assert-True ([IO.Directory]::GetDirectories((Join-Path $root 'releases')).Count -eq $stableReleaseCount) "Remove unpublished release after $failure"
    Assert-True ([IO.Directory]::GetDirectories($root, '.install-*').Count -eq 0) "Clean staging after $failure"
    $script:Paths.User = $stableUserPath
    $script:Paths.Process = $stableProcessPath
    $script:DownloadFailure = $false
    $script:CommitFailure = $false
}

$heldLock = [IO.File]::Open((Join-Path $root '.install.lock'), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try { Assert-Throws $install 'Concurrent installation must fail without changing the client' } finally { $heldLock.Dispose() }
Assert-True ([IO.File]::ReadAllText($launcher) -eq $stableLauncher) 'Lock conflict preserves the client'

# Syntax validation must not run downloaded code.
$script:ClientSource = 'throw new Error("Installer executed downloaded code");'
& $install | Out-Null

if ($env:OS -eq 'Windows_NT') {
    $script:ClientSource = 'console.log(JSON.stringify(process.argv.slice(2)));'
    & $install | Out-Null
    $previousPath = $env:PATH
    try {
        $env:PATH = (Split-Path -Parent $NodePath) + ';' + $previousPath
        $actual = & $launcher 'hello world' $unicode
        Assert-True ($LASTEXITCODE -eq 0) 'Launcher exits with Node exit code'
        $argsResult = $actual | ConvertFrom-Json
        Assert-True ($argsResult[0] -eq 'hello world' -and $argsResult[1] -eq $unicode) 'Native cmd forwards spaced and Unicode arguments'
    } finally { $env:PATH = $previousPath }
}
Write-Output 'PASS: fake-download Windows installer lifecycle, rollback, origin, Node and PATH tests'
