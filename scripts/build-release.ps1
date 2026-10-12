$ErrorActionPreference = 'Stop'
Import-Module "$PSHOME/Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1" -ErrorAction Stop
$appRoot = Split-Path $PSScriptRoot -Parent
$keyDirectory = Join-Path $env:USERPROFILE '.deliverypro-signing'
$storePath = Join-Path $keyDirectory 'deliverypro-upload.p12'
$credentialPath = Join-Path $keyDirectory 'signing.xml'
$javaDirectory = Join-Path $env:USERPROFILE '.jdks/jdk-21.0.12.1+1'
if (!(Test-Path -LiteralPath (Join-Path $javaDirectory 'bin/keytool.exe'))) {
    throw 'JDK 21 is required. Update javaDirectory in this script to your JDK 21 installation.'
}
$oldJava = $env:JAVA_HOME
$env:JAVA_HOME = $javaDirectory
try {
    if (!(Test-Path -LiteralPath $keyDirectory)) {
        New-Item -ItemType Directory -Path $keyDirectory | Out-Null
        $acl = Get-Acl -LiteralPath $keyDirectory
        $acl.SetAccessRuleProtection($true, $false)
        $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($owner, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
        Set-Acl -LiteralPath $keyDirectory -AclObject $acl
    }
    if (!(Test-Path -LiteralPath $credentialPath)) {
        if (Test-Path -LiteralPath $storePath) { throw 'Existing signing key found without credentials. Restore its credentials; do not replace the key.' }
        $bytes = New-Object byte[] 32
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
        $securePassword = ConvertTo-SecureString ([Convert]::ToBase64String($bytes)) -AsPlainText -Force
        $credential = New-Object System.Management.Automation.PSCredential('deliverypro-upload', $securePassword)
        $credential | Export-Clixml -LiteralPath $credentialPath
        $newKey = $true
    } else {
        $credential = Import-Clixml -LiteralPath $credentialPath
        $newKey = $false
        if (!(Test-Path -LiteralPath $storePath)) { throw 'Signing key missing. Restore the original key instead of generating a replacement.' }
    }
    $env:DELIVERY_RELEASE_STORE = $storePath
    $env:DELIVERY_RELEASE_ALIAS = $credential.UserName
    $env:DELIVERY_RELEASE_PASSWORD = $credential.GetNetworkCredential().Password
    if ($newKey) {
        & (Join-Path $javaDirectory 'bin/keytool.exe') -genkeypair -keystore $storePath -storetype PKCS12 -alias $credential.UserName -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=Fastwave, O=Fastwave, C=KR' -storepass:env DELIVERY_RELEASE_PASSWORD -keypass:env DELIVERY_RELEASE_PASSWORD
        if ($LASTEXITCODE -ne 0) { throw 'Signing key generation failed. Keep the credential file and resolve the error before retrying.' }
    }
    Push-Location $appRoot
    try {
        & npm.cmd run cap:sync:android
        if ($LASTEXITCODE -ne 0) { throw 'Native sync failed.' }
        Push-Location (Join-Path $appRoot 'android')
        try {
            & .\gradlew.bat assembleRelease bundleRelease --console=plain
            if ($LASTEXITCODE -ne 0) { throw 'Release build failed.' }
        } finally { Pop-Location }
    } finally { Pop-Location }
    Write-Output "Signing key: $storePath"
    Write-Output "Credentials: $credentialPath (Windows DPAPI; only this Windows user on this computer can decrypt)"
    & (Join-Path $javaDirectory 'bin/keytool.exe') -list -v -keystore $storePath -storepass:env DELIVERY_RELEASE_PASSWORD -alias $credential.UserName
    if ($LASTEXITCODE -ne 0) { throw 'Certificate inspection failed.' }
} finally {
    $env:JAVA_HOME = $oldJava
    Remove-Item Env:DELIVERY_RELEASE_STORE, Env:DELIVERY_RELEASE_ALIAS, Env:DELIVERY_RELEASE_PASSWORD -ErrorAction SilentlyContinue
}
