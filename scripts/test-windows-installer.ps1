param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$UpdateZip,
  [Parameter(Mandatory=$true)][string]$ExpectedVersion,
  [Parameter(Mandatory=$true)][string]$EvidenceDirectory
)
$ErrorActionPreference = 'Stop'
if (!(($env:GITHUB_ACTIONS -eq 'true' -and $env:RUNNER_OS -eq 'Windows') -or $env:USERNAME -eq 'WDAGUtilityAccount')) {
  throw 'Fresh installer test requires a disposable GitHub Windows runner or Windows Sandbox.'
}
if ($ExpectedVersion -notmatch '^\d+\.\d+\.\d+(?:-repair\.[1-9]\d*)?$') { throw 'Invalid expected version' }
foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryHive]::LocalMachine)) {
  foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)) {
    $registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view)
    try {
      $uninstallRoot=$registry.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall')
      if ($uninstallRoot) {
        try {
          foreach ($keyName in $uninstallRoot.GetSubKeyNames()) {
            $key=$uninstallRoot.OpenSubKey($keyName)
            try { if ([string]$key.GetValue('DisplayName') -match '^(A Hard Time|AHT Launcher)') { throw 'An AHT installation already exists; refusing the fresh-installer test.' } }
            finally { $key.Dispose() }
          }
        } finally { $uninstallRoot.Dispose() }
      }
    } finally { $registry.Dispose() }
  }
}
$Installer=(Resolve-Path -LiteralPath $Installer).Path
$UpdateZip=(Resolve-Path -LiteralPath $UpdateZip).Path
$evidenceRoot=[IO.Path]::GetFullPath($EvidenceDirectory)
[IO.Directory]::CreateDirectory($evidenceRoot) | Out-Null
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('aht-fresh-installer-'+[Guid]::NewGuid().ToString('N'))
$installRoot=Join-Path $testRoot 'Application'
$profile=Join-Path $testRoot 'Profile'
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
$installerProcess=$null; $applicationProcess=$null
$result=[ordered]@{version=$ExpectedVersion;installerSha256=(Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant();freshInstall=$false;filesMatched=0;windowReady=$false;silentUninstall=$false}
try {
  $installerProcess=Start-Process -FilePath $Installer -ArgumentList @('/S','/currentuser',('/D='+$installRoot)) -WindowStyle Hidden -PassThru
  if (!$installerProcess.WaitForExit(60000)) { throw 'Fresh installer did not finish within 60 seconds; possible extraction error dialog.' }
  if ($installerProcess.ExitCode -ne 0) { throw ('Fresh installer failed: '+$installerProcess.ExitCode) }
  $exe=Join-Path $installRoot 'A Hard Time Launcher Windows.exe'
  if (!(Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Fresh installer did not install the launcher executable.' }
  $productVersion=(Get-Item -LiteralPath $exe).VersionInfo.ProductVersion
  $numericResourceVersion=($ExpectedVersion -match '^\d+\.\d+\.\d+$' -and $productVersion -eq ($ExpectedVersion+'.0'))
  if ($productVersion -ne $ExpectedVersion -and !$numericResourceVersion) { throw 'Installed ProductVersion differs from the expected release.' }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip=[IO.Compression.ZipFile]::OpenRead($UpdateZip)
  try {
    foreach ($entry in $zip.Entries) {
      if (!$entry.Name) { continue }
      $target=[IO.Path]::GetFullPath((Join-Path $installRoot $entry.FullName))
      if (!$target.StartsWith($installRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escapes the isolated installation.' }
      if (!(Test-Path -LiteralPath $target -PathType Leaf)) { throw ('Missing installed file: '+$entry.FullName) }
      $stream=$entry.Open(); $hasher=[Security.Cryptography.SHA256]::Create()
      try { $expectedHash=[BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-','') }
      finally { $stream.Dispose(); $hasher.Dispose() }
      if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $expectedHash) { throw ('Installed file mismatch: '+$entry.FullName) }
      $result.filesMatched++
    }
  } finally { $zip.Dispose() }
  $result.freshInstall=$true
  $applicationProcess=Start-Process -FilePath $exe -ArgumentList ('--user-data-dir="'+$profile+'"') -WindowStyle Hidden -PassThru
  $deadline=[DateTime]::UtcNow.AddSeconds(30)
  while ([DateTime]::UtcNow -lt $deadline) {
    $applicationProcess.Refresh()
    if ($applicationProcess.HasExited) { throw 'Freshly installed launcher exited before opening a window.' }
    if ($applicationProcess.MainWindowHandle -ne 0) { $result.windowReady=$true; break }
    Start-Sleep -Milliseconds 200
  }
  if (!$result.windowReady) { throw 'Freshly installed launcher did not open a window.' }
  $null=$applicationProcess.CloseMainWindow()
  if (!$applicationProcess.WaitForExit(5000)) { $applicationProcess.Kill(); $applicationProcess.WaitForExit() }
  $uninstaller=Join-Path $installRoot 'Uninstall A Hard Time Launcher Windows.exe'
  $uninstallProcess=Start-Process -FilePath $uninstaller -ArgumentList @('/S','/currentuser',('_?='+$installRoot)) -WindowStyle Hidden -PassThru
  if (!$uninstallProcess.WaitForExit(30000)) { throw 'Silent uninstaller did not finish.' }
  if ($uninstallProcess.ExitCode -ne 0 -or (Test-Path -LiteralPath $exe)) { throw 'Silent uninstall did not remove the test launcher.' }
  $result.silentUninstall=$true
  $result.passed=$true
} catch {
  $result.passed=$false; $result.error=$_.Exception.Message
  throw
} finally {
  foreach ($process in @($installerProcess,$applicationProcess)) {
    if ($process -and !$process.HasExited) { $process.Kill() }
  }
  [IO.File]::WriteAllText((Join-Path $evidenceRoot 'installer-smoke.json'),($result | ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
  $result | ConvertTo-Json -Depth 5
}
