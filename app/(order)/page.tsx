'use client'

import { useEffect, useState, useCallback, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { getSupabaseClient } from '@/lib/supabase/client'
import { getSessionUser, getUserStoreLinks, upsertSunposUser, getSunposProfile } from '@/lib/auth'
import { useSessionStore } from '@/lib/store/session'
import { useCartStore } from '@/lib/store/cart'
import { buildAccount, buildActiveLink } from '@/lib/account-builder'
import LoadingTimer from '@/components/ui/loading-timer'

export default function HomePage() {
  return (
    <Suspense>
      <HomePageInner />
    </Suspense>
  )
}

function HomePageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const storeId = searchParams.get('store') ?? undefined

  const { setKakaoUser, setAccount, setActiveLink, setLoginAt, resetSession } = useSessionStore()
  const clearCart = useCartStore(s => s.clearCart)

  const [storeName,     setStoreName]     = useState('')
  const [storeNotFound, setStoreNotFound] = useState(false)
  const [storeClosed,   setStoreClosed]   = useState(false)

  /** 왜 닫혔는지 — 'break' | 'before_open' | 'closed'. store_closed_reason RPC */
  const [closedReason, setClosedReason] = useState<string>('closed')
  const [reopenAt,     setReopenAt]     = useState<string>('')

  // 닫힌 걸 확인한 다음에만 묻는다 — 열려 있는 동안 매번 한 번 더 조회할 이유가 없다
  const loadClosedReason = useCallback(async (sid: string) => {
    try {
      const { data } = await getSupabaseClient().rpc('store_closed_reason', { p_store_id: sid })
      const row = (data as { reason: string; reopen_at: string | null }[] | null)?.[0]
      if (row) { setClosedReason(row.reason); setReopenAt(row.reopen_at ?? '') }
    } catch { /* 이유를 못 받아도 기본 문구로 보여준다 */ }
  }, [])
  const [storeReady,    setStoreReady]    = useState(false)   // 매장 정보 확인 완료
  const [noStoreId,     setNoStoreId]     = useState(false)   // QR 없이 루트로 직접 접속
  const [awaitingApproval, setAwaitingApproval] = useState(false) // 승인 대기 중
  const [needsInvite,      setNeedsInvite]      = useState(false) // 등록된 거래처 없음

  // ── 떠돌이 ?code= 구조 ────────────────────────────────────────────────
  // 카카오 로그인은 Supabase 를 거친다. redirectTo 로 보낸 주소가 Supabase 의
  // Redirect URLs 허용 목록에 없으면 **그 값이 조용히 무시되고 Site URL(루트)로**
  // 떨어진다 — ?code= 를 달고. 루트에는 코드를 교환할 사람이 없어서 세션이 안 생기고,
  // 화면엔 "매장 QR 코드를 스캔해 주세요"만 떴다. 로그인은 성공했는데 말이다.
  //
  // 허용 목록을 고치는 게 근본이지만, 목록이 어긋나는 날 로그인이 통째로 죽는 건
  // 너무 비싸다. 루트가 코드를 보면 직접 교환하고 돌아갈 곳으로 보낸다.
  useEffect(() => {
    const code = searchParams.get('code')
    if (!code) return
    void (async () => {
      const supabase = getSupabaseClient()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase.auth as any).exchangeCodeForSession(code)
      // 돌아갈 곳: 들고 있던 계정이 있으면 메뉴, 없으면 루트를 깨끗하게
      const back = useSessionStore.getState().account ? '/menu/' : '/'
      router.replace(error ? '/?error=auth_failed' : back)
    })()
  }, [searchParams, router])

  // ── 매장 정보 로딩 ──
  useEffect(() => {
    // 코드 교환 중에는 매장 화면을 그리지 않는다 — 한 박자 뒤 어차피 떠난다
    if (searchParams.get('code')) return
    async function loadStore() {
      // storeId 없음 = 직접 접속 → 로그인 후 매장 선택 플로우로 이어짐
      if (!storeId) {
        setStoreReady(true)
        return
      }
      const supabase = getSupabaseClient()
      const { data } = await supabase
        .from('stores')
        .select('name, is_open')
        .eq('id', storeId)
        .maybeSingle()

      // storeId는 있는데 DB에 없는 경우만 "QR 스캔" 화면
      if (!data) {
        setStoreNotFound(true)
        setStoreReady(true)
        return
      }
      setStoreName(data.name)
      document.title = `${data.name} · 선결제 주문`
      if (data.is_open === false) {
        void loadClosedReason(storeId)
        setStoreClosed(true)
      }
      setStoreReady(true)
    }
    loadStore()
    // deps 에 searchParams 가 꼭 있어야 한다. 위에서 ?code= 를 보고 한 번 건너뛰었는데,
    // 교환이 끝나 router.replace 로 code 가 사라져도 storeId 는 그대로(둘 다 undefined)라
    // 이 effect 가 다시 돌지 않는다 → storeReady 가 영원히 false → 스피너가 안 멈춘다.
  }, [storeId, searchParams])

  // ── 인증 확인 + 라우팅 ──
  useEffect(() => {
    if (!storeReady) return
    if (storeNotFound || storeClosed) return

    async function checkAndRoute() {
      const user = await getSessionUser()

      if (!user) {
        // 카카오 로그인 필요
        resetSession()
        clearCart()
        router.replace(`/auth${storeId ? `?store=${storeId}` : ''}`)
        return
      }

      // 사용자 정보 저장 + DB upsert
      setKakaoUser(user)
      await upsertSunposUser(user)

      // 프로필 미완성(전화번호 미입력) → 프로필 입력 화면
      const profile = await getSunposProfile()
      if (!profile?.phone) {
        router.replace(`/profile-setup${storeId ? `?store=${storeId}` : ''}`)
        return
      }

      if (!storeId) {
        setNoStoreId(true)
        return
      }

      // 이 매장에서의 링크 확인
      try {
        const links = await getUserStoreLinks(storeId)
        const approvedLinks = links.filter(l => l.status === 'approved')
        const pendingLinks  = links.filter(l => l.status === 'pending')

        if (approvedLinks.length > 0) {
          // 승인된 링크 → 메뉴로
          const link = approvedLinks[0]
          setAccount(buildAccount(
            { account_code: link.account_code, account_name: link.account_name, role: link.role, org_name: link.org_name, current_balance: link.current_balance },
            storeId, storeName,
          ))
          setActiveLink(buildActiveLink(link.link_id, { account_code: link.account_code, role: link.role, org_name: link.org_name }, storeId))
          setLoginAt(Date.now())
          router.replace('/menu')
          return
        }

        if (pendingLinks.length > 0) {
          // 승인 대기 중 (통합 등록요청 화면은 별도 구현 예정 — 지금은 대기 안내만)
          setAwaitingApproval(true)
          return
        }

        // 연결된 거래처 없음 — 초대 링크로 들어와야 함 (자기신고 신규등록 흐름은 폐기됨)
        setNeedsInvite(true)
      } catch {
        setNeedsInvite(true)
      }
    }

    checkAndRoute()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeReady, storeNotFound, storeClosed])

  // ── 로그인 실패 ──
  // 여기까지 떨어졌으면 카카오는 통과했는데 코드 교환이 깨진 것이다.
  // 이때 "QR 을 스캔해 주세요"를 띄우면 안 된다 — 방금 QR 을 찍고 온 사람이니까.
  if (searchParams.get('error') === 'auth_failed') {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen px-8 text-center bg-surface">
        <h2 className="text-[18px] font-bold text-[#222222] mb-3">로그인을 끝내지 못했어요</h2>
        <p className="text-[14px] text-[#727272] leading-relaxed">
          잠시 후 다시 시도해 주세요.<br />계속 안 되면 매장에 문의해 주세요.
        </p>
      </div>
    )
  }

  // ── 매장 없음 ──
  if (storeNotFound) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen px-8 text-center bg-surface">
        <div className="text-5xl mb-6">📷</div>
        <h2 className="text-[18px] font-bold text-[#222222] mb-3">매장 QR 코드를 스캔해 주세요</h2>
        <p className="text-[14px] text-[#727272] leading-relaxed">
          매장에 부착된 QR 코드를 스캔하면<br />해당 매장의 선결제 주문 화면으로 이동합니다.
        </p>
      </div>
    )
  }

  // ── QR 없이 직접 접속 ──
  if (noStoreId) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen px-8 text-center bg-surface">
        <div className="text-5xl mb-6">📷</div>
        <h2 className="text-[18px] font-bold text-[#222222] mb-3">매장 QR 코드를 스캔해 주세요</h2>
        <p className="text-[14px] text-[#727272] leading-relaxed">
          매장에 부착된 QR 코드를 스캔하면<br />해당 거래처의 선결제 주문 화면으로 이동합니다.
        </p>
      </div>
    )
  }

  // ── 승인 대기 중 ──
  if (awaitingApproval) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen px-8 text-center bg-surface">
        <div className="text-6xl mb-6 animate-pulse">⏳</div>
        <h2 className="text-[18px] font-bold text-[#222222] mb-3">승인을 기다리고 있어요</h2>
        <p className="text-[14px] text-[#727272] leading-relaxed">
          관리자가 승인하면 알림이 와요.<br />그때 QR을 다시 찍어주세요.
        </p>
      </div>
    )
  }

  // ── 등록된 거래처 없음 (초대링크 필요) ──
  if (needsInvite) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen px-8 text-center bg-surface">
        <div className="text-5xl mb-6">🔒</div>
        <h2 className="text-[18px] font-bold text-[#222222] mb-3">아직 등록된 거래처가 없어요</h2>
        <p className="text-[14px] text-[#727272] leading-relaxed">
          관리자에게 초대 링크를 요청하거나,<br />매장에 문의해 주세요.
        </p>
      </div>
    )
  }

  // ── 운영 종료 ──
  if (storeClosed) {
    // 왜 닫혔는지에 따라 할 말이 다르다. 브레이크는 "조금 뒤에 다시 오면 된다"이고
    // 영업 종료는 "오늘은 끝났다"다 — 같은 문장으로 묶으면 손님이 헛걸음한다.
    const isBreak = closedReason === 'break'
    return (
      <div className="flex flex-col items-center justify-center min-h-screen px-8 text-center bg-surface">
        <div className="w-12 h-12 rounded-full bg-[#F5F5F5] flex items-center justify-center mb-5">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9" stroke="#727272" strokeWidth="1.8" />
            <path d="M12 7.5V12l3 1.8" stroke="#727272" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h2 className="text-[20px] font-bold text-[#222222] mb-3">
          {isBreak ? '지금은 브레이크 타임이에요' : '지금은 주문을 받지 않아요'}
        </h2>
        <p className="text-[14px] text-[#727272] leading-relaxed">
          {isBreak && reopenAt
            ? <>{reopenAt}부터 다시 주문할 수 있어요</>
            : closedReason === 'before_open' && reopenAt
              ? <>{reopenAt}에 문을 열어요</>
              : <>가게 운영시간에 다시 방문해 주세요</>}
        </p>
      </div>
    )
  }

  // ── 로딩 / 라우팅 중 ──
  return (
    <div className="flex items-center justify-center min-h-screen bg-surface">
      <LoadingTimer size={44} />
    </div>
  )
}
