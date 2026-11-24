$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'scripts\run.mjs') @args
exit $LASTEXITCODE
