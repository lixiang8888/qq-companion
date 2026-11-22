# 她读书的后端：模拟器 → Legado → Web 服务 → 端口转发 → 体检
# 由插件在「读书后端连不上」时以 detached 方式拉起（src/host.js 的 wakeReader），
# 也可以手动跑：powershell -ExecutionPolicy Bypass -File .\启动阅读器.ps1
#
# 为什么这么绕：Legado 的「Web 服务」开关不跨重启保存，所以要启动 → 进「我的」页 →
# 把 Web service 那一行点开 → adb forward 1123→1122 → 体检 /getBookshelf。

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $root 'launcher.log'
$adb = Join-Path $env:APPDATA 'ApkStart\runtime\platform-tools\adb.exe'
$emu = Join-Path $env:APPDATA 'ApkStart\runtime\emulator\emulator.exe'
$avd = 'qqreader'
$serial = 'emulator-5580'
$port = 5580
$activity = 'com.legado.app.release/io.legado.app.ui.main.MainActivity'
$hostPort = 1123
$guestPort = 1122

function Log([string]$m) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'MM-dd HH:mm:ss'), $m
  Add-Content -Path $log -Value $line -Encoding utf8
}
function HealthOk {
  try {
    $r = Invoke-RestMethod "http://127.0.0.1:$hostPort/getBookshelf" -TimeoutSec 5
    return ($null -ne $r.data)
  } catch { return $false }
}
function IsRunning {
  $devices = (& $adb devices 2>$null | Out-String)
  return ($devices -match "(?m)^$serial\s+device")
}
function DumpUi {
  & $adb -s $serial shell uiautomator dump /sdcard/qqc-ui.xml 2>$null | Out-Null
  return (& $adb -s $serial shell cat /sdcard/qqc-ui.xml 2>$null | Out-String)
}
# 找「Web service / Web 服务」那一行，返回它的 bounds（找不到返回 $null）
function FindWebRow([string]$ui) {
  $m = [regex]::Match($ui, '<node[^>]*text="(?:Web service|Web 服务)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
  if (-not $m.Success) { return $null }
  return @{ x1 = [int]$m.Groups[1].Value; y1 = [int]$m.Groups[2].Value
    x2 = [int]$m.Groups[3].Value; y2 = [int]$m.Groups[4].Value }
}
# 这一行的开关现在是开还是关（按竖直距离找最近的那个 switch，容忍 40px）
function SwitchAt([string]$ui, $row) {
  $best = $null; $bestDy = 99999
  foreach ($m in [regex]::Matches($ui, '<node[^>]*resource-id="com\.legado\.app\.release:id/switchWidget"[^>]*checked="(true|false)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')) {
    $cy = ([int]$m.Groups[3].Value + [int]$m.Groups[5].Value) / 2
    $dy = [Math]::Abs($cy - (($row.y1 + $row.y2) / 2))
    if ($dy -lt $bestDy) { $bestDy = $dy; $best = @{ checked = $m.Groups[1].Value
        cx = [int](([int]$m.Groups[2].Value + [int]$m.Groups[4].Value) / 2)
        cy = [int]$cy } }
  }
  if ($null -eq $best -or $bestDy -gt 40) { return $null }
  return $best
}

Log '开始：拉阅读器'
if (-not (Test-Path $adb)) { Log "找不到 adb：$adb"; exit 1 }
& $adb start-server | Out-Null

# 1) 模拟器
if (IsRunning) {
  Log '模拟器已经在跑'
} else {
  if (-not (Test-Path $emu)) { Log "找不到模拟器：$emu"; exit 1 }
  Log "启动模拟器 $avd（端口 $port）"
  Start-Process -FilePath $emu -WindowStyle Hidden -ArgumentList @(
    '-avd', $avd, '-port', "$port", '-no-window', '-no-audio', '-no-boot-anim',
    '-no-snapshot', '-gpu', 'swiftshader_indirect'
  )
  $deadline = (Get-Date).AddSeconds(240)
  do {
    Start-Sleep -Seconds 3
    $boot = (& $adb -s $serial shell getprop sys.boot_completed 2>$null | Out-String).Trim()
  } while ($boot -ne '1' -and (Get-Date) -lt $deadline)
  if ($boot -ne '1') { Log '模拟器没起来（boot_completed 超时）'; exit 1 }
  Log '模拟器已启动'
}

# 2) 端口转发（每次都要重设：模拟器重启后 forward 没了）
& $adb -s $serial forward "tcp:$hostPort" "tcp:$guestPort" | Out-Null

# 3) 已经能读就收工（最省事的一条路）
if (HealthOk) { Log '阅读后端已经是通的，结束'; exit 0 }

# 4) 开 Legado，进「我的」页
Log '打开 Legado'
& $adb -s $serial shell am start -n $activity 2>$null | Out-Null
Start-Sleep -Seconds 4
$ui = DumpUi
$me = [regex]::Match($ui, '<node[^>]*content-desc="Me"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
if ($me.Success) {
  $mx = [int](([int]$me.Groups[1].Value + [int]$me.Groups[3].Value) / 2)
  $my = [int](([int]$me.Groups[2].Value + [int]$me.Groups[4].Value) / 2)
} else { $mx = 630; $my = 1230 }   # 720x1280 上「我的」在右下
& $adb -s $serial shell input tap $mx $my 2>$null | Out-Null
Start-Sleep -Seconds 2

# 5) 找到 Web service 那一行，需要就点开
$turned = $false
for ($i = 0; $i -lt 4; $i++) {
  $ui = DumpUi
  $row = FindWebRow $ui
  if ($null -eq $row) {
    & $adb -s $serial shell input swipe 360 1100 360 700 300 2>$null | Out-Null
    Start-Sleep -Milliseconds 800
    continue
  }
  $sw = SwitchAt $ui $row
  if ($null -ne $sw -and $sw.checked -eq 'true') { Log 'Web 服务已经是开的'; $turned = $true; break }
  $ty = [int](($row.y1 + $row.y2) / 2)
  Log "点 Web 服务那一行 @ 350,$ty"
  & $adb -s $serial shell input tap 350 $ty 2>$null | Out-Null
  Start-Sleep -Seconds 2
  $turned = $true
  break
}
if (-not $turned) { Log '没找到 Web 服务那一行（界面变了？）'; exit 1 }

# 6) 体检：等服务起监听
$deadline = (Get-Date).AddSeconds(25)
do {
  Start-Sleep -Seconds 2
  if (HealthOk) { Log "阅读后端通了：http://127.0.0.1:$hostPort"; exit 0 }
} while ((Get-Date) -lt $deadline)
Log 'Web 服务开了但 /getBookshelf 还是连不上'
exit 1
