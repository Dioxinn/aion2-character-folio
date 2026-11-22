[CmdletBinding()]
param(
    [string]$SdkDirectory,
    [string]$Python = 'python'
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$build = Join-Path $root 'build'
$version = '1.0.1264.42'
& $Python (Join-Path $root 'prepare.py')
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the game tables.' }

# Build against the published WebView2 SDK. An offline build can supply the
# same three components in the layout documented in the README.
if (-not $SdkDirectory) {
    $SdkDirectory = Join-Path $build "Microsoft.Web.WebView2.$version"
    if (-not (Test-Path (Join-Path $SdkDirectory 'lib\net45\Microsoft.Web.WebView2.Core.dll'))) {
        $archive = Join-Path $build "webview2-$version.zip"
        $url = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$version/microsoft.web.webview2.$version.nupkg"
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $archive
        Expand-Archive -LiteralPath $archive -DestinationPath $SdkDirectory -Force
    }
}
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$out = Join-Path $build 'Aion2CharacterFolio.exe'
$arguments = @('/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/debug-', "/out:$out",
    '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll', '/reference:System.Net.Http.dll', '/reference:System.Web.dll')

$hashes = [ordered]@{
    'Microsoft.Web.WebView2.Core.dll' = 'B1A3B02A593D89F14CB8D6B0B52746CD7F20028089D99810B56377B249577702'
    'Microsoft.Web.WebView2.WinForms.dll' = '43A843272AEB0C1D9524B77046B8135D520EDB963386B2895DB52C660F01A6D1'
    'WebView2Loader.dll' = 'FB82AC089963E1DEE932ACCE2F86BA34C128770CEC4B60BCFD86F95D29E971AB'
}
foreach ($name in $hashes.Keys) {
    if ($name -eq 'WebView2Loader.dll') {
        $file = Join-Path $SdkDirectory "runtimes\win-x64\native\$name"
    } else {
        $file = Join-Path $SdkDirectory "lib\net45\$name"
        if (-not (Test-Path -LiteralPath $file)) { $file = Join-Path $SdkDirectory $name }
    }
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $hashes[$name]) {
        throw "SDK component differs from the reviewed v$version binary: $name"
    }
    $arguments += "/resource:$file,sdk.$name"
    if ($name -ne 'WebView2Loader.dll') { $arguments += "/reference:$file" }
}
$assets = @('index.html','ui/app.js','ui/armory.js','ui/data.js','engine/engine.js','ui/style.css',
    'ui/fonts/OFL.txt','ui/fonts/InstrumentSerif-Regular.ttf','ui/fonts/BarlowCondensed-SemiBold.ttf',
    'ui/fonts/IBMPlexMono-Regular.ttf')
foreach ($name in $assets) {
    $file = Join-Path (Join-Path $root 'web') $name
    if ($name -eq 'ui/data.js') { $file = Join-Path $build 'data.js' }
    $arguments += "/resource:$file,web.$name"
}
foreach ($name in 'LICENSE','licenses/WebView2.txt') {
    $file = Join-Path $root $name
    $arguments += "/resource:$file,notice.$name"
}
& $compiler @arguments (Join-Path $root 'desktop\Desktop.cs')
if ($LASTEXITCODE -ne 0) { throw 'Compilation failed.' }
Write-Output $out
