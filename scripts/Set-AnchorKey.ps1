<#
.SYNOPSIS
  시드구문에서 앵커 publisher 개인키를 꺼내 BYEORIN_ANCHOR_KEY 환경변수에 넣는다.

.DESCRIPTION
  릴리스 앵커(scripts/anchor-release.mjs --send)는 publisher 개인키를
  BYEORIN_ANCHOR_KEY 환경변수로 받는다. 이 스크립트가 그 값을 채운다.

  시드구문은 화면에 보이지 않게 입력받아(Read-Host -AsSecureString) node 프로세스의
  stdin 으로만 넘긴다. argv 에도, 파일에도, PowerShell 히스토리에도 남지 않는다.

  파생은 벼린 지갑과 같은 코드(@byeorin/wallet-sdk)를 쓴다. 여기서 나온 주소는
  지갑이 보여주는 주소와 같다.

.PARAMETER Index
  파생 경로의 마지막 숫자. m/44'/60'/<Account>'/0/<Index>
  기본 0 = 지갑의 첫 번째 계정(평소 쓰는 주소).
  안 쓰던 번호(예: 7)를 주면 같은 시드에서 나온 별개 주소가 나온다.

.PARAMETER Account
  파생 경로의 account 필드. 기본 0. 보통 건드릴 일이 없다.

.PARAMETER Wordlist
  auto(기본) | english | korean. auto 는 english 먼저, 실패하면 korean 으로 판정한다.

.PARAMETER Show
  개인키를 화면에도 출력한다. 기본은 환경변수에만 넣고 화면에는 안 찍는다.

.PARAMETER Persist
  현재 창뿐 아니라 사용자 계정에 영구 저장한다(HKCU 레지스트리).
  개인키가 레지스트리에 평문으로 남는다 — 아래 "노출 범위" 참고.

.PARAMETER Clear
  BYEORIN_ANCHOR_KEY 를 현재 창에서 지운다(-Persist 와 함께 쓰면 영구 저장분도 삭제).
  시드구문을 묻지 않는다.

.PARAMETER Rpc
  잔액 조회에 쓸 RPC. 기본 https://rpc.ttl1.top

.PARAMETER NoBalance
  잔액 조회를 건너뛴다(오프라인).

.EXAMPLE
  .\scripts\Set-AnchorKey.ps1 -Index 7
  # 시드 입력 → m/44'/60'/0'/0/7 의 키를 이 창의 BYEORIN_ANCHOR_KEY 에 넣는다

.EXAMPLE
  .\scripts\Set-AnchorKey.ps1 -Clear
  # 이 창에서 키를 지운다

.NOTES
  노출 범위 — 알고 쓰라고 적는다:
   * 환경변수는 이 프로세스와 여기서 띄우는 모든 자식 프로세스가 읽는다.
     같은 사용자 권한으로 도는 다른 프로그램도 이 프로세스의 환경을 읽을 수 있다.
   * -Persist 는 HKCU\Environment 에 **평문**으로 쓴다. 지울 때까지 남고,
     그 사용자로 도는 모든 프로그램이 읽는다. 백업 도구가 같이 퍼갈 수 있다.
   * PowerShell 문자열은 불변이라 메모리에서 확실히 지울 수단이 없다. 창을 닫는 것이
     가장 확실한 정리다.
   * 그래서 이 키에는 가스값만 두는 편이 낫다. 앵커는 append-only 라 키가 새도
     과거 앵커를 지우거나 바꾸지 못하고, 가짜를 하나 더 붙일 수 있을 뿐이다.
#>
[CmdletBinding()]
param(
  [int]$Index = 0,
  [int]$Account = 0,
  [ValidateSet('auto', 'english', 'korean')]
  [string]$Wordlist = 'auto',
  [switch]$Show,
  [switch]$Persist,
  [switch]$Clear,
  [string]$Rpc = 'https://rpc.ttl1.top',
  [switch]$NoBalance
)

$ErrorActionPreference = 'Stop'
$VarName = 'BYEORIN_ANCHOR_KEY'

# 인코딩은 **양방향 다** 맞춰야 한다. 한쪽만 고치면 다른 쪽에서 터진다.
#
#  - $OutputEncoding          : PowerShell → node stdin (나가는 쪽).
#    5.1 기본값이 ASCII 라 한국어 시드가 '?' 로 뭉개진다.
#  - [Console]::OutputEncoding : node stdout → PowerShell (들어오는 쪽).
#    콘솔 코드페이지(예: CP949)로 디코딩하므로 node 의 UTF-8 출력이 깨진다.
#    실제로 이것 때문에 오류 메시지가 "?좏슚???쒕뱶援щЦ" 처럼 읽을 수 없게 나왔다.
#
# 둘 다 세션 전역 상태라 끝나면 원래대로 되돌린다.
$prevOutputEncoding = $OutputEncoding
$prevConsoleOut = [Console]::OutputEncoding
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
}
catch {
  # 콘솔이 없는 호스트(ISE 등)에서는 설정이 막힌다. 치명적이지 않으니 넘어간다.
}

try {
  $RepoRoot = Split-Path -Parent $PSScriptRoot
  $DeriveScript = Join-Path $PSScriptRoot 'derive-publisher-key.mjs'

  # ───────── -Clear: 지우고 끝 ─────────
  if ($Clear) {
    if (Test-Path "Env:\$VarName") { Remove-Item -Path "Env:\$VarName" }
    Write-Host "[anchor] 이 창의 $VarName 을 지웠다." -ForegroundColor Green
    if ($Persist) {
      [Environment]::SetEnvironmentVariable($VarName, $null, 'User')
      Write-Host "[anchor] 사용자 영구 저장분도 지웠다." -ForegroundColor Green
    }
    Write-Host "         (다른 창에 이미 들어간 값은 그 창을 닫아야 사라진다.)" -ForegroundColor DarkGray
    return
  }

  # ───────── 사전 확인 ─────────
  if (-not (Test-Path $DeriveScript)) {
    throw "파생 스크립트를 못 찾았다: $DeriveScript"
  }
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $node) {
    throw 'node 를 찾을 수 없다. Node.js 20.10 이상이 PATH 에 있어야 한다.'
  }
  $SdkDist = Join-Path $RepoRoot 'packages\wallet-sdk\dist\core.js'
  if (-not (Test-Path $SdkDist)) {
    throw "wallet-sdk 빌드 산출물이 없다: $SdkDist`n먼저 실행: pnpm --filter @byeorin/wallet-sdk build"
  }

  Write-Host ''
  Write-Host '[anchor] publisher 키 파생' -ForegroundColor Cyan
  Write-Host "  경로     m/44'/60'/$Account'/0/$Index"
  Write-Host "  wordlist $Wordlist"
  if ($Index -eq 0 -and $Account -eq 0) {
    Write-Host ''
    Write-Host '  주의: index 0 = 지갑의 첫 번째 계정이다. 그 주소에 자산이 있다면' -ForegroundColor Yellow
    Write-Host '        그 자산까지 이 환경변수에 걸리는 셈이다. 앵커 전용으로 쓰려면' -ForegroundColor Yellow
    Write-Host '        -Index 7 처럼 안 쓰던 번호를 주면 별개 주소가 나온다.' -ForegroundColor Yellow
  }
  Write-Host ''
  Write-Host '  시드구문을 입력하라 (화면에 표시되지 않는다):' -ForegroundColor Cyan

  # ───────── 시드 입력 ─────────
  # SecureString 으로 받아 화면 에코를 막고, BSTR 로 잠깐 평문화해 stdin 으로만 흘린다.
  $secure = Read-Host -AsSecureString '  시드구문'
  if ($null -eq $secure -or $secure.Length -eq 0) {
    throw '시드구문이 비어 있다.'
  }

  $bstr = [IntPtr]::Zero
  $plain = $null
  $json = $null
  try {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)

    $nodeArgs = @(
      $DeriveScript,
      '--account', $Account,
      '--index', $Index,
      '--wordlist', $Wordlist,
      '--rpc', $Rpc,
      '--stdin-base64'
    )
    if ($NoBalance) { $nodeArgs += '--no-balance' }

    # 시드를 UTF-8 바이트 → base64 로 감싼다.
    #
    # PowerShell 이 네이티브 stdin 으로 문자열을 보낼 때 쓰는 인코딩은
    # $OutputEncoding 인데, PS 5.1 기본값이 ASCII 라 한국어가 '?' 로 전부
    # 치환된다. 이 스크립트에서 그 변수를 UTF-8 로 바꿔도 파이프에는 반영되지
    # 않았다 — 실제로 그렇게 터졌다.
    #
    # base64 는 순수 ASCII 라 어떤 코드페이지를 거쳐도 바이트가 보존된다.
    # 전역 변수 하나의 상태에 기대는 대신, 훼손될 수 없는 형태로 보낸다.
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($plain))

    # 시드는 여기 파이프로만 넘어간다. argv 에는 비밀이 아닌 값만 들어 있다.
    $json = $b64 | & node $nodeArgs
  }
  finally {
    if ($bstr -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
    $plain = $null
    $secure.Dispose()
    [GC]::Collect()
  }

  if ([string]::IsNullOrWhiteSpace($json)) {
    throw '파생 스크립트가 아무것도 돌려주지 않았다.'
  }

  $result = $json | ConvertFrom-Json
  if (-not $result.ok) {
    throw "파생 실패: $($result.error)"
  }

  # ───────── 환경변수 주입 ─────────
  # .ps1 은 호출한 창과 같은 프로세스에서 돌고 환경변수는 프로세스 단위이므로,
  # 여기서 넣으면 스크립트가 끝난 뒤에도 그 창에서 유효하다.
  Set-Item -Path "Env:\$VarName" -Value $result.privateKey

  Write-Host ''
  Write-Host '  ✔ 파생 완료' -ForegroundColor Green
  Write-Host "  경로     $($result.path)"
  Write-Host "  wordlist $($result.wordlist)"
  Write-Host "  주소     $($result.address)"

  if ($null -ne $result.balanceError) {
    Write-Host "  잔액     조회 실패 — $($result.balanceError)" -ForegroundColor Yellow
  }
  elseif ($null -ne $result.balanceTtl) {
    $bal = [double]$result.balanceTtl
    $cost = [double]$result.anchorCostTtl
    Write-Host "  체인     $($result.chainId)"
    if ($bal -lt $cost) {
      Write-Host ("  잔액     {0} TTL — 부족하다. 앵커 1건에 {1} TTL 든다." -f $bal, $cost) -ForegroundColor Yellow
      Write-Host '           이 주소로 가스를 먼저 보내라.' -ForegroundColor Yellow
    }
    else {
      $times = [math]::Floor($bal / $cost)
      Write-Host ("  잔액     {0} TTL (앵커 약 {1}회분)" -f $bal, $times) -ForegroundColor Green
    }
  }

  Write-Host ''
  if ($Show) {
    Write-Host "  개인키   $($result.privateKey)" -ForegroundColor Magenta
  }
  else {
    Write-Host '  개인키   (화면에 안 찍는다. 보려면 -Show)' -ForegroundColor DarkGray
  }
  Write-Host "  $VarName 을 이 창에 넣었다." -ForegroundColor Green

  if ($Persist) {
    [Environment]::SetEnvironmentVariable($VarName, $result.privateKey, 'User')
    Write-Host ''
    Write-Host '  ⚠ -Persist: 개인키를 HKCU\Environment 에 평문으로 저장했다.' -ForegroundColor Red
    Write-Host '    지울 때까지 남고, 이 사용자로 도는 모든 프로그램이 읽는다.' -ForegroundColor Red
    Write-Host "    지우려면: .\scripts\Set-AnchorKey.ps1 -Clear -Persist" -ForegroundColor Red
  }

  Write-Host ''
  Write-Host '  다음 단계:' -ForegroundColor Cyan
  Write-Host "   1. anchor-publishers.json 의 publishers 에 $($result.address) 를 넣는다 (발행 전에)"
  Write-Host '   2. node scripts/anchor-release.mjs            # 드라이런'
  Write-Host '   3. node scripts/anchor-release.mjs --send     # 실제 발행'
  Write-Host ''
  Write-Host '  끝나면 이 창을 닫아라 — 그게 가장 확실한 정리다.' -ForegroundColor DarkGray
  Write-Host ''

}
finally {
  # 인코딩은 세션 전역이다. 여기서 되돌리지 않으면 이 창의 이후 명령들이
  # 남의 출력을 UTF-8 로 잘못 디코딩하게 된다.
  $OutputEncoding = $prevOutputEncoding
  try { [Console]::OutputEncoding = $prevConsoleOut } catch { }
}
