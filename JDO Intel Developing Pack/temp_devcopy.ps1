 = 'JDO Intel Developing Pack/dist/win-unpacked'
 = 'JDO Intel Developing Pack/dist/win-unpacked-dev'
if (Test-Path ) { Remove-Item  -Recurse -Force }
New-Item -ItemType Directory -Path  | Out-Null
cmd /c "mklink /J  \locales \locales" | Out-Null
Copy-Item -Recurse -Force \resources \resources
Get-ChildItem  -File | ForEach-Object {
  cmd /c "mklink /H \ " | Out-Null
}
Write-Output 'dev folder ready'
