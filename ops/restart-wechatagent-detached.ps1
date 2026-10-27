Stop-Process -Name WeChatAgent -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '"D:\WeChatAgent\app\WeChatAgent.exe"' }
if ($r.ReturnValue -eq 0) { Write-Host ('WeChatAgent relaunched pid ' + $r.ProcessId) } else { Write-Host ('relaunch failed ' + $r.ReturnValue) }
