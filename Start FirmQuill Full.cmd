@echo off
setlocal
cd /d "%~dp0"
if not exist "%ProgramFiles%\WindowsApps\OpenAI.CodexPrimaryRuntime.v26-1123-915-0_26.1123.915.0_x64__3k8sg7r9htsxt\dependencies\node\bin\node.exe" goto discover
"%ProgramFiles%\WindowsApps\OpenAI.CodexPrimaryRuntime.v26-1123-915-0_26.1123.915.0_x64__3k8sg7r9htsxt\dependencies\node\bin\node.exe" host.mjs
goto finished
:discover
powershell.exe -NoProfile -Command "$runtime = Get-Command node.exe -ErrorAction SilentlyContinue; if ($runtime) { & $runtime.Source 'host.mjs'; exit $LASTEXITCODE }; $pkg = Get-AppxPackage -Name 'OpenAI.CodexPrimaryRuntime*' | Sort-Object Version -Descending | Select-Object -First 1; if ($pkg) { $exe = Join-Path $pkg.InstallLocation 'dependencies\node\bin\node.exe'; if (Test-Path -LiteralPath $exe) { & $exe 'host.mjs'; exit $LASTEXITCODE } }; Write-Host 'Node.js 24 is required for this Full Suite host. See README.md.'; exit 1"
:finished
pause

