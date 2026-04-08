param(
  [string]$Instance = "default"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

node .\dist\src\index.js telegram service start --instance $Instance
