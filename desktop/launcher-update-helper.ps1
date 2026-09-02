param(
    [Parameter(Mandatory = $true)]
    [string] $PayloadPath,

    [Parameter(Mandatory = $true)]
    [string] $ExpectedPayloadSha256,

    [Parameter(Mandatory = $true)]
    [string] $ExpectedHelperSha256
)

$ErrorActionPreference = 'Stop'
$script:payload = $null
$script:logPath = ''
$script:pendingPath = ''
$script:pendingFailurePath = ''
$script:newProcess = $null
$script:originalMoved = $false
$script:candidateMoved = $false

function Get-NormalizedFullPath([string] $PathValue) {
    if ([string]::IsNullOrWhiteSpace($PathValue)) { throw 'A required launcher update path is empty.' }
    $full = [System.IO.Path]::GetFullPath($PathValue)
    $root = [System.IO.Path]::GetPathRoot($full)
    if ($full.Length -gt $root.Length) { $full = $full.TrimEnd('\', '/') }
    return $full
}

function Get-NormalizedSha256([string] $Value, [string] $Label) {
    $normalized = ([string] $Value).Trim().ToLowerInvariant()
    if ($normalized -notmatch '^[0-9a-f]{64}$') { throw ($Label + ' is not a SHA-256 digest.') }
    return $normalized
}

function Get-FileSha256([string] $FilePath) {
    $stream = [System.IO.File]::Open($FilePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    try {
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try {
            return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
        } finally {
            $sha256.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

function Assert-NoReparsePath([string] $PathValue, [bool] $RequireLeaf) {
    $full = Get-NormalizedFullPath $PathValue
    $root = [System.IO.Path]::GetPathRoot($full)
    $current = $root
    $relative = $full.Substring($root.Length)
    if ($relative) {
        foreach ($segment in $relative.Split(@('\', '/'), [System.StringSplitOptions]::RemoveEmptyEntries)) {
            $current = [System.IO.Path]::Combine($current, $segment)
            if (-not (Test-Path -LiteralPath $current)) {
                if ($RequireLeaf) { throw ('Launcher update path is missing: ' + $current) }
                break
            }
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw ('Launcher update path contains a reparse point: ' + $current)
            }
        }
    }
    if ($RequireLeaf -and -not (Test-Path -LiteralPath $full)) {
        throw ('Launcher update path is missing: ' + $full)
    }
    return $full
}

function Assert-RegularFile([string] $PathValue, [string] $Label) {
    $full = Assert-NoReparsePath $PathValue $true
    $item = Get-Item -LiteralPath $full -Force
    if ($item.PSIsContainer) { throw ($Label + ' is not a regular file: ' + $full) }
    return $item
}

function Assert-FileSha256([string] $PathValue, [string] $Expected, [string] $Label) {
    $expectedHash = Get-NormalizedSha256 $Expected ($Label + ' expected hash')
    $item = Assert-RegularFile $PathValue $Label
    $actualHash = Get-FileSha256 $item.FullName
    if ($actualHash -ne $expectedHash) {
        throw ($Label + ' hash mismatch. Expected ' + $expectedHash + ', got ' + $actualHash + '.')
    }
    return $item
}

function Write-UpdateLog([string] $Message) {
    try {
        if (-not $script:logPath) { return }
        $parent = Split-Path -Parent $script:logPath
        if ($parent) {
            $null = Assert-NoReparsePath $parent $true
        }
        if (Test-Path -LiteralPath $script:logPath) {
            $null = Assert-RegularFile $script:logPath 'Launcher update log'
        }
        Add-Content -LiteralPath $script:logPath -Value ((Get-Date).ToString('o') + ' ' + $Message) -Encoding UTF8
    } catch {}
}

function Write-PendingFailure([string] $Message) {
    try {
        if (-not $script:pendingFailurePath) { return $false }
        $parent = Split-Path -Parent $script:pendingFailurePath
        if (-not $parent) { return $false }
        $null = Assert-NoReparsePath $parent $true
        if (Test-Path -LiteralPath $script:pendingFailurePath) {
            $null = Assert-RegularFile $script:pendingFailurePath 'Launcher update failure marker'
        }
        Set-Content -LiteralPath $script:pendingFailurePath -Value $Message -Encoding UTF8
        return $true
    } catch {
        Write-UpdateLog ('Could not persist launcher update failure marker: ' + $_.Exception.Message)
        return $false
    }
}

function Set-ObjectProperty($Object, [string] $Name, $Value) {
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
    } else {
        $property.Value = $Value
    }
}

function Reset-PendingForRetry([string] $Reason) {
    try {
        if (-not $script:pendingPath -or -not (Test-Path -LiteralPath $script:pendingPath -PathType Leaf)) {
            return $false
        }
        $pendingItem = Assert-RegularFile $script:pendingPath 'Pending launcher update record'
        $pending = Get-Content -LiteralPath $pendingItem.FullName -Raw | ConvertFrom-Json
        $pendingNonce = [string] $pending.preparedRestart.handoffNonce
        if ($pending.product -ne 'aht-launcher' -or
            $pendingNonce -notmatch '^[a-f0-9]{32}$' -or
            $pendingNonce -ne [string] $script:payload.handoffNonce) {
            Write-UpdateLog 'Refusing to reset pending state owned by a different launcher update handoff.'
            return $false
        }
        $retryStatus = if ([string] $script:payload.mode -eq 'staged-swap') { 'ready-to-relaunch' } else { 'staged' }
        Set-ObjectProperty $pending 'status' $retryStatus
        Set-ObjectProperty $pending 'installingStartedAt' ''
        Set-ObjectProperty $pending 'updatedAt' (Get-Date).ToUniversalTime().ToString('o')
        Set-ObjectProperty $pending 'helperFailure' $Reason
        $json = $pending | ConvertTo-Json -Depth 32
        $parent = Split-Path -Parent $pendingItem.FullName
        $temporary = Join-Path $parent ('.launcher-update-pending-' + [Guid]::NewGuid().ToString('N') + '.tmp')
        $replaced = $temporary + '.replaced'
        $encoding = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($temporary, $json, $encoding)
        try {
            [System.IO.File]::Replace($temporary, $pendingItem.FullName, $replaced, $true)
        } finally {
            if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
            if (Test-Path -LiteralPath $replaced) { Remove-Item -LiteralPath $replaced -Force -ErrorAction SilentlyContinue }
        }
        return $true
    } catch {
        Write-UpdateLog ('Could not reset pending launcher update for retry: ' + $_.Exception.Message)
        return $false
    }
}

function Remove-PendingForCommittedHandoff([bool] $RequirePresent = $false) {
    if (-not $script:pendingPath -or -not (Test-Path -LiteralPath $script:pendingPath -PathType Leaf)) {
        if ($RequirePresent) { throw 'Pending launcher update record disappeared before commit.' }
        return $false
    }
    $pendingItem = Assert-RegularFile $script:pendingPath 'Pending launcher update record'
    $pending = Get-Content -LiteralPath $pendingItem.FullName -Raw | ConvertFrom-Json
    $pendingNonce = [string] $pending.preparedRestart.handoffNonce
    if ($pending.product -ne 'aht-launcher' -or
        $pendingNonce -notmatch '^[a-f0-9]{32}$' -or
        $pendingNonce -ne [string] $script:payload.handoffNonce) {
        throw 'Pending launcher update record belongs to a different handoff.'
    }
    Remove-Item -LiteralPath $pendingItem.FullName -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $pendingItem.FullName) {
        throw 'Pending launcher update record could not be finalized.'
    }
    return $true
}

function ConvertTo-SafeRelativePath([string] $Value, [string] $Label) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value.IndexOf([char] 0) -ge 0) {
        throw ($Label + ' is empty or contains NUL.')
    }
    $normalized = $Value.Replace('\', '/')
    if ($normalized.StartsWith('/') -or $normalized -match '^[A-Za-z]:' -or [System.IO.Path]::IsPathRooted($normalized)) {
        throw ($Label + ' must be relative: ' + $Value)
    }
    $segments = $normalized.Split('/')
    $safeSegments = New-Object System.Collections.Generic.List[string]
    foreach ($segment in $segments) {
        if (-not $segment -or $segment -eq '.' -or $segment -eq '..') {
            throw ($Label + ' contains an unsafe path segment: ' + $Value)
        }
        if ($segment -ne $segment.TrimEnd(' ', '.')) {
            throw ($Label + ' contains a trailing dot or space: ' + $Value)
        }
        if ($segment -match '[\x00-\x1f<>:"|?*]') {
            throw ($Label + ' contains an invalid Windows path character: ' + $Value)
        }
        if ($segment -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$') {
            throw ($Label + ' contains a reserved Windows device name: ' + $Value)
        }
        $safeSegments.Add($segment)
    }
    return ($safeSegments -join '/')
}

function Resolve-StagedPath([string] $StagingRoot, [string] $RelativePath, [string] $Label) {
    $root = Get-NormalizedFullPath $StagingRoot
    $safeRelative = ConvertTo-SafeRelativePath $RelativePath $Label
    $child = Get-NormalizedFullPath ([System.IO.Path]::Combine($root, $safeRelative.Replace('/', [System.IO.Path]::DirectorySeparatorChar)))
    $prefix = $root + [System.IO.Path]::DirectorySeparatorChar
    if (-not $child.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw ($Label + ' escapes the staging directory: ' + $RelativePath)
    }
    return [pscustomobject] @{ FullPath = $child; RelativePath = $safeRelative }
}

function Get-StagedTree([string] $StagingRoot) {
    $root = Assert-NoReparsePath $StagingRoot $true
    $rootItem = Get-Item -LiteralPath $root -Force
    if (-not $rootItem.PSIsContainer) { throw ('Prepared staging root is not a directory: ' + $root) }
    $prefix = $root + [System.IO.Path]::DirectorySeparatorChar
    $files = New-Object 'System.Collections.Generic.Dictionary[string,System.IO.FileInfo]' ([System.StringComparer]::OrdinalIgnoreCase)
    $directories = New-Object 'System.Collections.Generic.Stack[System.IO.DirectoryInfo]'
    $directories.Push([System.IO.DirectoryInfo] $rootItem)
    while ($directories.Count -gt 0) {
        $directory = $directories.Pop()
        foreach ($entry in $directory.EnumerateFileSystemInfos()) {
            if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw ('Prepared staging tree contains a reparse point: ' + $entry.FullName)
            }
            $entryFull = Get-NormalizedFullPath $entry.FullName
            if (-not $entryFull.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw ('Prepared staging entry escapes the staging directory: ' + $entry.FullName)
            }
            $relative = $entryFull.Substring($prefix.Length).Replace('\', '/')
            $safeRelative = ConvertTo-SafeRelativePath $relative 'Prepared staging entry'
            if ($entry -is [System.IO.DirectoryInfo]) {
                $directories.Push([System.IO.DirectoryInfo] $entry)
            } elseif ($entry -is [System.IO.FileInfo]) {
                if ($files.ContainsKey($safeRelative)) {
                    throw ('Prepared staging tree contains a duplicate case-insensitive path: ' + $safeRelative)
                }
                $files.Add($safeRelative, [System.IO.FileInfo] $entry)
            } else {
                throw ('Prepared staging tree contains an unsupported entry: ' + $entry.FullName)
            }
        }
    }
    return [pscustomobject] @{ Root = $root; Files = $files }
}

function Get-LauncherVersionIdentity([string] $Value) {
    $text = ([string] $Value).Trim()
    if ($text -notmatch '^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$') { return '' }
    $parts = New-Object 'System.Collections.Generic.List[string]'
    foreach ($group in @($Matches[1], $Matches[2], $Matches[3], $Matches[4])) {
        if ($null -eq $group -or [string] $group -eq '') { continue }
        $normalized = ([string] $group).TrimStart([char] '0')
        if (-not $normalized) { $normalized = '0' }
        $parts.Add($normalized)
    }
    while ($parts.Count -gt 3 -and $parts[$parts.Count - 1] -eq '0') {
        $parts.RemoveAt($parts.Count - 1)
    }
    return ($parts -join '.')
}

function Test-ExpectedVersion([string] $Target, [string] $Expected) {
    if (-not $Target -or -not (Test-Path -LiteralPath $Target -PathType Leaf)) { return $false }
    if (-not $Expected) { return $true }
    try {
        $null = Assert-RegularFile $Target 'Launcher executable'
        $actual = [string] (Get-Item -LiteralPath $Target -Force).VersionInfo.ProductVersion
        if ($actual -eq $Expected -or $actual.StartsWith($Expected + '.')) { return $true }
        $actualIdentity = Get-LauncherVersionIdentity $actual
        $expectedIdentity = Get-LauncherVersionIdentity $Expected
        return $actualIdentity -and $expectedIdentity -and $actualIdentity -eq $expectedIdentity
    } catch {
        return $false
    }
}

function Assert-StagedReceipt {
    $stagingDir = [string] $script:payload.stagingDir
    $receiptPath = [string] $script:payload.receiptPath
    $receiptSha256 = [string] $script:payload.receiptSha256
    $expectedVersion = [string] $script:payload.expectedVersion
    if (-not $receiptPath -or -not $receiptSha256) {
        throw 'Prepared launcher staging receipt contract is missing.'
    }
    $receiptItem = Assert-FileSha256 $receiptPath $receiptSha256 'Prepared launcher staging receipt'
    $receipt = Get-Content -LiteralPath $receiptItem.FullName -Raw | ConvertFrom-Json
    if ([string] $receipt.schema -ne 'aht-launcher-staged-update/v1') {
        throw ('Prepared launcher staging receipt schema is invalid: ' + [string] $receipt.schema)
    }
    if ([string] $receipt.expectedVersion -ne $expectedVersion) {
        throw 'Prepared launcher staging receipt version does not match the handoff.'
    }
    $payloadTarget = ConvertTo-SafeRelativePath ([string] $script:payload.targetRelativePath) 'Launcher target path'
    $receiptTarget = ConvertTo-SafeRelativePath ([string] $receipt.targetExeRelativePath) 'Receipt launcher target path'
    if (-not $payloadTarget.Equals($receiptTarget, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Prepared launcher staging receipt target does not match the handoff.'
    }
    $tree = Get-StagedTree $stagingDir
    $receiptFiles = @($receipt.files)
    $declaredCount = [int64] $receipt.fileCount
    $declaredBytes = [int64] $receipt.totalBytes
    if ($declaredCount -lt 1 -or $declaredCount -gt 20000 -or $receiptFiles.Count -ne $declaredCount) {
        throw 'Prepared launcher staging receipt file count is invalid.'
    }
    if ($declaredBytes -lt 1 -or $declaredBytes -gt 4294967296) {
        throw 'Prepared launcher staging receipt byte count is invalid.'
    }
    if ($tree.Files.Count -ne $declaredCount) {
        throw ('Prepared launcher staging tree file count changed. Expected ' + $declaredCount + ', got ' + $tree.Files.Count + '.')
    }

    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    $treeText = New-Object System.Text.StringBuilder
    [int64] $actualBytes = 0
    foreach ($file in $receiptFiles) {
        $relative = ConvertTo-SafeRelativePath ([string] $file.path) 'Receipt file path'
        if (-not $seen.Add($relative)) { throw ('Prepared launcher receipt repeats a path: ' + $relative) }
        $fileInfo = $null
        if (-not $tree.Files.TryGetValue($relative, [ref] $fileInfo)) {
            throw ('Prepared launcher staging file is missing: ' + $relative)
        }
        $resolved = Resolve-StagedPath $tree.Root $relative 'Receipt file path'
        if (-not $fileInfo.FullName.Equals($resolved.FullPath, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw ('Prepared launcher staging file path is ambiguous: ' + $relative)
        }
        $null = Assert-RegularFile $fileInfo.FullName ('Prepared launcher staging file ' + $relative)
        $fileInfo.Refresh()
        $expectedSize = [int64] $file.size
        if ($expectedSize -lt 0 -or $fileInfo.Length -ne $expectedSize) {
            throw ('Prepared launcher staging file size changed: ' + $relative)
        }
        $expectedFileHash = Get-NormalizedSha256 ([string] $file.sha256) ('Receipt file hash for ' + $relative)
        $actualFileHash = Get-FileSha256 $fileInfo.FullName
        if ($actualFileHash -ne $expectedFileHash) {
            throw ('Prepared launcher staging file hash changed: ' + $relative)
        }
        $fileInfo.Refresh()
        if ($fileInfo.Length -ne $expectedSize) {
            throw ('Prepared launcher staging file size changed while it was being verified: ' + $relative)
        }
        $actualBytes += $fileInfo.Length
        $null = $treeText.Append($relative.ToLowerInvariant()).Append([char] 0)
        $null = $treeText.Append([string] $fileInfo.Length).Append([char] 0)
        $null = $treeText.Append($actualFileHash).Append([char] 0)
    }
    if ($actualBytes -ne $declaredBytes) {
        throw ('Prepared launcher staging byte count changed. Expected ' + $declaredBytes + ', got ' + $actualBytes + '.')
    }
    $expectedTreeHash = Get-NormalizedSha256 ([string] $receipt.treeSha256) 'Receipt tree hash'
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $treeBytes = [System.Text.Encoding]::UTF8.GetBytes($treeText.ToString())
        $actualTreeHash = ([System.BitConverter]::ToString($sha.ComputeHash($treeBytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
    if ($actualTreeHash -ne $expectedTreeHash) {
        throw ('Prepared launcher staging tree hash changed. Expected ' + $expectedTreeHash + ', got ' + $actualTreeHash + '.')
    }
    $target = (Resolve-StagedPath $tree.Root $payloadTarget 'Launcher target path').FullPath
    if (-not (Test-ExpectedVersion $target $expectedVersion)) {
        throw ('Prepared launcher executable version no longer matches the update: ' + $target)
    }
    return [pscustomobject] @{ StagingDir = $tree.Root; Target = $target; TreeSha256 = $actualTreeHash }
}

function Get-BlockingLauncherProcesses([string] $Target, [bool] $IncludeUnknownPath) {
    if (-not $Target) { return @() }
    $targetName = [System.IO.Path]::GetFileNameWithoutExtension($Target)
    $targetFull = (Get-NormalizedFullPath $Target).ToLowerInvariant()
    $matches = @()
    foreach ($process in Get-Process -Name $targetName -ErrorAction SilentlyContinue) {
        if ($process.Id -eq $PID) { continue }
        $processPath = ''
        try { $processPath = [string] $process.Path } catch {}
        if (-not $processPath) {
            if ($IncludeUnknownPath) { $matches += $process }
            continue
        }
        try {
            if ((Get-NormalizedFullPath $processPath).ToLowerInvariant() -eq $targetFull) { $matches += $process }
        } catch {}
    }
    return $matches
}

function Wait-ForLauncherExit([string] $Target) {
    if ([int] $script:payload.oldPid -gt 0) {
        try {
            $old = Get-Process -Id ([int] $script:payload.oldPid) -ErrorAction SilentlyContinue
            if ($old) { Wait-Process -Id ([int] $script:payload.oldPid) -Timeout 120 -ErrorAction SilentlyContinue }
        } catch {}
    }
    $remaining = @()
    for ($i = 0; $i -lt 960; $i += 1) {
        $remaining = @(Get-BlockingLauncherProcesses $Target $false)
        if ($remaining.Count -eq 0) { return }
        Start-Sleep -Milliseconds 250
    }
    throw ('Timed out waiting for launcher processes to close: ' + (($remaining | ForEach-Object { $_.Id }) -join ', '))
}

function ConvertTo-WindowsCommandLineArgument([string] $Value) {
    if ($null -eq $Value) { return '""' }
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $builder = New-Object System.Text.StringBuilder
    $null = $builder.Append('"')
    $backslashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') {
            $backslashes += 1
        } elseif ($character -eq '"') {
            if ($backslashes -gt 0) { $null = $builder.Append(('\' * ($backslashes * 2))) }
            $null = $builder.Append('\"')
            $backslashes = 0
        } else {
            if ($backslashes -gt 0) { $null = $builder.Append(('\' * $backslashes)); $backslashes = 0 }
            $null = $builder.Append($character)
        }
    }
    if ($backslashes -gt 0) { $null = $builder.Append(('\' * ($backslashes * 2))) }
    $null = $builder.Append('"')
    return $builder.ToString()
}

function Stop-CandidateLauncherProcesses([string] $Target) {
    $remaining = @()
    for ($i = 0; $i -lt 40; $i += 1) {
        $remaining = @(Get-BlockingLauncherProcesses $Target $false)
        if ($remaining.Count -eq 0) { return $true }
        foreach ($process in $remaining) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Milliseconds 250
    }
    $remaining = @(Get-BlockingLauncherProcesses $Target $false)
    if ($remaining.Count -gt 0) {
        Write-UpdateLog ('Could not stop all updated launcher processes: ' + (($remaining | ForEach-Object { $_.Id }) -join ', '))
        return $false
    }
    return $true
}

function Start-UpdatedLauncher([string] $Target, [string] $WorkingDirectory) {
    $arguments = @()
    if ($script:payload.relaunchArgs) {
        foreach ($argument in $script:payload.relaunchArgs) { $arguments += [string] $argument }
    }
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $Target
    $startInfo.Arguments = (($arguments | ForEach-Object { ConvertTo-WindowsCommandLineArgument ([string] $_) }) -join ' ')
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $false
    $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Normal
    $handoffNonce = [string] $script:payload.handoffNonce
    if ($handoffNonce -notmatch '^[a-f0-9]{32}$') { throw 'Launcher update handoff nonce is invalid.' }
    $startInfo.EnvironmentVariables['AHT_LAUNCHER_UPDATE_HANDOFF_NONCE'] = $handoffNonce
    if ($script:payload.relaunchDeveloper -eq $true) {
        $startInfo.EnvironmentVariables['AHT_ALLOW_DEVELOPER'] = '1'
    }
    $process = [System.Diagnostics.Process]::Start($startInfo)
    if ($null -eq $process) { throw ('Could not start launcher executable: ' + $Target) }
    return $process
}

function Wait-ForStartupAcknowledgement([System.Diagnostics.Process] $Process, [string] $ExpectedTarget) {
    $ackPath = [string] $script:payload.ackPath
    $nonce = [string] $script:payload.handoffNonce
    $expected = [string] $script:payload.expectedVersion
    $expectedTargetFull = Get-NormalizedFullPath $ExpectedTarget
    if (-not $ackPath -or -not $nonce) { throw 'Launcher update acknowledgement contract is missing.' }
    for ($i = 0; $i -lt 960; $i += 1) {
        if (Test-Path -LiteralPath $ackPath -PathType Leaf) {
            try {
                $ackItem = Assert-RegularFile $ackPath 'Launcher update acknowledgement'
                $ack = Get-Content -LiteralPath $ackItem.FullName -Raw | ConvertFrom-Json
                $ackTarget = Get-NormalizedFullPath ([string] $ack.executablePath)
                $processTarget = ''
                try {
                    $runningProcess = Get-Process -Id $Process.Id -ErrorAction Stop
                    $processTarget = Get-NormalizedFullPath ([string] $runningProcess.Path)
                } catch {}
                if ([string] $ack.handoffNonce -eq $nonce -and
                    ([string] $ack.version -eq $expected -or ([string] $ack.version).StartsWith($expected + '.')) -and
                    [int] $ack.processId -eq [int] $Process.Id -and
                    ([bool] $ack.developerMode -eq [bool] ($script:payload.relaunchDeveloper -eq $true)) -and
                    $ackTarget.Equals($expectedTargetFull, [System.StringComparison]::OrdinalIgnoreCase) -and
                    $processTarget -and $processTarget.Equals($expectedTargetFull, [System.StringComparison]::OrdinalIgnoreCase)) {
                    return $ack
                }
            } catch {}
        }
        if ($Process.HasExited) { throw ('Updated launcher exited before startup acknowledgement with code ' + $Process.ExitCode) }
        Start-Sleep -Milliseconds 125
    }
    throw 'Updated launcher did not acknowledge a ready window within 120 seconds.'
}

function Write-CommitAccepted($Ack, [string] $ExpectedTarget) {
    $ackPath = [string] $script:payload.ackPath
    $commitPath = $ackPath + '.commit.json'
    $parent = Split-Path -Parent $commitPath
    $null = Assert-NoReparsePath $parent $true
    if (Test-Path -LiteralPath $commitPath) {
        $null = Assert-RegularFile $commitPath 'Launcher update commit marker'
        Remove-Item -LiteralPath $commitPath -Force
    }
    $treeSha256 = Get-NormalizedSha256 ([string] $script:payload.treeSha256) 'Launcher update committed tree hash'
    $record = [ordered] @{
        schema = 'aht-launcher-update-commit/v1'
        product = 'aht-launcher'
        handoffNonce = [string] $script:payload.handoffNonce
        version = [string] $script:payload.expectedVersion
        processId = [int] $Ack.processId
        executablePath = (Get-NormalizedFullPath $ExpectedTarget)
        developerMode = [bool] $Ack.developerMode
        treeSha256 = $treeSha256
        acceptedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    $temporary = Join-Path $parent ('.launcher-update-commit-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    $encoding = New-Object System.Text.UTF8Encoding($false)
    try {
        [System.IO.File]::WriteAllText($temporary, ($record | ConvertTo-Json -Depth 8), $encoding)
        [System.IO.File]::Move($temporary, $commitPath)
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
    }
    return $commitPath
}

function Assert-StagedSwapPaths([string] $InstallDir, [string] $StagingDir, [string] $BackupDir) {
    $installFull = Assert-NoReparsePath $InstallDir $true
    $stagingFull = Assert-NoReparsePath $StagingDir $true
    $backupFull = Assert-NoReparsePath $BackupDir $false
    $installItem = Get-Item -LiteralPath $installFull -Force
    $stagingItem = Get-Item -LiteralPath $stagingFull -Force
    if (-not $installItem.PSIsContainer -or -not $stagingItem.PSIsContainer) {
        throw 'Launcher update install and staging paths must be directories.'
    }
    $installParent = [System.IO.Path]::GetDirectoryName($installFull)
    foreach ($candidate in @($stagingFull, $backupFull)) {
        if (-not ([System.IO.Path]::GetDirectoryName($candidate)).Equals($installParent, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'Launcher update transaction paths are not same-volume siblings.'
        }
    }
    if ($installFull.Equals($stagingFull, [System.StringComparison]::OrdinalIgnoreCase) -or
        $installFull.Equals($backupFull, [System.StringComparison]::OrdinalIgnoreCase) -or
        $stagingFull.Equals($backupFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Launcher update transaction paths must be distinct.'
    }
    if (-not ([System.IO.Path]::GetFileName($stagingFull)).StartsWith('.aht-launcher-update-', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Launcher update staging directory name is invalid.'
    }
    if (-not ([System.IO.Path]::GetFileName($backupFull)).StartsWith('.aht-launcher-backup-', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Launcher update backup directory name is invalid.'
    }
    if (Test-Path -LiteralPath $backupFull) { throw 'Launcher update backup destination already exists.' }
    return [pscustomobject] @{ InstallDir = $installFull; StagingDir = $stagingFull; BackupDir = $backupFull }
}

function Move-DirectoryWithRetry([string] $Source, [string] $Destination, [int] $Attempts = 40) {
    $lastError = ''
    for ($i = 0; $i -lt $Attempts; $i += 1) {
        if (-not (Test-Path -LiteralPath $Source -PathType Container)) { return $true }
        if (Test-Path -LiteralPath $Destination) {
            $lastError = 'destination already exists'
            break
        }
        try {
            [System.IO.Directory]::Move($Source, $Destination)
            return $true
        } catch {
            $lastError = $_.Exception.Message
            Start-Sleep -Milliseconds 250
        }
    }
    Write-UpdateLog ('Could not move directory ' + $Source + ' -> ' + $Destination + ': ' + $lastError)
    return $false
}

function Invoke-LegacyInstallerUpdate {
    $target = [string] $script:payload.targetExe
    $installerPath = [string] $script:payload.installerPath
    $installerItem = Assert-RegularFile $installerPath 'Launcher update installer'
    if ($script:payload.PSObject.Properties['installerSize'] -and [int64] $script:payload.installerSize -gt 0 -and
        $installerItem.Length -ne [int64] $script:payload.installerSize) {
        throw 'Launcher update installer size changed.'
    }
    if ($script:payload.PSObject.Properties['installerSha256'] -and [string] $script:payload.installerSha256) {
        $null = Assert-FileSha256 $installerItem.FullName ([string] $script:payload.installerSha256) 'Launcher update installer'
    }
    Write-UpdateLog ('Ready to quit nonce=' + [string] $script:payload.handoffNonce)
    Wait-ForLauncherExit $target
    $installerArgs = @()
    if ($script:payload.installerArgs) {
        foreach ($argument in $script:payload.installerArgs) { $installerArgs += [string] $argument }
    }
    Write-UpdateLog ('Running legacy installer ' + $installerItem.FullName)
    $installer = Start-Process -FilePath $installerItem.FullName -ArgumentList $installerArgs -Wait -PassThru -WindowStyle Hidden
    if ($null -ne $installer.ExitCode -and [int] $installer.ExitCode -ne 0) {
        throw ('Installer exited with code ' + $installer.ExitCode)
    }
    if (-not (Test-ExpectedVersion $target ([string] $script:payload.expectedVersion))) {
        throw ('Updated launcher executable was not ready: ' + $target)
    }
    Write-UpdateLog ('Starting updated launcher ' + $target)
    $null = Start-UpdatedLauncher $target (Split-Path -Parent $target)
    $null = Remove-PendingForCommittedHandoff $false
}

function Invoke-StagedSwapUpdate {
    $paths = Assert-StagedSwapPaths ([string] $script:payload.installDir) ([string] $script:payload.stagingDir) ([string] $script:payload.backupDir)
    $targetRelativePath = ConvertTo-SafeRelativePath ([string] $script:payload.targetRelativePath) 'Launcher target path'
    $oldTarget = (Resolve-StagedPath $paths.InstallDir $targetRelativePath 'Installed launcher target path').FullPath

    $null = Assert-StagedReceipt
    Write-UpdateLog ('Ready to quit nonce=' + [string] $script:payload.handoffNonce)
    Wait-ForLauncherExit $oldTarget

    # Close the validation-to-swap gap after the old launcher has exited.
    $null = Assert-StagedReceipt
    Write-UpdateLog ('Swapping prepared launcher payload into ' + $paths.InstallDir)
    [System.IO.Directory]::Move($paths.InstallDir, $paths.BackupDir)
    $script:originalMoved = $true
    [System.IO.Directory]::Move($paths.StagingDir, $paths.InstallDir)
    $script:candidateMoved = $true

    $newTarget = (Resolve-StagedPath $paths.InstallDir $targetRelativePath 'Updated launcher target path').FullPath
    if (-not (Test-ExpectedVersion $newTarget ([string] $script:payload.expectedVersion))) {
        throw 'Swapped launcher executable version does not match the update.'
    }
    $script:newProcess = Start-UpdatedLauncher $newTarget $paths.InstallDir
    Write-UpdateLog ('Started updated launcher PID ' + $script:newProcess.Id)
    $acceptedAck = Wait-ForStartupAcknowledgement $script:newProcess $newTarget
    Write-UpdateLog ('Updated launcher acknowledged a ready window for nonce ' + $script:payload.handoffNonce)
    $null = Remove-PendingForCommittedHandoff $true
    if ($script:pendingFailurePath) { Remove-Item -LiteralPath $script:pendingFailurePath -Force -ErrorAction SilentlyContinue }
    $commitPath = Write-CommitAccepted $acceptedAck $newTarget
    Write-UpdateLog ('Launcher update commit accepted at ' + $commitPath)
    if (Test-Path -LiteralPath $paths.BackupDir) {
        Write-UpdateLog ('Updated launcher is ready; delegated rollback directory cleanup to the new launcher: ' + $paths.BackupDir)
    }
}

function Restore-StagedSwap([string] $Reason) {
    $installDir = Get-NormalizedFullPath ([string] $script:payload.installDir)
    $stagingDir = Get-NormalizedFullPath ([string] $script:payload.stagingDir)
    $backupDir = Get-NormalizedFullPath ([string] $script:payload.backupDir)
    $targetRelativePath = ConvertTo-SafeRelativePath ([string] $script:payload.targetRelativePath) 'Launcher target path'
    $newTarget = (Resolve-StagedPath $installDir $targetRelativePath 'Updated launcher target path').FullPath

    if ($script:candidateMoved -or $null -ne $script:newProcess) {
        try {
            $null = Stop-CandidateLauncherProcesses $newTarget
        } catch {
            Write-UpdateLog ('Stopping updated launcher processes failed: ' + $_.Exception.Message)
        }
    }

    $candidateQuarantined = -not $script:candidateMoved
    if ($script:candidateMoved -and (Test-Path -LiteralPath $installDir -PathType Container)) {
        $destination = $stagingDir
        if (Test-Path -LiteralPath $destination) {
            $safeNonce = ([string] $script:payload.handoffNonce) -replace '[^A-Za-z0-9_-]', ''
            if (-not $safeNonce) { $safeNonce = [Guid]::NewGuid().ToString('N') }
            $destination = Join-Path ([System.IO.Path]::GetDirectoryName($installDir)) ('.aht-launcher-failed-' + $safeNonce + '-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmssfff'))
        }
        try {
            $candidateQuarantined = Move-DirectoryWithRetry $installDir $destination 40
            if ($candidateQuarantined) { Write-UpdateLog ('Quarantined failed launcher candidate at ' + $destination) }
        } catch {
            $candidateQuarantined = $false
            Write-UpdateLog ('Quarantining failed launcher candidate raised an error: ' + $_.Exception.Message)
        }
    }

    $originalRestored = $false
    if ($script:originalMoved) {
        try {
            if (-not (Test-Path -LiteralPath $installDir) -and (Test-Path -LiteralPath $backupDir -PathType Container)) {
                $originalRestored = Move-DirectoryWithRetry $backupDir $installDir 40
            } elseif ((Test-Path -LiteralPath $installDir -PathType Container) -and -not (Test-Path -LiteralPath $backupDir)) {
                $originalRestored = $candidateQuarantined
            }
        } catch {
            Write-UpdateLog ('Restoring previous launcher raised an error: ' + $_.Exception.Message)
        }
    }

    # The old launcher checks these before creating a window. Persist retry state first.
    $failureWritten = Write-PendingFailure $Reason
    $pendingReset = Reset-PendingForRetry $Reason
    if (-not $failureWritten) { Write-UpdateLog 'Launcher update failure marker was not persisted.' }
    if (-not $pendingReset) { Write-UpdateLog 'Launcher update pending record was not reset.' }

    if ($script:originalMoved -and $originalRestored) {
        $oldTarget = (Resolve-StagedPath $installDir $targetRelativePath 'Restored launcher target path').FullPath
        if (Test-ExpectedVersion $oldTarget '') {
            $null = Start-UpdatedLauncher $oldTarget $installDir
            Write-UpdateLog 'Restored and reopened the previous launcher.'
        } else {
            Write-UpdateLog ('Previous launcher was restored but its executable is missing: ' + $oldTarget)
        }
    } elseif ($script:originalMoved) {
        Write-UpdateLog 'Previous launcher could not be restored; its backup was retained.'
    }
}

try {
    $helperItem = Assert-FileSha256 $PSCommandPath $ExpectedHelperSha256 'Launcher update helper'
    $payloadItem = Assert-FileSha256 $PayloadPath $ExpectedPayloadSha256 'Launcher update payload'
    $script:payload = Get-Content -LiteralPath $payloadItem.FullName -Raw | ConvertFrom-Json
    $script:logPath = [string] $script:payload.logPath
    $script:pendingPath = [string] $script:payload.pendingPath
    $script:pendingFailurePath = [string] $script:payload.pendingFailurePath
    if (-not [string] $script:payload.handoffNonce) { throw 'Launcher update handoff nonce is missing.' }
    Write-UpdateLog ('Handoff started nonce=' + [string] $script:payload.handoffNonce + ' mode=' + [string] $script:payload.mode)
    if ($script:payload.testStartOnly -eq $true) {
        Write-UpdateLog 'Test mode helper startup confirmed.'
        exit 0
    }
    if ([string] $script:payload.mode -eq 'staged-swap') {
        Invoke-StagedSwapUpdate
    } elseif ([string] $script:payload.mode -eq 'legacy-installer') {
        Invoke-LegacyInstallerUpdate
    } else {
        throw ('Unknown launcher update helper mode: ' + [string] $script:payload.mode)
    }
    Write-UpdateLog 'Launcher update handoff complete.'
    exit 0
} catch {
    $reason = [string] $_.Exception.Message
    Write-UpdateLog ('Launcher update helper failed: ' + $reason)
    if ($script:payload -and [string] $script:payload.mode -eq 'staged-swap') {
        try { Restore-StagedSwap $reason } catch { Write-UpdateLog ('Rollback also failed: ' + $_.Exception.Message) }
    } elseif ($script:payload) {
        $null = Write-PendingFailure $reason
        $null = Reset-PendingForRetry $reason
    }
    [Console]::Error.WriteLine($reason)
    exit 1
}
