$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'bridge\.js' }
foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force; Write-Host ('killed bridge pid ' + $p.ProcessId) }
