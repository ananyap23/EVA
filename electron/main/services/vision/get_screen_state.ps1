[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

$csPath = Join-Path $PSScriptRoot "DesktopPerceptionEngine.cs"
if (-not ([System.Management.Automation.PSTypeName]'DesktopPerceptionEngine').Type) {
  $code = Get-Content -Raw -Path $csPath -Encoding UTF8
  Add-Type -TypeDefinition $code -ReferencedAssemblies "WindowsBase", "System.Windows.Forms", "UIAutomationClient", "UIAutomationTypes"
}

$json = [DesktopPerceptionEngine]::CaptureSnapshotJson()
[Console]::Out.Write($json)
