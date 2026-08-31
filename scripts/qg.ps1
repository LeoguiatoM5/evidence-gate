param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet("node", "npm", "npx")]
  [string]$Command,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CommandArguments
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$nodeRoot = Join-Path $projectRoot ".tooling\node\node-v22.23.2-win-x64"
$profileRoot = Join-Path $projectRoot ".local"
$temporaryRoot = Join-Path $projectRoot ".tmp"
$cacheRoot = Join-Path $projectRoot ".cache\npm"

New-Item -ItemType Directory -Path $profileRoot, $temporaryRoot, $cacheRoot -Force | Out-Null

$env:USERPROFILE = $profileRoot
$env:APPDATA = Join-Path $profileRoot "AppData\Roaming"
$env:LOCALAPPDATA = Join-Path $profileRoot "AppData\Local"
$env:TEMP = $temporaryRoot
$env:TMP = $temporaryRoot
$env:npm_config_cache = $cacheRoot
$env:Path = "$nodeRoot;$env:Path"

if (-not $env:DATABASE_URL) {
  $databasePath = (Join-Path $projectRoot "data\qualityguard.db").Replace("\", "/")
  $env:DATABASE_URL = "file:$databasePath"
}

$executable = Join-Path $nodeRoot "$Command.exe"
if ($Command -ne "node") {
  $executable = Join-Path $nodeRoot "$Command.cmd"
}

if (-not (Test-Path -LiteralPath $executable)) {
  throw "Runtime local não encontrado em $executable."
}

& $executable @CommandArguments
exit $LASTEXITCODE
