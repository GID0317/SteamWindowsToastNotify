param(
    [Parameter(Mandatory = $true)][string]$XmlPath,
    [string]$AppId = 'Steam',
    [string]$LogPath
)

$ErrorActionPreference = 'Stop'

try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null

    $xmlText = [System.IO.File]::ReadAllText($XmlPath, [System.Text.Encoding]::UTF8)
    $document = New-Object Windows.Data.Xml.Dom.XmlDocument
    $document.LoadXml($xmlText)

    $toast = New-Object Windows.UI.Notifications.ToastNotification $document
    $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId)
    $notifier.Show($toast)
} catch {
    if (-not [string]::IsNullOrWhiteSpace($LogPath)) {
        try {
            Set-Content -LiteralPath $LogPath -Value $_.Exception.ToString() -Encoding UTF8
        } catch {
            # The fallback path has no other way to report failures.
        }
    }
} finally {
    Remove-Item -LiteralPath $XmlPath -ErrorAction SilentlyContinue
}
