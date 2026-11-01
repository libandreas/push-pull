param()

$ErrorActionPreference = 'Stop'
if ($args.Count -gt 0) { throw 'Place this script in the target project root or its common folder and run it without arguments.' }
$ProjectRoot = if ((Split-Path -Leaf $PSScriptRoot) -ieq 'common') { Split-Path -Parent $PSScriptRoot } else { $PSScriptRoot }
$Project = Get-Item -LiteralPath $ProjectRoot
# Optional Marketplace credentials. Without a token, packages are only built and saved.
$PublishToken = $env:JETBRAINS_TOKEN
$PublishChannel = $env:JETBRAINS_CHANNEL
$Utf8 = [System.Text.UTF8Encoding]::new($false)

function Test-JavaHome {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    return Test-Path -LiteralPath (Join-Path $Path 'bin\java.exe') -PathType Leaf
}

function Find-JavaHome {
    if (Test-JavaHome $env:JAVA_HOME) { return $env:JAVA_HOME }
    $javaCommand = Get-Command 'java.exe' -ErrorAction SilentlyContinue
    if ($javaCommand) {
        $javaDirectory = Split-Path -Parent (Split-Path -Parent $javaCommand.Source)
        if (Test-JavaHome $javaDirectory) { return $javaDirectory }
    }
    $searchRoots = @(
        "$env:ProgramFiles\Eclipse Adoptium",
        "$env:ProgramFiles\Java",
        "${env:ProgramFiles(x86)}\Eclipse Adoptium",
        "${env:ProgramFiles(x86)}\Java"
    ) | Where-Object { Test-Path -LiteralPath $_ }
    $jdk = $searchRoots | ForEach-Object {
        Get-ChildItem -LiteralPath $_ -Directory
    } | Where-Object { Test-JavaHome $_.FullName } | Sort-Object Name -Descending | Select-Object -First 1
    if ($jdk) { return $jdk.FullName }
    throw 'Java was not found. Set JAVA_HOME to the JDK used by the existing Build.ps1.'
}

function Find-WebStormHome {
    if (-not [string]::IsNullOrWhiteSpace($env:WEBSTORM_HOME)) {
        $productInfoPath = Join-Path $env:WEBSTORM_HOME 'product-info.json'
        $productInfo = Get-Content -LiteralPath $productInfoPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($productInfo.productCode -ne 'WS') { throw 'WEBSTORM_HOME must point to a WebStorm installation.' }
        return $env:WEBSTORM_HOME
    }
    $searchRoots = @(
        (Join-Path $env:ProgramFiles 'JetBrains'),
        (Join-Path $env:LOCALAPPDATA 'Programs'),
        (Join-Path $env:LOCALAPPDATA 'JetBrains\Toolbox\apps')
    ) | Where-Object { Test-Path -LiteralPath $_ }
    $installations = foreach ($searchRoot in $searchRoots) {
        Get-ChildItem -LiteralPath $searchRoot -Filter 'product-info.json' -File -Recurse -ErrorAction SilentlyContinue |
            ForEach-Object {
                $productInfo = Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($productInfo.productCode -eq 'WS') {
                    [PSCustomObject]@{ Path = $_.Directory.FullName; BuildNumber = [version]$productInfo.buildNumber }
                }
            }
    }
    $webStorm = $installations | Sort-Object BuildNumber -Descending | Select-Object -First 1
    if ($webStorm) { return $webStorm.Path }
    throw 'WebStorm was not found. Set WEBSTORM_HOME to the installation used by the existing Build.ps1.'
}

foreach ($RequiredFile in @('build.gradle.kts', 'gradle\wrapper\gradle-wrapper.jar', 'src\main\resources\META-INF\plugin.xml')) {
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot $RequiredFile) -PathType Leaf)) {
        throw "Missing JetBrains build file | project=$ProjectRoot | file=$RequiredFile"
    }
}

$env:JAVA_HOME = Find-JavaHome
$env:WEBSTORM_HOME = Find-WebStormHome
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
$JavaExecutable = Join-Path $env:JAVA_HOME 'bin\java.exe'
Write-Host "Java: $env:JAVA_HOME"
Write-Host "WebStorm: $env:WEBSTORM_HOME"

$OutputPath = $null
try {
        $GradlePath = Join-Path $ProjectRoot 'build.gradle.kts'
        $WrapperPath = Join-Path $ProjectRoot 'gradle\wrapper\gradle-wrapper.jar'
        if (-not (Test-Path -LiteralPath $WrapperPath -PathType Leaf)) { throw "Missing Gradle wrapper: $WrapperPath" }

        $GradleSource = [System.IO.File]::ReadAllText($GradlePath, $Utf8)
        $VersionPattern = [regex]::new('(?m)^\s*version\s*=\s*"(\d+)\.(\d+)\.(\d+)"')
        $VersionMatch = $VersionPattern.Match($GradleSource)
        if (-not $VersionMatch.Success) { throw "Missing numeric Gradle version in $GradlePath" }
        $Now = [System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::UtcNow, 'GTB Standard Time')
        $Year = $Now.Year % 100
        $Month = $Now.Month
        $Patch = 0
        if ([int]$VersionMatch.Groups[1].Value -eq $Year -and [int]$VersionMatch.Groups[2].Value -eq $Month) {
            $Patch = [int]$VersionMatch.Groups[3].Value + 1
        }
        $Version = "$Year.$Month.$Patch"
        $UpdatedGradle = $VersionPattern.Replace($GradleSource, "version = `"$Version`"", 1)
        [System.IO.File]::WriteAllText($GradlePath, $UpdatedGradle, $Utf8)

        Write-Host "Build | project=$($Project.Name) | version=$Version"
        $GradleBuildDirectory = $null
        Push-Location -LiteralPath $ProjectRoot
        try {
            & $JavaExecutable '-Xmx64m' '-Xms64m' '-Dorg.gradle.appname=gradlew' -jar 'gradle\wrapper\gradle-wrapper.jar' clean buildPlugin :properties --property buildDir --no-daemon --no-build-cache --rerun-tasks --console=plain --info --stacktrace |
                ForEach-Object {
                    Write-Host $_
                    if ($_ -match '^buildDir: (.+)$') { $GradleBuildDirectory = $Matches[1].Trim() }
                }
            if ($LASTEXITCODE -ne 0) { throw "Gradle buildPlugin failed | exitCode=$LASTEXITCODE" }
        } finally {
            Pop-Location
        }

        if ([string]::IsNullOrWhiteSpace($GradleBuildDirectory)) { throw 'Gradle did not report its buildDir property.' }
        $DistributionsPath = Join-Path $GradleBuildDirectory 'distributions'
        $Distributions = @(Get-ChildItem -LiteralPath $DistributionsPath -Filter '*.zip' -File)
        if ($Distributions.Count -ne 1) { throw "Expected one ZIP after clean build | directory=$DistributionsPath | count=$($Distributions.Count)" }
        $OutputPath = Join-Path $ProjectRoot 'output-jetbrains.zip'
        Copy-Item -LiteralPath $Distributions[0].FullName -Destination $OutputPath -Force
        Write-Host "Package saved | output=$OutputPath"

        if ([string]::IsNullOrWhiteSpace($PublishToken)) {
            Write-Host "Publish skipped | project=$($Project.Name) | missing=JETBRAINS_TOKEN | package=$OutputPath"
            exit 0
        }

        [xml]$PluginXml = Get-Content -LiteralPath (Join-Path $ProjectRoot 'src\main\resources\META-INF\plugin.xml') -Raw -Encoding UTF8
        $PluginXmlId = [string]$PluginXml.'idea-plugin'.id
        if ([string]::IsNullOrWhiteSpace($PluginXmlId)) { throw 'Missing plugin ID in plugin.xml.' }

        Add-Type -AssemblyName System.Net.Http
        $Client = [System.Net.Http.HttpClient]::new()
        $Client.Timeout = [TimeSpan]::FromMinutes(30)
        $Client.DefaultRequestHeaders.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $PublishToken)
        $Multipart = [System.Net.Http.MultipartFormDataContent]::new()
        $Response = $null
        try {
            $Multipart.Add([System.Net.Http.StringContent]::new($PluginXmlId), 'xmlId')
            if (-not [string]::IsNullOrWhiteSpace($PublishChannel)) {
                $Multipart.Add([System.Net.Http.StringContent]::new($PublishChannel), 'channel')
            }
            $FileContent = [System.Net.Http.StreamContent]::new([System.IO.File]::OpenRead($OutputPath))
            $FileContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::new('application/zip')
            $Multipart.Add($FileContent, 'file', [System.IO.Path]::GetFileName($OutputPath))
            Write-Host "Upload | project=$($Project.Name) | plugin=$PluginXmlId | version=$Version"
            $Response = $Client.PostAsync('https://plugins.jetbrains.com/api/updates/upload', $Multipart).GetAwaiter().GetResult()
            $ResponseText = $Response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            if (-not $Response.IsSuccessStatusCode) { throw "JetBrains upload failed | HTTP=$([int]$Response.StatusCode) | response=$ResponseText" }
            Write-Host "Submitted | project=$($Project.Name) | version=$Version | response=$ResponseText"
        } finally {
            if ($null -ne $Response) { $Response.Dispose() }
            $Multipart.Dispose()
            $Client.Dispose()
        }
} catch {
    Write-Warning "Failed | project=$($Project.Name) | package=$OutputPath | reason=$($_.Exception.Message)"
    exit 1
}
Write-Host "Completed | project=$($Project.Name) | package=$OutputPath"
exit 0
