# Requires PowerShell 5.1+ and Node.js 22.13+. No administrator privileges needed.
# The portal replaces this origin. Downloads never follow redirects.
$GpuqPublicOrigin = '__GPUQ_PUBLIC_ORIGIN__'

function Resolve-GpuqOrigin {
    param([Parameter(Mandatory = $true)][string]$Value)
    $parsed = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$parsed) -or
        $parsed.Scheme -cne 'https' -or -not $parsed.Host -or $parsed.UserInfo -or
        $parsed.AbsolutePath -ne '/' -or $parsed.Query -or $parsed.Fragment -or
        $Value -match '[\s\x00-\x1f\x7f]') {
        throw 'Download this installer from your HTTPS GPUQ portal; its origin is invalid.'
    }
    return $parsed.GetLeftPart([UriPartial]::Authority)
}

function Assert-GpuqNodeVersion {
    param([Parameter(Mandatory = $true)][string]$Value)
    if ($Value.Trim() -notmatch '^v?(\d+)\.(\d+)\.(\d+)$') {
        throw 'Cannot determine the Node.js version. Install Node.js 22.13 or newer.'
    }
    if ([int]$Matches[1] -lt 22 -or ([int]$Matches[1] -eq 22 -and [int]$Matches[2] -lt 13)) {
        throw 'Node.js is too old. Install Node.js 22.13 or newer, then retry.'
    }
}

function Assert-GpuqPlainPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    if ([IO.File]::Exists($Path) -or [IO.Directory]::Exists($Path)) {
        if (([IO.File]::GetAttributes($Path) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing a linked installation path: $Path"
        }
    }
}

function Add-GpuqPathEntry {
    param([AllowNull()][string]$Value, [Parameter(Mandatory = $true)][string]$Entry)
    $target = [IO.Path]::GetFullPath($Entry).TrimEnd('\', '/')
    $result = [Collections.Generic.List[string]]::new()
    $found = $false
    $parts = if ([string]::IsNullOrEmpty($Value)) { @() } else { $Value -split ';' }
    foreach ($part in $parts) {
        $normalized = [Environment]::ExpandEnvironmentVariables($part.Trim().Trim('"')).TrimEnd('\', '/')
        if ([string]::Equals($normalized, $target, [StringComparison]::OrdinalIgnoreCase)) {
            if (-not $found) { $result.Add($Entry); $found = $true }
        } else {
            $result.Add($part)
        }
    }
    if (-not $found) { $result.Add($Entry) }
    return [string]::Join(';', $result)
}

function Get-GpuqPathValue {
    param([string]$Scope)
    return [Environment]::GetEnvironmentVariable('Path', $Scope)
}

function Set-GpuqPathValue {
    param([string]$Scope, [AllowNull()][string]$Value)
    [Environment]::SetEnvironmentVariable('Path', $Value, $Scope)
}

function Receive-GpuqClient {
    param([string]$Origin, [string]$Destination)
    Add-Type -AssemblyName System.Net.Http
    $uri = [Uri]::new((Resolve-GpuqOrigin $Origin) + '/gpuctl.mjs')
    $limit = 64 * 1024 * 1024
    $deadline = [DateTime]::UtcNow.AddSeconds(900)
    $total = [long]0
    $expectedBytes = [long]0
    $etag = $null
    $attempt = 0
    $done = $false
    $shown = -10
    $outputStream = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        while (-not $done) {
            $remaining = ($deadline - [DateTime]::UtcNow).TotalSeconds
            if ($remaining -le 0 -or $attempt -ge 8) { throw 'Client download exceeded its 15-minute budget; the previous installation is unchanged.' }
            $attempt++
            $handler = [Net.Http.HttpClientHandler]::new()
            $handler.AllowAutoRedirect = $false
            $handler.SslProtocols = [Security.Authentication.SslProtocols]::Tls12
            # Resume offsets refer to decoded bytes. Never range a gzip stream.
            if ($total -eq 0) { $handler.AutomaticDecompression = [Net.DecompressionMethods]::GZip -bor [Net.DecompressionMethods]::Deflate }
            $client = [Net.Http.HttpClient]::new($handler)
            $client.Timeout = [TimeSpan]::FromSeconds([Math]::Min(120, $remaining))
            $cancel = [Threading.CancellationTokenSource]::new()
            $cancel.CancelAfter([int][Math]::Min(900000, $remaining * 1000))
            $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, $uri)
            if ($total -gt 0) {
                $request.Headers.Range = [Net.Http.Headers.RangeHeaderValue]::new($total, $null)
                if ($etag) { [void]$request.Headers.TryAddWithoutValidation('If-Range', $etag) }
                [void]$request.Headers.TryAddWithoutValidation('Accept-Encoding', 'identity')
            }
            $response = $null
            $inputStream = $null
            $phase = 'headers'
            try {
                $response = $client.SendAsync($request, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cancel.Token).GetAwaiter().GetResult()
                $status = [int]$response.StatusCode
                if ($status -ne 200 -and $status -ne 206) { throw "Client download failed (HTTP $status); redirects are not permitted." }
                if ($status -eq 206) {
                    $range = $response.Content.Headers.ContentRange
                    if ($total -eq 0 -or -not $range -or $range.Unit -cne 'bytes' -or $range.From -ne $total -or $range.To -ne ($range.Length - 1) -or $range.Length -gt $limit -or $range.Length -le $total) { throw 'Invalid client resume range; the previous installation is unchanged.' }
                    if ($response.Content.Headers.ContentEncoding.Count -gt 0) { throw 'Compressed partial client responses are not permitted.' }
                    $expectedBytes = $range.Length
                } else {
                    $etag = if ($response.Headers.ETag) { $response.Headers.ETag.Tag } else { $null }
                    if ($total -gt 0) {
                        if ($response.Content.Headers.ContentEncoding.Count -gt 0) { throw 'Server did not honor the identity resume request.' }
                        $outputStream.SetLength(0); $outputStream.Position = 0; $total = 0
                    }
                    if ($response.Headers.Contains('X-GPUQ-Client-Bytes')) { $expectedBytes = [long](@($response.Headers.GetValues('X-GPUQ-Client-Bytes'))[0]) }
                    elseif ($response.Content.Headers.ContentLength) { $expectedBytes = $response.Content.Headers.ContentLength }
                    if ($expectedBytes -lt 0 -or $expectedBytes -gt $limit) { throw 'Client download exceeds 64 MiB.' }
                }
                $inputStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
                $buffer = [byte[]]::new(65536)
                $phase = 'reading'
                while ($true) {
                    $remaining = ($deadline - [DateTime]::UtcNow).TotalSeconds
                    if ($remaining -le 0) { throw [TimeoutException]::new('Client download exceeded its 15-minute budget.') }
                    $read = $inputStream.ReadAsync($buffer, 0, $buffer.Length, $cancel.Token)
                    if (-not $read.Wait([TimeSpan]::FromSeconds([Math]::Min(120, $remaining)))) { $cancel.Cancel(); throw [TimeoutException]::new('Client download stalled for 120 seconds.') }
                    $count = $read.GetAwaiter().GetResult()
                    if ($count -eq 0) { break }
                    if ($total + $count -gt $limit -or ($expectedBytes -gt 0 -and $total + $count -gt $expectedBytes)) { throw 'Client download exceeds its size limit.' }
                    $phase = 'saving'; $outputStream.Write($buffer, 0, $count); $phase = 'reading'
                    $total += $count
                    if ($expectedBytes -gt 0) {
                        $percent = [int][Math]::Floor(100 * $total / $expectedBytes)
                        if ($percent -ge $shown + 10) { Write-Host ("Download {0}%" -f $percent); $shown = $percent }
                    }
                }
                if ($total -eq 0 -or ($expectedBytes -gt 0 -and $total -ne $expectedBytes)) { throw [IO.IOException]::new('Client download ended early.') }
                $done = $true
            } catch {
                # PowerShell wraps failed .NET async calls in invocation and
                # aggregate exceptions. Retry only their transport cause.
                $retryable = $false
                $failure = $_.Exception
                while ($failure) {
                    if ($failure -is [Net.Http.HttpRequestException] -or $failure -is [IO.IOException] -or $failure -is [OperationCanceledException] -or $failure -is [TimeoutException]) { $retryable = $true; break }
                    $failure = $failure.InnerException
                }
                if ($expectedBytes -gt 0 -and $total -eq $expectedBytes) { $done = $true }
                elseif ($phase -notin @('headers', 'reading') -or -not $retryable) { throw }
                else { Write-Host ("Connection interrupted; resume at {0} bytes" -f $total) }
            } finally {
                $cancel.Cancel()
                if ($inputStream) { $inputStream.Dispose() }
                if ($response) { $response.Dispose() }
                $request.Dispose(); $cancel.Dispose(); $client.Dispose()
            }
            if (-not $done) { Start-Sleep -Milliseconds 500 }
        }
        $outputStream.Flush($true)
    } finally { $outputStream.Dispose() }
}

function Move-GpuqLauncher {
    param([string]$Source, [string]$Destination, [string]$Backup)
    if ([IO.File]::Exists($Destination)) {
        [IO.File]::Replace($Source, $Destination, $Backup)
    } else {
        [IO.File]::Move($Source, $Destination)
    }
}

function Install-GpuqClient {
    param([string]$Origin, [string]$InstallRoot, [string]$NodePath)
    $ErrorActionPreference = 'Stop'
    $Origin = Resolve-GpuqOrigin $Origin
    $version = & $NodePath --version
    if ($LASTEXITCODE -ne 0) { throw 'Node.js cannot be started.' }
    Assert-GpuqNodeVersion ([string]$version)
    $InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
    $bin = Join-Path $InstallRoot 'bin'
    $releases = Join-Path $InstallRoot 'releases'
    foreach ($directory in @($InstallRoot, $bin, $releases)) {
        Assert-GpuqPlainPath $directory
        [void][IO.Directory]::CreateDirectory($directory)
    }
    $launcher = Join-Path $bin 'gpuctl.cmd'
    $lockPath = Join-Path $InstallRoot '.install.lock'
    Assert-GpuqPlainPath $launcher
    Assert-GpuqPlainPath $lockPath
    $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $id = [Guid]::NewGuid().ToString('N')
    $stage = Join-Path $InstallRoot ('.install-' + $id)
    $release = Join-Path $releases $id
    $temporaryLauncher = Join-Path $bin ('.gpuctl-' + $id + '.cmd')
    $backup = Join-Path $bin ('.previous-' + $id + '.cmd')
    $oldUserPath = $null
    $oldProcessPath = $null
    $userPathChanged = $false
    $processPathChanged = $false
    $committed = $false
    try {
        $oldUserPath = Get-GpuqPathValue 'User'
        $oldProcessPath = Get-GpuqPathValue 'Process'
        [void][IO.Directory]::CreateDirectory($stage)
        $clientFile = Join-Path $stage 'gpuctl.mjs'
        Receive-GpuqClient -Origin $Origin -Destination $clientFile
        $syntaxOutput = & $NodePath --check $clientFile 2>&1
        if ($LASTEXITCODE -ne 0) { throw 'Downloaded client failed the Node.js syntax check; the previous installation is unchanged.' }
        [IO.Directory]::Move($stage, $release)
        # Relative paths keep the ASCII launcher safe for spaces, Unicode and ! in profiles.
        $command = "@echo off`r`nsetlocal DisableDelayedExpansion`r`nnode.exe `"%~dp0..\releases\$id\gpuctl.mjs`" %*`r`nexit /b %errorlevel%`r`n"
        [IO.File]::WriteAllText($temporaryLauncher, $command, [Text.Encoding]::ASCII)
        $newUserPath = Add-GpuqPathEntry -Value $oldUserPath -Entry $bin
        $newProcessPath = Add-GpuqPathEntry -Value $oldProcessPath -Entry $bin
        if ($newUserPath -cne $oldUserPath) {
            # Mark before writing so even a partially failed environment update is restored.
            $userPathChanged = $true
            Set-GpuqPathValue -Scope 'User' -Value $newUserPath
        }
        if ($newProcessPath -cne $oldProcessPath) {
            $processPathChanged = $true
            Set-GpuqPathValue -Scope 'Process' -Value $newProcessPath
        }
        Move-GpuqLauncher -Source $temporaryLauncher -Destination $launcher -Backup $backup
        $committed = $true
    } catch {
        $originalError = $_
        if ($processPathChanged) {
            try { Set-GpuqPathValue -Scope 'Process' -Value $oldProcessPath } catch { Write-Warning 'Could not restore this process PATH.' }
        }
        if ($userPathChanged) {
            try { Set-GpuqPathValue -Scope 'User' -Value $oldUserPath } catch { Write-Warning 'Could not restore your user PATH; existing client files were preserved.' }
        }
        throw $originalError
    } finally {
        # Never delete a release that a successfully committed launcher uses.
        $cleanup = @($stage, $temporaryLauncher)
        if ($committed) { $cleanup += $backup } else { $cleanup += $release }
        foreach ($path in $cleanup) {
            try {
                if ([IO.Directory]::Exists($path)) { [IO.Directory]::Delete($path, $true) }
                elseif ([IO.File]::Exists($path)) { [IO.File]::Delete($path) }
            } catch { Write-Warning "Temporary installation file could not be removed: $path" }
        }
        $lock.Dispose()
    }
    return $launcher
}

# Dot-sourcing loads the functions for offline installer tests without installing anything.
if ($MyInvocation.InvocationName -ne '.') {
    $ErrorActionPreference = 'Stop'
    if ($env:OS -ne 'Windows_NT') { throw 'This installer is for native Windows PowerShell. Use install.sh on macOS or Linux.' }
    $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $nodeCommand) { throw 'Install Node.js 22.13 or newer first, then reopen PowerShell and retry.' }
    $localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    if (-not $localAppData) { throw 'Cannot locate your LocalAppData folder.' }
    $installed = Install-GpuqClient -Origin $GpuqPublicOrigin -InstallRoot (Join-Path $localAppData 'GPUQConsole') -NodePath $nodeCommand.Source
    Write-Host "Installed: $installed"
    Write-Host 'Run: gpuctl login'
    Write-Host 'If another open terminal cannot find gpuctl, close that terminal and open a new one.'
}
