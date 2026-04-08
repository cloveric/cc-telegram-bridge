param(
  [string]$Instance = "default"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

npm run dev -- telegram service status --instance $Instance
