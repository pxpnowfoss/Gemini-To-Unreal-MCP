<#
    Creates a Windows shortcut for this checkout.

    A .lnk stores absolute paths, so one cannot be committed to the repository —
    it would point at whatever machine built it. This generates a correct one
    locally instead, resolving the repo root at run time.

        npm run shortcut              # shortcut in the project folder
        npm run shortcut -- -Desktop  # also put one on the Desktop
        npm run shortcut -- -StartMenu
#>
param(
    [switch]$Desktop,
    [switch]$StartMenu
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root 'node_modules\electron\dist\electron.exe'
$name = 'Gemini to Unreal.lnk'

if (-not (Test-Path $exe)) {
    Write-Host "Electron is not installed yet." -ForegroundColor Yellow
    Write-Host "Run 'npm install' first (and 'node node_modules/electron/install.js' if npm blocked the postinstall)."
    exit 1
}

function New-AppShortcut([string]$path) {
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($path)
    $link.TargetPath = $exe
    $link.Arguments = '"' + $root + '"'
    $link.WorkingDirectory = $root
    $link.IconLocation = $exe + ',0'
    $link.Description = 'Build in Unreal Engine with Gemini'
    $link.Save()
    Write-Host "Created $path" -ForegroundColor Green
}

New-AppShortcut (Join-Path $root $name)

if ($Desktop) {
    New-AppShortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) $name)
}

if ($StartMenu) {
    $programs = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'
    if (-not (Test-Path $programs)) { New-Item -ItemType Directory -Path $programs | Out-Null }
    New-AppShortcut (Join-Path $programs $name)
}

Write-Host ''
Write-Host 'The shortcut launches the built app. After changing source, run "npm run build"'
Write-Host '(or use "npm start", which builds and launches in one step).'
