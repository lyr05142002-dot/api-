# Claude 用量小挂件：屏幕顶部常驻的一条，显示 5 小时 / 每周限额、重置时间，
# 以及 usage-meter 插件给上一条消息的模型建议。
#
# 数据：先读 Claude 的用量接口（用 Claude Code 存在本机的登录令牌，只读，只发给
# api.anthropic.com），网页、App、Claude Code 的用量都算在里面；读不到时退回
# usage-meter 插件最后一次记下的数字。
#
# 用法：powershell -ExecutionPolicy Bypass -File usage-widget.ps1
#       加 -NoWindow 只打印读到的数据（排查用）。
param([switch]$NoWindow)

$ClaudeDir = Join-Path $env:USERPROFILE '.claude'
$SelfPath = $PSCommandPath
$HostExe = (Get-Process -Id $PID).Path
$StateFile = Join-Path $(if ($env:APPDATA) { $env:APPDATA } else { $ClaudeDir }) 'claude-usage-widget.json'
$TierNames = @{ haiku = 'Haiku 5.5'; sonnet = 'Sonnet 5.5'; opus = 'Opus 5.5'; fable = 'Fable 5.1' }
$Weekdays = @('周日', '周一', '周二', '周三', '周四', '周五', '周六')

function Read-JsonFile([string]$Path) {
  try { return (Get-Content -Raw -Encoding UTF8 -LiteralPath $Path -ErrorAction Stop | ConvertFrom-Json) } catch { return $null }
}

# ISO 时间、秒或毫秒时间戳 → 本地时间
function ConvertTo-LocalTime($Value) {
  if ($null -eq $Value -or $Value -eq '') { return $null }
  # PowerShell 7 的 ConvertFrom-Json 会把 ISO 时间直接变成 DateTime，5.1 则保留字符串
  if ($Value -is [DateTime]) {
    if ($Value.Kind -eq [DateTimeKind]::Utc) { return $Value.ToLocalTime() }
    return $Value
  }
  if ($Value -is [string]) {
    try { return [DateTimeOffset]::Parse($Value, [Globalization.CultureInfo]::InvariantCulture).LocalDateTime } catch { return $null }
  }
  $n = [double]$Value
  if ($n -gt 1e12) { $n = $n / 1000 }
  return [DateTimeOffset]::FromUnixTimeSeconds([long]$n).LocalDateTime
}

function New-Window($Pct, $Resets) {
  if ($null -eq $Pct) { return $null }
  $pct = [double]$Pct
  $resets = ConvertTo-LocalTime $Resets
  # 重置时间过了，这个窗口就从 0 重新算
  if ($resets -and $resets -le (Get-Date)) { $pct = 0 }
  return @{ pct = $pct; resets = $resets }
}

function Get-LiveUsage {
  $cred = Read-JsonFile (Join-Path $ClaudeDir '.credentials.json')
  $o = $null
  if ($cred) { $o = $cred.claudeAiOauth }
  if (-not $o -or -not $o.accessToken) { return @{ ok = $false; why = '没找到 Claude Code 的登录信息：在 PowerShell 里运行一次 claude 登录' } }
  if ($o.expiresAt -and [double]$o.expiresAt -lt [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) {
    return @{ ok = $false; why = '登录令牌已过期：运行一次 claude，它会自动刷新' }
  }
  try {
    $headers = @{ Authorization = "Bearer $($o.accessToken)"; 'anthropic-beta' = 'oauth-2025-04-20' }
    $r = Invoke-RestMethod -Uri 'https://api.anthropic.com/api/oauth/usage' -Headers $headers -TimeoutSec 10 -ErrorAction Stop
  } catch {
    $code = $null
    try { $code = [int]$_.Exception.Response.StatusCode } catch { }
    return @{ ok = $false; code = $code; why = "用量接口暂时读不到（$code）" }
  }
  $five = $null; $seven = $null
  if ($r.five_hour) { $five = New-Window $r.five_hour.utilization $r.five_hour.resets_at }
  if ($r.seven_day) { $seven = New-Window $r.seven_day.utilization $r.seven_day.resets_at }
  if (-not $five -and -not $seven) { return @{ ok = $false; why = '用量接口的返回里没有限额数字' } }
  return @{ ok = $true; five = $five; seven = $seven; at = (Get-Date) }
}

# usage-meter 插件存在本机的数据：最后读到的限额，和上一条消息的模型建议
function Get-PluginStore {
  $dir = Join-Path $ClaudeDir 'plugins\store'
  if (-not (Test-Path -LiteralPath $dir)) { $dir = Join-Path $ClaudeDir 'plugins/store' }
  $file = Get-ChildItem -LiteralPath $dir -Filter 'usage-meter*.json' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $file) { return $null }
  $s = Read-JsonFile $file.FullName
  if (-not $s) { return $null }
  $five = $null; $seven = $null; $at = $null
  if ($s.live -and $s.live.limits) {
    foreach ($l in $s.live.limits) {
      if ($l.kind -eq 'five_hour') { $five = New-Window $l.pct $l.resetsAt }
      if ($l.kind -eq 'seven_day') { $seven = New-Window $l.pct $l.resetsAt }
    }
    $at = ConvertTo-LocalTime $s.live.limitsAt
  }
  return @{ five = $five; seven = $seven; at = $at; advice = $s.advice }
}

function Get-Usage {
  $live = Get-LiveUsage
  $store = Get-PluginStore
  $u = @{ five = $null; seven = $null; at = $null; isLive = $false; why = $live.why; code = $live.code; advice = $null }
  if ($live.ok) {
    $u.five = $live.five; $u.seven = $live.seven; $u.at = $live.at; $u.isLive = $true
  } elseif ($store) {
    $u.five = $store.five; $u.seven = $store.seven; $u.at = $store.at
  }
  # 只显示一小时内的建议，旧的没有参考价值
  if ($store -and $store.advice -and $store.advice.t) {
    $t = ConvertTo-LocalTime $store.advice.t
    if ($t -and ((Get-Date) - $t).TotalMinutes -lt 60) { $u.advice = $store.advice }
  }
  return $u
}

function Format-Reset($Resets) {
  if (-not $Resets) { return '' }
  $left = $Resets - (Get-Date)
  if ($left.TotalSeconds -le 0) { return '已重置' }
  if ($left.TotalHours -lt 24) {
    $h = [int][Math]::Floor($left.TotalHours)
    $m = $left.Minutes
    if ($h -gt 0) { return "$h 小时 $m 分后重置" }
    return "$m 分后重置"
  }
  return '{0} {1:H:mm} 重置' -f $Weekdays[[int]$Resets.DayOfWeek], $Resets
}

function Format-Pct([double]$Pct) {
  if ($Pct -ge 10 -or $Pct -eq 0) { return ('{0:0}%' -f $Pct) }
  return ('{0:0.#}%' -f $Pct)
}

if ($NoWindow) {
  $u = Get-Usage
  $out = [ordered]@{
    source = $(if ($u.isLive) { '实时（用量接口）' } else { '插件最后记录' })
    why = $u.why
    five = $(if ($u.five) { '{0}  {1}' -f (Format-Pct $u.five.pct), (Format-Reset $u.five.resets) } else { $null })
    seven = $(if ($u.seven) { '{0}  {1}' -f (Format-Pct $u.seven.pct), (Format-Reset $u.seven.resets) } else { $null })
    at = $u.at
    advice = $(if ($u.advice) { $TierNames[[string]$u.advice.tier] } else { $null })
  }
  $out | ConvertTo-Json
  return
}

# ------------------------------------------------------------------ 窗口

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

# 只开一个
$isFirst = $false
$mutex = [System.Threading.Mutex]::new($true, 'Local\ClaudeUsageWidget', [ref]$isFirst)
if (-not $isFirst) { return }

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        Topmost="True" ShowInTaskbar="False" ResizeMode="NoResize" SizeToContent="WidthAndHeight"
        WindowStartupLocation="Manual" Left="-10000" Top="-10000"
        FontFamily="Microsoft YaHei UI" FontSize="12" Title="Claude 用量">
  <Border x:Name="Pill" CornerRadius="9" Background="#EB1E1E1E" BorderBrush="#40FFFFFF" BorderThickness="1" Padding="10,4,10,4" Cursor="SizeAll">
    <StackPanel Orientation="Horizontal">
      <Ellipse x:Name="Dot" Width="7" Height="7" Fill="#808080" Margin="0,0,8,0" VerticalAlignment="Center"/>
      <TextBlock Text="5 小时" Foreground="#B4B4B4" VerticalAlignment="Center"/>
      <Grid Width="64" Height="6" Margin="6,0,6,0" VerticalAlignment="Center">
        <Border Background="#40FFFFFF" CornerRadius="3"/>
        <Border x:Name="Bar5" Background="#3987E5" CornerRadius="3" HorizontalAlignment="Left" Width="0"/>
      </Grid>
      <TextBlock x:Name="Pct5" Text="--" Foreground="White" FontWeight="Bold" VerticalAlignment="Center"/>
      <TextBlock x:Name="Reset5" Foreground="#9A9A9A" Margin="6,0,0,0" VerticalAlignment="Center"/>
      <Rectangle Width="1" Fill="#40FFFFFF" Margin="10,2,10,2"/>
      <TextBlock Text="本周" Foreground="#B4B4B4" VerticalAlignment="Center"/>
      <Grid Width="64" Height="6" Margin="6,0,6,0" VerticalAlignment="Center">
        <Border Background="#40FFFFFF" CornerRadius="3"/>
        <Border x:Name="Bar7" Background="#3987E5" CornerRadius="3" HorizontalAlignment="Left" Width="0"/>
      </Grid>
      <TextBlock x:Name="Pct7" Text="--" Foreground="White" FontWeight="Bold" VerticalAlignment="Center"/>
      <TextBlock x:Name="Reset7" Foreground="#9A9A9A" Margin="6,0,0,0" VerticalAlignment="Center"/>
      <StackPanel x:Name="AdviceBox" Orientation="Horizontal" Visibility="Collapsed">
        <Rectangle Width="1" Fill="#40FFFFFF" Margin="10,2,10,2"/>
        <TextBlock Text="上条建议" Foreground="#B4B4B4" VerticalAlignment="Center"/>
        <TextBlock x:Name="Advice" Foreground="#E8896A" FontWeight="Bold" Margin="6,0,0,0" VerticalAlignment="Center"/>
      </StackPanel>
    </StackPanel>
  </Border>
</Window>
'@

$win = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $xaml))
$ui = @{}
foreach ($n in 'Pill', 'Dot', 'Bar5', 'Pct5', 'Reset5', 'Bar7', 'Pct7', 'Reset7', 'AdviceBox', 'Advice') { $ui[$n] = $win.FindName($n) }

$conv = New-Object System.Windows.Media.BrushConverter
function Get-Brush([string]$Hex) { return $conv.ConvertFromString($Hex) }
function Get-BarBrush([double]$Pct) {
  if ($Pct -ge 95) { return (Get-Brush '#E5484D') }
  if ($Pct -ge 80) { return (Get-Brush '#F5A623') }
  return (Get-Brush '#3987E5')
}

$script:data = $null
$script:nextFetch = Get-Date
$script:failures = 0

function Set-Bar($Bar, $PctText, $ResetText, $Window) {
  if ($Window) {
    $Bar.Width = 64 * [Math]::Min(100, [Math]::Max(0, $Window.pct)) / 100
    $Bar.Background = Get-BarBrush $Window.pct
    $PctText.Text = Format-Pct $Window.pct
    $ResetText.Text = Format-Reset $Window.resets
  } else {
    $Bar.Width = 0; $PctText.Text = '--'; $ResetText.Text = ''
  }
}

function Update-View {
  $u = $script:data
  if (-not $u) { return }
  Set-Bar $ui.Bar5 $ui.Pct5 $ui.Reset5 $u.five
  Set-Bar $ui.Bar7 $ui.Pct7 $ui.Reset7 $u.seven
  if ($u.isLive) { $ui.Dot.Fill = Get-Brush '#16C60C' } else { $ui.Dot.Fill = Get-Brush '#808080' }
  if ($u.advice -and $TierNames[[string]$u.advice.tier]) {
    $ui.Advice.Text = $TierNames[[string]$u.advice.tier]
    $ui.AdviceBox.Visibility = 'Visible'
  } else {
    $ui.AdviceBox.Visibility = 'Collapsed'
  }
  $lines = @()
  if ($u.isLive) { $lines += "实时数据（网页、App、Claude Code 的用量都算在内）" }
  else {
    $lines += '用量接口暂时读不到，显示的是 usage-meter 插件最后记下的数字'
    if ($u.why) { $lines += "原因：$($u.why)" }
  }
  if ($u.at) { $lines += ('更新于 {0:H:mm}' -f $u.at) }
  if ($u.five -and $u.five.resets) { $lines += ('5 小时限额 {0:M月d日 H:mm} 重置' -f $u.five.resets) }
  if ($u.seven -and $u.seven.resets) { $lines += ('每周限额 {0:M月d日 H:mm} 重置' -f $u.seven.resets) }
  if ($u.advice) {
    $lines += ''
    $lines += "上一条消息建议用 $($TierNames[[string]$u.advice.tier])"
    if ($u.advice.note) { $lines += [string]$u.advice.note }
  }
  $lines += ''
  $lines += '按住拖动可以移位置 · 右键：刷新 / 开机启动 / 退出'
  $ui.Pill.ToolTip = ($lines -join "`n")
}

function Update-Data {
  $script:data = Get-Usage
  # 接口限流或出错时放慢，正常每 3 分钟读一次
  if ($script:data.isLive) { $script:failures = 0; $wait = 180 }
  else { $script:failures++; $wait = [Math]::Min(900, 180 * $script:failures) }
  $script:nextFetch = (Get-Date).AddSeconds($wait)
  Update-View
}

# 位置：记住上次拖到的地方，第一次放在屏幕顶部正中
function Save-Position {
  try { @{ left = $win.Left; top = $win.Top } | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $StateFile } catch { }
}
$win.Add_ContentRendered({
  $area = [System.Windows.SystemParameters]::WorkArea
  $saved = Read-JsonFile $StateFile
  $vl = [System.Windows.SystemParameters]::VirtualScreenLeft; $vt = [System.Windows.SystemParameters]::VirtualScreenTop
  $vw = [System.Windows.SystemParameters]::VirtualScreenWidth; $vh = [System.Windows.SystemParameters]::VirtualScreenHeight
  if ($saved -and $saved.left -ge $vl -and $saved.left -lt ($vl + $vw - 40) -and $saved.top -ge $vt -and $saved.top -lt ($vt + $vh - 20)) {
    $win.Left = $saved.left; $win.Top = $saved.top
  } else {
    $win.Left = $area.Left + ($area.Width - $win.ActualWidth) / 2
    $win.Top = $area.Top + 4
  }
})
$ui.Pill.Add_MouseLeftButtonDown({ try { $win.DragMove(); Save-Position } catch { } })

# 右键菜单
$startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'Claude 用量小挂件.lnk'
$menu = New-Object System.Windows.Controls.ContextMenu
$miRefresh = New-Object System.Windows.Controls.MenuItem; $miRefresh.Header = '立即刷新'
$miRefresh.Add_Click({ try { Update-Data } catch { } })
$miStart = New-Object System.Windows.Controls.MenuItem; $miStart.Header = '开机自动启动'; $miStart.IsCheckable = $true
$miStart.IsChecked = Test-Path -LiteralPath $startup
$miStart.Add_Click({
  try {
    if ($miStart.IsChecked) {
      $sh = New-Object -ComObject WScript.Shell
      $lnk = $sh.CreateShortcut($startup)
      $lnk.TargetPath = $HostExe
      $lnk.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$SelfPath`""
      $lnk.WindowStyle = 7
      $lnk.Save()
    } else {
      Remove-Item -LiteralPath $startup -ErrorAction SilentlyContinue
    }
  } catch { }
})
$miReset = New-Object System.Windows.Controls.MenuItem; $miReset.Header = '回到屏幕顶部正中'
$miReset.Add_Click({
  $area = [System.Windows.SystemParameters]::WorkArea
  $win.Left = $area.Left + ($area.Width - $win.ActualWidth) / 2; $win.Top = $area.Top + 4
  Save-Position
})
$miExit = New-Object System.Windows.Controls.MenuItem; $miExit.Header = '退出'
$miExit.Add_Click({ $win.Close() })
foreach ($mi in $miRefresh, $miStart, $miReset, $miExit) { [void]$menu.Items.Add($mi) }
$ui.Pill.ContextMenu = $menu

# 每 30 秒刷新倒计时；到点再去读数据
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(30)
$timer.Add_Tick({
  try {
    if ((Get-Date) -ge $script:nextFetch) { Update-Data } else { Update-View }
  } catch { }
})

try { Update-Data } catch { }
$timer.Start()
[void]$win.ShowDialog()
$timer.Stop()
$mutex.ReleaseMutex()
