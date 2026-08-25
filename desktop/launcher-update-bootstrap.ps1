param(
    [Parameter(Mandatory = $true)]
    [string] $PayloadPath,

    [Parameter(Mandatory = $true)]
    [string] $ExpectedPayloadSha256,

    [Parameter(Mandatory = $true)]
    [string] $HelperPath,

    [Parameter(Mandatory = $true)]
    [string] $ExpectedHelperSha256
)

$ErrorActionPreference = 'Stop'

function Get-NormalizedFullPath([string] $PathValue) {
    if ([string]::IsNullOrWhiteSpace($PathValue)) { throw 'A required launcher update bootstrap path is empty.' }
    return [System.IO.Path]::GetFullPath($PathValue)
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

function Assert-RegularFileWithoutReparse([string] $PathValue, [string] $Label) {
    $full = Get-NormalizedFullPath $PathValue
    $root = [System.IO.Path]::GetPathRoot($full)
    $current = $root
    $relative = $full.Substring($root.Length)
    foreach ($segment in $relative.Split(@('\', '/'), [System.StringSplitOptions]::RemoveEmptyEntries)) {
        $current = [System.IO.Path]::Combine($current, $segment)
        if (-not (Test-Path -LiteralPath $current)) { throw ($Label + ' is missing: ' + $current) }
        $item = Get-Item -LiteralPath $current -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw ($Label + ' path contains a reparse point: ' + $current)
        }
    }
    $leaf = Get-Item -LiteralPath $full -Force
    if ($leaf.PSIsContainer) { throw ($Label + ' is not a regular file: ' + $full) }
    return $leaf
}

function Assert-FileSha256([string] $PathValue, [string] $Expected, [string] $Label) {
    $expectedHash = Get-NormalizedSha256 $Expected ($Label + ' expected hash')
    $item = Assert-RegularFileWithoutReparse $PathValue $Label
    $actualHash = Get-FileSha256 $item.FullName
    if ($actualHash -ne $expectedHash) {
        throw ($Label + ' hash mismatch. Expected ' + $expectedHash + ', got ' + $actualHash + '.')
    }
    return $item
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

$payloadItem = Assert-FileSha256 $PayloadPath $ExpectedPayloadSha256 'Launcher update payload'
$helperItem = Assert-FileSha256 $HelperPath $ExpectedHelperSha256 'Launcher update helper'
$powerShell = Join-Path $PSHOME 'powershell.exe'
$null = Assert-RegularFileWithoutReparse $powerShell 'Windows PowerShell executable'
$innerArguments = @(
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-File',
    $helperItem.FullName,
    '-PayloadPath',
    $payloadItem.FullName,
    '-ExpectedPayloadSha256',
    (Get-NormalizedSha256 $ExpectedPayloadSha256 'Payload hash'),
    '-ExpectedHelperSha256',
    (Get-NormalizedSha256 $ExpectedHelperSha256 'Helper hash')
)
$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $powerShell
$startInfo.Arguments = (($innerArguments | ForEach-Object { ConvertTo-WindowsCommandLineArgument ([string] $_) }) -join ' ')
$startInfo.WorkingDirectory = Split-Path -Parent $helperItem.FullName
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$process = [System.Diagnostics.Process]::Start($startInfo)
if ($null -eq $process) { throw 'Windows could not start the independent launcher update helper.' }
Write-Output ('Started hidden launcher update helper PID ' + $process.Id)
