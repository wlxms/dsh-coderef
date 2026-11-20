# Restart the local DSH web instance used by the dsh-coderef prototype.
# The instance runs from the local deepseek-harness checkout (built artifacts)
# with an isolated DSH_HOME inside this workspace, so the DSH Desktop app is untouched.
$ErrorActionPreference = 'Stop'

$env:DSH_HOME = 'D:\dsh-mydsh\dsh-coderef\.dsh-home'
$checkout = 'D:\dsh-mydsh\deepseek-harness'
$node = 'C:\Program Files\nodejs\node.exe'

Write-Host "DSH_HOME = $env:DSH_HOME"
Write-Host "checkout = $checkout"
Write-Host 'Open the URL printed below (it carries the auth token). Close this window to stop the server.'
Write-Host ''

Set-Location $checkout
& $node 'apps\cli\lib\bin.js' web --port 3080
