$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

Write-Host "[pre-complete] running test suite..."
npm test

Write-Host "[pre-complete] running build..."
npm run build

Write-Host "[pre-complete] verification passed."
