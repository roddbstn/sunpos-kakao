'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useSessionStore } from '@/lib/store/session'
import OtherStoreLeadButton from '@/components/OtherStoreLeadButton'
import { getSupabaseClient } from '@/lib/supabase/client'
import { formatWon } from '@/lib/utils'
import { track } from '@/lib/firebase'
import { ampTrack } from '@/lib/amplitude'
import type { CartItem } from '@/lib/types'
import LoadingTimer from '@/components/ui/loading-timer'
import { WaitingLabel, StatusBadge, type StatusKind } from '@/components/order/OrderStatusHeader'
import DeliveryMap from '@/components/order/DeliveryMap'

type OrderResultStatus = 'pending' | 'accepted' | 'rejected'

function formatTime(s: number): string {
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${String(sec).padStart(2, '0')}`
}

function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${m}m`
}

export default function SuccessPage() {
  return (
    <Suspense>
      <SuccessPageInner />
    </Suspense>
  )
}

function SuccessPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { account } = useSessionStore()

  const [status,           setStatus]           = useState<OrderResultStatus>('pending')
  const [orderCode,        setOrderCode]         = useState<string | null>(null)
  const [orderNumber,      setOrderNumber]       = useState<string | null>(null)
  const [orderMethod,      setOrderMethod]       = useState<string>('')
  const [orderDeliveryFee, setOrderDeliveryFee]  = useState<number>(0)
  const [orderDistanceM,  setOrderDistanceM]     = useState<number | null>(null)
  const [orderTotal,       setOrderTotal]        = useState<number>(0)
  const [orderOrderer,     setOrderOrderer]      = useState<string>('')
  const [orderPhone,       setOrderPhone]        = useState<string>('')
  const [orderAccount,     setOrderAccount]      = useState<string>('')
  const [orderBalanceBefore, setOrderBalanceBefore] = useState<number | null>(null)
  const [orderBalanceAfter, setOrderBalanceAfter]   = useState<number | null>(null)
  const [rejectedReason,   setRejectedReason]    = useState<string>('')
  const [showReview,       setShowReview]        = useState(false)
  /** 매장 좌표 — 가게 검색을 이 동네부터 보여주려고. 없어도 검색은 된다(전국). */
  const [storeLoc, setStoreLoc] = useState<{ lat: number; lng: number } | null>(null)
  /** 배달 받을 곳 좌표 — 지도용. checkout 이 sessionStorage 에 남긴다 */
  const [destLoc, setDestLoc] = useState<{ lat: number; lng: number } | null>(null)
  /** 자동차 소요시간(초)·도로거리(m) — /api/route-eta */
  const [eta, setEta] = useState<{ durationSec: number; distanceM: number } | null>(null)
  /** 지도 아래 한 줄로 보여줄 배달 주소 */
  const [destAddress, setDestAddress] = useState('')

  // 매장 좌표 한 번만. 실패하면 조용히 넘어간다 — 좌표 없이도 검색은 된다.
  useEffect(() => {
    // 미리보기에는 세션이 없어서 storeId 가 없다 — 매장 좌표를 가짜로 둔다.
    // (샐러리아 침산점 부근) 개발 환경에서만 동작한다.
    if (!account?.storeId && process.env.NODE_ENV === 'development'
        && new URLSearchParams(window.location.search).get('preview')) {
      // ⚠️ 지어낸 좌표를 쓰지 말 것. 처음에 (35.8964, 128.6014) 를 대충 넣었다가
      //    지도가 연암공원 쪽을 가리켜서 "매장 위치가 완전 잘못됐다"는 지적을 받았다.
      //    아래는 stores 테이블의 실제 값이고, 카카오 주소검색으로 교차확인했다
      //    (옥산로17길 14 → 35.8857762 / 128.5860190).
      setStoreLoc({ lat: 35.8857676, lng: 128.5859752 })
      return
    }
    const sid = account?.storeId
    if (!sid) return
    let cancelled = false
    void (async () => {
      const { data } = await getSupabaseClient()
        .from('stores').select('lat, lng').eq('id', sid).maybeSingle()
      if (cancelled || data?.lat == null || data?.lng == null) return
      setStoreLoc({ lat: data.lat, lng: data.lng })
    })()
    return () => { cancelled = true }
  }, [account?.storeId])

  // 타이머
  const [totalSeconds,  setTotalSeconds]  = useState<number | null>(null)
  const [acceptedAt,    setAcceptedAt]    = useState<number | null>(null)
  const [secondsLeft,   setSecondsLeft]   = useState<number | null>(null)
  const [posCompleted,  setPosCompleted]  = useState(false)

  // 주문 아이템
  const [savedItems,   setSavedItems]   = useState<CartItem[]>([])
  const [menuImages,   setMenuImages]   = useState<Record<string, string>>({})

  const [departedAt, setDepartedAt] = useState<string | null>(null)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const channelRef      = useRef<any>(null)
  const setupRealtimeRef = useRef<((code: string) => void) | null>(null)

  // ── 주문 아이템 + 이미지 로드 ──────────────────────────────────────────
  useEffect(() => {
    const raw = sessionStorage.getItem('last_order_items')
    if (!raw) return
    let items: CartItem[]
    try {
      items = JSON.parse(raw)
    } catch {
      // 파싱 실패 시 아이템 표시 생략 (주문 코드로 DB 조회는 계속 진행)
      return
    }
    setSavedItems(items)

    if (items.length === 0) return
    const supabase = getSupabaseClient()
    const ids = items.map(i => i.menuCode)
    supabase
      .from('menus')
      .select('id, image_url')
      .in('id', ids)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then(({ data }: { data: any[] | null }) => {
        if (!data) return
        const map: Record<string, string> = {}
        data.forEach(m => { if (m.image_url) map[m.id] = m.image_url })
        setMenuImages(map)
      })
  }, [])

  // ── 세션 + Realtime ────────────────────────────────────────────────────
  useEffect(() => {
    const sessionCode = sessionStorage.getItem('last_order_code')
    const urlCode     = searchParams.get('code')
    const code        = sessionCode ?? urlCode

    if (!code) { router.replace('/'); return }

    // ── 공통: DB 상태 조회 + Realtime 구독 ──
    function setupRealtimeAndStatus(orderCode: string) {
      const supabase = getSupabaseClient()

      // get_order_statuses: 0021에서 anon GRANT 확정된 RPC (상태 감지용)
      supabase
        .rpc('get_order_statuses', { p_order_codes: [orderCode] })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .then(({ data: rows, error }: { data: any; error: any }) => {
          if (error) { console.error('[setup] get_order_statuses error:', error); return }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const row = Array.isArray(rows) ? rows.find((r: any) => r.order_code === orderCode) ?? null : null
          if (!row) return
          if (row.status === '조리중' || row.status === '완료') {
            setStatus('accepted')
            track('order_accepted', { order_code: orderCode })
            ampTrack('order_accepted', { order_code: orderCode })
            setAcceptedAt(prev => {
              if (prev) return prev
              const now = Date.now()
              sessionStorage.setItem('last_order_accepted_at', String(now))
              return now
            })
            if (row.status === '완료') setPosCompleted(true)
          } else if (row.status === '취소') {
            const cachedReason = sessionStorage.getItem('last_order_rej_reason')
            const reason = cachedReason ?? '점주가 주문을 거부했습니다.'
            setStatus('rejected')
            track('order_rejected', { order_code: orderCode, reason })
            ampTrack('order_rejected', { order_code: orderCode, reason })
            setRejectedReason(reason)
            sessionStorage.setItem('last_order_rejected', '1')
            sessionStorage.setItem('last_order_rej_reason', reason)
          }
          // departed_at은 get_order_status(선택적)로 별도 보강 — 실패해도 무방
          supabase.rpc('get_order_status', { p_order_code: orderCode })
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .then(({ data: det }: { data: any }) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const d = Array.isArray(det) ? det[0] ?? null : null
              if (d?.delivery_departed_at) setDepartedAt(d.delivery_departed_at)
              fillDelivery(d)
              if (row.status === '취소' && d?.note) {
                setRejectedReason(d.note)
                sessionStorage.setItem('last_order_rej_reason', d.note)
              }
            })
        })

      try {
        const channel = supabase
          .channel(`orders:order_code=${orderCode}`)
          .on(
            'postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'orders', filter: `order_code=eq.${orderCode}` },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (payload: any) => {
              const s = payload.new?.status
              if (s === '조리중') {
                const now = Date.now()
                setStatus('accepted')
                setAcceptedAt(prev => { if (prev) return prev; sessionStorage.setItem('last_order_accepted_at', String(now)); return now })

                // 예상시간은 ORDER_ACCEPTED broadcast 로도 오지만, broadcast 는 **그 순간
                // 구독 중이던 화면에만** 닿는다. 화면을 잠깐 닫았거나 네트워크가 끊겼으면
                // 영영 못 받는다. DB 행에는 prep_minutes 가 남으므로 여기서도 읽어 둔다.
                // 안내 시간은 주방 시간과 손님 희망 중 **긴 쪽**(POS 와 같은 규칙).
                const prep = Number(payload.new?.prep_minutes ?? 0)
                const want = Number(payload.new?.requested_pickup_minutes ?? 0)
                const mins = Math.max(prep, want)
                if (mins > 0) {
                  setTotalSeconds(prev => prev || mins * 60)
                  setSecondsLeft(prev => prev || mins * 60)
                  if (!sessionStorage.getItem('last_order_total_seconds')) {
                    sessionStorage.setItem('last_order_total_seconds', String(mins * 60))
                  }
                }
              } else if (s === '완료') {
                setStatus('accepted')
                setAcceptedAt(prev => { if (prev) return prev; const now = Date.now(); sessionStorage.setItem('last_order_accepted_at', String(now)); return now })
                setPosCompleted(true)
              } else if (s === '취소') {
                const reason = payload.new?.note ?? '점주가 주문을 거부했습니다.'
                setStatus('rejected')
                setRejectedReason(reason)
                sessionStorage.setItem('last_order_rejected', '1')
                sessionStorage.setItem('last_order_rej_reason', reason)
              }
            }
          )
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .on('broadcast', { event: 'ORDER_ACCEPTED' }, ({ payload }: { payload: any }) => {
            const now  = Date.now()
            const mins = payload?.estimated_minutes ?? null
            setStatus('accepted')
            setAcceptedAt(prev => { if (prev) return prev; sessionStorage.setItem('last_order_accepted_at', String(now)); return now })
            if (mins && mins > 0) {
              setTotalSeconds(mins * 60)
              setSecondsLeft(mins * 60)
              sessionStorage.setItem('last_order_total_seconds', String(mins * 60))
            }
          })
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .on('broadcast', { event: 'ORDER_REJECTED' }, ({ payload }: { payload: any }) => {
            const reason = payload?.reason ?? '점주가 주문을 거부했습니다.'
            setStatus('rejected')
            setRejectedReason(reason)
            sessionStorage.setItem('last_order_rejected', '1')
            sessionStorage.setItem('last_order_rej_reason', reason)
          })
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .on('broadcast', { event: 'ORDER_COMPLETED' }, ({ payload }: { payload: any }) => {
            setStatus('accepted')
            setPosCompleted(true)
            if (payload?.departed_at) setDepartedAt(payload.departed_at)
          })
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .on('broadcast', { event: 'DELIVERY_DEPARTED' }, ({ payload }: { payload: any }) => {
            if (payload?.departed_at) setDepartedAt(payload.departed_at)
          })
          .subscribe()
        channelRef.current = channel
      } catch (err) {
        console.error('[success] Realtime 연결 오류:', err)
      }
    }

    // 함수 정의 직후 ref 등록 — TEMP 코드일 때도 event listener에서 호출 가능하게
    setupRealtimeRef.current = setupRealtimeAndStatus

    // ── URL param으로 접근 (QR 재스캔 후 '내 주문'에서 진입) ──
    if (!sessionCode && urlCode) {
      setOrderCode(urlCode)
      const supabase = getSupabaseClient()
      supabase
        .from('orders')
        .select('order_number, orderer_name, orderer_phone, method, delivery_fee, delivery_distance_m, total_amount, balance_before, balance_after, accounts ( account_name )')
        .eq('order_code', urlCode)
        .maybeSingle()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .then(({ data }: { data: any }) => {
          if (!data) return
          setOrderNumber(data.order_number ?? urlCode)
          setOrderMethod(data.method ?? '')
          setOrderDeliveryFee(data.delivery_fee ?? 0)
          setOrderDistanceM(data.delivery_distance_m ?? null)
          setOrderTotal(data.total_amount ?? 0)
          setOrderOrderer(data.orderer_name ?? '')
          setOrderPhone(data.orderer_phone ?? '')
          setOrderAccount((data.accounts as any)?.account_name ?? '')
          if (data.balance_before !== null) setOrderBalanceBefore(data.balance_before)
          if (data.balance_after  !== null) setOrderBalanceAfter(data.balance_after)
        })
      setupRealtimeAndStatus(urlCode)
      return () => {
        try { if (channelRef.current) getSupabaseClient().removeChannel(channelRef.current) } catch { /* ignore */ }
      }
    }

    // ── 일반 세션 경로 (sessionStorage에서 읽기) ──
    const num            = sessionStorage.getItem('last_order_number')
    const method         = sessionStorage.getItem('last_order_method') ?? ''
    const deliveryFeeRaw = sessionStorage.getItem('last_order_delivery_fee')
    const deliveryDistanceRaw = sessionStorage.getItem('last_order_delivery_distance_m')
    const total          = Number(sessionStorage.getItem('last_order_total') ?? '0')
    const orderer        = sessionStorage.getItem('last_order_orderer') ?? ''
    const phone          = sessionStorage.getItem('last_order_phone') ?? ''
    const acct           = sessionStorage.getItem('last_order_account') ?? ''
    const dLat = sessionStorage.getItem('last_order_delivery_lat')
    const dLng = sessionStorage.getItem('last_order_delivery_lng')
    if (dLat && dLng) setDestLoc({ lat: Number(dLat), lng: Number(dLng) })
    setDestAddress(sessionStorage.getItem('last_order_delivery_address') ?? '')
    const balanceBeforeRaw = sessionStorage.getItem('last_order_balance_before')
    const balanceAfterRaw  = sessionStorage.getItem('last_order_balance_after')

    setOrderCode(code)
    setOrderNumber(num)
    setOrderMethod(method)
    if (deliveryFeeRaw !== null) setOrderDeliveryFee(Number(deliveryFeeRaw))
    if (deliveryDistanceRaw) setOrderDistanceM(Number(deliveryDistanceRaw))
    setOrderTotal(total)
    setOrderOrderer(orderer)
    setOrderPhone(phone)
    setOrderAccount(acct)
    if (balanceBeforeRaw !== null) setOrderBalanceBefore(Number(balanceBeforeRaw))
    if (balanceAfterRaw  !== null) setOrderBalanceAfter(Number(balanceAfterRaw))

    if (code.startsWith('MOCK-')) {
      setStatus('accepted')
      setAcceptedAt(Date.now())
      setTotalSeconds(10 * 60)
      setSecondsLeft(10 * 60)
      return
    }

    // TEMP 코드 = RPC 아직 진행 중 → Realtime 스킵, 이벤트 대기
    if (code.startsWith('TEMP-')) {
      // 혹시 이미 실패 결과가 기록돼 있으면 바로 표시
      if (sessionStorage.getItem('last_order_failed') === '1') {
        const failReason = sessionStorage.getItem('last_order_fail_reason')
        setStatus('rejected')
        setRejectedReason(failReason ?? '주문 처리에 실패했습니다.')
        return
      }

      // order_rpc_done 이벤트가 마운트 전에 발행됐을 경우를 대비:
      // sessionStorage가 실제 코드로 업데이트될 때까지 100ms마다 폴링
      const ssInterval = setInterval(() => {
        const failedFlag = sessionStorage.getItem('last_order_failed')
        if (failedFlag === '1') {
          clearInterval(ssInterval)
          const reason = sessionStorage.getItem('last_order_fail_reason')
          setStatus('rejected')
          setRejectedReason(reason ?? '주문 처리에 실패했습니다.')
          return
        }
        const realCode = sessionStorage.getItem('last_order_code')
        if (!realCode || realCode.startsWith('TEMP-')) return
        clearInterval(ssInterval)
        const realNum = sessionStorage.getItem('last_order_number')
        setOrderCode(realCode)
        if (realNum) setOrderNumber(realNum)
        // channelRef.current이 없을 때만 Realtime 설정 (중복 방지)
        if (!channelRef.current) {
          setupRealtimeRef.current?.(realCode)
        }
      }, 100)

      return () => clearInterval(ssInterval)
    }

    // 새로고침 복원
    const savedAcceptedAt   = sessionStorage.getItem('last_order_accepted_at')
    const savedTotalSeconds = sessionStorage.getItem('last_order_total_seconds')
    const savedRejected     = sessionStorage.getItem('last_order_rejected')
    const savedRejReason    = sessionStorage.getItem('last_order_rej_reason')

    if (savedRejected === '1') {
      setStatus('rejected')
      setRejectedReason(savedRejReason ?? '점주가 주문을 거부했습니다.')
      return
    }

    if (savedAcceptedAt) {
      const at   = Number(savedAcceptedAt)
      const secs = savedTotalSeconds ? Number(savedTotalSeconds) : null
      setStatus('accepted')
      setAcceptedAt(at)
      if (secs) {
        setTotalSeconds(secs)
        setSecondsLeft(Math.max(0, secs - Math.floor((Date.now() - at) / 1000)))
      }
    }

    setupRealtimeAndStatus(code)

    return () => {
      try {
        if (channelRef.current) getSupabaseClient().removeChannel(channelRef.current)
      } catch { /* ignore */ }
    }
  }, [router, searchParams])

  // ── 상태 폴링 폴백 (Realtime 미수신 대비, 3초마다) ────────────────────
  // sessionStorage를 직접 읽어 TEMP→실제 코드 전환도 여기서 처리
  // → orderCode React state에 의존하지 않으므로 타이밍 경쟁 없음
  useEffect(() => {
    if (status === 'rejected') return
    if (status === 'accepted' && posCompleted) return

    async function poll() {
      // sessionStorage에서 항상 최신 코드 읽기
      const code = sessionStorage.getItem('last_order_code')
      if (!code || code.startsWith('TEMP-') || code.startsWith('MOCK-')) return

      // React state가 아직 TEMP면 실제 코드로 업데이트 + Realtime 설정
      if (!orderCode || orderCode.startsWith('TEMP-')) {
        const num = sessionStorage.getItem('last_order_number')
        setOrderCode(code)
        if (num) setOrderNumber(num)
        if (!channelRef.current) {
          setupRealtimeRef.current?.(code)
        }
      }

      const supabase = getSupabaseClient()
      // get_order_statuses: anon GRANT 확정, 상태 감지 기준
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: statuses, error: statusErr } = await supabase.rpc('get_order_statuses', { p_order_codes: [code] }) as { data: any; error: any }
      if (statusErr) { console.error('[poll] get_order_statuses error:', statusErr); return }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const statusRow = Array.isArray(statuses) ? statuses.find((r: any) => r.order_code === code) ?? null : null
      if (!statusRow) return

      // get_order_status: departed_at / note 보강용 (선택적, 실패해도 무방)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: details } = await supabase.rpc('get_order_status', { p_order_code: code }) as { data: any }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const detail = Array.isArray(details) ? details[0] ?? null : null

      if (detail?.delivery_departed_at) setDepartedAt(detail.delivery_departed_at)
      fillDelivery(detail)
      if (statusRow.status === '완료') {
        setStatus('accepted')
        setAcceptedAt(prev => {
          if (prev) return prev
          const now = Date.now()
          sessionStorage.setItem('last_order_accepted_at', String(now))
          return now
        })
        setPosCompleted(true)
      } else if (statusRow.status === '조리중') {
        setStatus('accepted')
        setAcceptedAt(prev => {
          if (prev) return prev
          const now = Date.now()
          sessionStorage.setItem('last_order_accepted_at', String(now))
          return now
        })
      } else if (statusRow.status === '취소') {
        const reason = detail?.note ?? sessionStorage.getItem('last_order_rej_reason') ?? '점주가 주문을 거부했습니다.'
        setStatus('rejected')
        setRejectedReason(reason)
        sessionStorage.setItem('last_order_rejected', '1')
        sessionStorage.setItem('last_order_rej_reason', reason)
      }
    }

    // 즉시 한 번 실행 후 2초 간격으로 반복
    poll()
    const id = setInterval(poll, 2000)

    // 모바일 브라우저에서 화면이 꺼졌다가 켜질 때 즉시 폴링
    // (iOS Safari는 백그라운드에서 setInterval을 중단하므로 필수)
    const onVisible = () => { if (document.visibilityState === 'visible') poll() }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, posCompleted])

  // ── 타이머 카운트다운 ──────────────────────────────────────────────────
  useEffect(() => {
    if (status !== 'accepted' || totalSeconds === null || acceptedAt === null) return
    const tick = () => {
      const elapsed = Math.floor((Date.now() - acceptedAt) / 1000)
      setSecondsLeft(Math.max(0, totalSeconds - elapsed))
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [status, totalSeconds, acceptedAt])

  // ── 백그라운드 RPC 결과 수신 ─────────────────────────────────────────
  useEffect(() => {
    const onDone = (e: Event) => {
      const { order_code, order_number } = (e as CustomEvent).detail
      setOrderCode(order_code)
      setOrderNumber(order_number)
      // channelRef.current이 없을 때만 Realtime 설정 (sessionStorage 폴링과 중복 방지)
      if (!channelRef.current) {
        setupRealtimeRef.current?.(order_code)
      }
    }
    const onFailed = (e: Event) => {
      const { reason } = (e as CustomEvent).detail
      setStatus('rejected')
      setRejectedReason(reason ?? '주문 처리에 실패했습니다.')
    }
    window.addEventListener('order_rpc_done',   onDone)
    window.addEventListener('order_rpc_failed', onFailed)
    return () => {
      window.removeEventListener('order_rpc_done',   onDone)
      window.removeEventListener('order_rpc_failed', onFailed)
    }
  }, [])

  // ── 5초 후 리뷰 바 표시 ───────────────────────────────────────────────
  useEffect(() => {
    if (status !== 'accepted') return
    const t = setTimeout(() => setShowReview(true), 5000)
    return () => clearTimeout(t)
  }, [status])

  /**
   * 개발 환경 전용 상태 미리보기 — `?preview=cooking` · `?preview=waiting`.
   *
   * 이 화면은 세 상태를 오가는데(확인중 → 준비중 → 준비완료) 그걸 보려면 실제로
   * 주문을 넣고 점주가 POS 에서 접수해 줘야 한다. 디자인을 만질 때마다 그럴 수는
   * 없어서, 전엔 sessionStorage 를 콘솔에 손으로 넣어 보게 했다 — 그건 부탁할 일이
   * 아니다. 주소에 붙이기만 하면 되게 바꾼다.
   *
   * NODE_ENV 로 막아서 **배포본에는 아예 없다.** 번들러가 false 가지를 지운다.
   */
  const preview = process.env.NODE_ENV === 'development' ? searchParams.get('preview') : null
  // 'waiting-delivery' · 'cooking-delivery' — 배달 주문의 확인중/준비중을 본다.
  // 지도가 그 두 상태에서도 떠야 해서 따로 둔다.
  const previewCooking = preview === 'cooking' || preview === 'cooking-delivery'
  /** ?preview=ready-delivery · ready-dinein · ready-takeout */
  const previewReadyMethod =
    preview === 'ready-delivery' ? '배달'
    : preview === 'ready-dinein' ? '내점'
    : preview === 'ready-takeout' ? '포장'
    : null

  /**
   * 미리보기 예시 주문 — **렌더 중에** 깐다. (개발 환경 전용)
   *
   * effect 로 하면 늦다. 아래 데이터 effect 가 먼저 돌면서 주문코드가 없다고
   * 판단해 '/' 로 돌려보내 버린다. 그래서 effect 가 아니라 렌더 경로에서 채운다.
   *
   * ?code= 는 붙이지 않는다 — 코드가 주소에 있으면 DB 조회 경로로 빠지는데,
   * 예시 주문은 DB 에 없어서 전부 빈칸으로 그려진다(주문번호 자리에 UUID 가 찍혔다).
   * sessionStorage 경로로 가야 예시 값이 쓰인다.
   *
   * sessionStorage 는 탭마다 따로라, 상태별로 창을 여러 개 띄워도 각 창이
   * 스스로 채운다.
   */
  if (typeof window !== 'undefined' && preview && !sessionStorage.getItem('last_order_code')) {
    const S = sessionStorage
    S.setItem('last_order_code', '00000000-0000-0000-0000-0000000000aa')
    S.setItem('last_order_number', '042')
    S.setItem('last_order_method', preview.includes('delivery') ? '배달' : (previewReadyMethod ?? '포장'))
    S.setItem('last_order_total', '24100')
    S.setItem('last_order_orderer', '김다현')
    S.setItem('last_order_phone', '010-1234-5678')
    S.setItem('last_order_account', '북구청 공원녹지과')
    // 지도 미리보기 — 샐러리아 침산점 근처와 북구청. 실제 두 지점이라 거리가 현실적이다
    // 실제 주소의 실제 좌표다(대학로 80 → 35.8890974 / 128.6143223, 카카오 주소검색).
    S.setItem('last_order_delivery_lat', '35.8890974')
    S.setItem('last_order_delivery_lng', '128.6143223')
    S.setItem('last_order_delivery_address', '대구 북구 대학로 80 산학협력관 4층')
    S.setItem('last_order_balance_before', '319800')
    S.setItem('last_order_balance_after', '295700')
    S.setItem('last_order_items', JSON.stringify([
      { cartId: '1', menuCode: 'm1', menuName: '연어 포케', qty: 1, basePrice: 12000, subtotal: 12900,
        selectedOptions: [{ groupName: '베이스', optionName: '현미밥', extraPrice: 900 }] },
      { cartId: '2', menuCode: 'm2', menuName: '치킨 샐러드', qty: 1, basePrice: 11200, subtotal: 11200,
        selectedOptions: [] },
    ]))
  }

  /**
   * get_order_status 가 돌려준 배달 정보로 지도를 채운다.
   *
   * 원래는 checkout 이 sessionStorage 에 남긴 값만 썼는데, sessionStorage 는
   * **그 탭에서만** 산다 — 주문 링크를 문자로 받아 다른 기기에서 열거나 브라우저를
   * 닫았다 열면 지도가 아예 안 떴다. 좌표는 orders 에 이미 있었고 가져올 길만
   * 없었다(2026-10-30 에 RPC 에 컬럼을 붙였다).
   *
   * 이미 들어온 값이 있으면 덮지 않는다 — 세션 값이 더 빨리 도착한다.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fillDelivery = useCallback((d: any) => {
    if (!d) return
    if (d.delivery_lat != null && d.delivery_lng != null) {
      setDestLoc(prev => prev ?? { lat: Number(d.delivery_lat), lng: Number(d.delivery_lng) })
    }
    const addr = [d.delivery_road_address, d.delivery_detail_address]
      .filter(Boolean).join(' ').trim()
    if (addr) setDestAddress(prev => prev || addr)
    // 매장 좌표도 **주문에서** 받는다.
    //
    // 전엔 account.storeId 로 stores 를 따로 조회했는데, 그 값은 세션(zustand)에
    // 들어 있고 Account.storeId 는 optional 이다. 세션이 비거나 그 필드가 안 채워진
    // 경로로 들어오면 매장 좌표가 영영 null 이라 **지도 자체가 안 떴다**
    // (배달 주소는 보이는데 지도만 없는 상태 — 실제 주문에서 그랬다).
    // 지도가 세션 상태에 좌우될 이유가 없다. 주문 하나면 다 알 수 있다.
    if (d.store_lat != null && d.store_lng != null) {
      setStoreLoc(prev => prev ?? { lat: Number(d.store_lat), lng: Number(d.store_lng) })
    }
  }, [])

  // ── Accepted ──────────────────────────────────────────────────────────
  const hasTimer = totalSeconds !== null && secondsLeft !== null
  const progress = hasTimer ? Math.min(1, 1 - secondsLeft! / totalSeconds!) : 0
  const timerDone = hasTimer && secondsLeft === 0

  /**
   * 출발한 지 몇 분 지났나 — "N분 전 출발".
   *
   * 분이 바뀌면 글자도 바뀌어야 해서 30초마다 다시 그린다. 1초마다 돌릴 이유는
   * 없다(분 단위라 티도 안 난다). 배달이고 출발했을 때만 돈다.
   */
  const [, forceTick] = useState(0)
  useEffect(() => {
    if (!departedAt) return
    const id = setInterval(() => forceTick(n => n + 1), 30_000)
    return () => clearInterval(id)
  }, [departedAt])

  /**
   * 자동차 소요시간 — 매장과 배달지 좌표가 둘 다 있을 때 한 번만 부른다.
   *
   * 실패해도 화면은 그대로 간다. 지도와 주소는 이미 보이고 있고, 소요시간은
   * "있으면 좋은" 정보다 — 그것 때문에 화면이 비면 손해다.
   */
  useEffect(() => {
    if (!storeLoc || !destLoc) return
    let cancelled = false
    const q = new URLSearchParams({
      oLat: String(storeLoc.lat), oLng: String(storeLoc.lng),
      dLat: String(destLoc.lat),  dLng: String(destLoc.lng),
    })
    fetch(`/api/route-eta?${q}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled && d?.durationSec) setEta(d) })
      .catch(() => { /* 소요시간은 없어도 된다 */ })
    return () => { cancelled = true }
  }, [storeLoc, destLoc])

  // ── 주문 생성 중 ──────────────────────────────────────────────────────
  //
  // 스피너는 **주문 RPC 가 아직 안 끝났을 때만** 띄운다.
  //
  // 전엔 조건이 `status === 'pending'` 이었다. 그런데 status 는 점주가 접수할
  // 때까지 계속 'pending' 이라, 손님은 **기다리는 내내 빈 화면에 스피너만** 봤다.
  // 주문번호도, 주문 내역도, 아무것도 안 보였다.
  //
  // 실제로 "아직 모르는" 구간은 order_code 가 TEMP- 인 동안뿐이다(낙관적 이동 중
  // RPC 가 도는 몇백 ms). 그 뒤로는 보여줄 게 다 있으므로 화면을 그린다 —
  // '주문을 확인하고 있어요' 가 그 자리를 받는다.
  if (status === 'pending' && (!orderCode || orderCode.startsWith('TEMP-'))) {
    return (
      <div className="screen">
        {/* 스피너를 4px 테두리 64px 에서 2px 테두리 40px 로 줄였다. 기다리는 화면에서
            굵은 링이 크게 돌면 "뭔가 오래 걸린다"로 읽힌다 — 조용히 도는 쪽이 짧게 느껴진다. */}
        {/* 글자를 뺐다. 흔들리는 타이머 하나면 "기다리는 중"이 전해지고,
            그 아래 문장은 읽을 틈도 없이 다음 화면으로 넘어간다. */}
        <div className="flex-1 flex items-center justify-center px-8">
          <LoadingTimer size={52} />
        </div>
      </div>
    )
  }

  // ── Rejected ──────────────────────────────────────────────────────────
  if (status === 'rejected') {
    return (
      <div className="screen">
        {/* 😢 를 뺐다. 주문이 취소된 사람에게 우는 얼굴은 놀리는 것처럼 보인다.
            여기서 필요한 건 **왜 취소됐는지** 한 줄이고, 그걸 가장 크게 둔다. */}
        <div className="flex-1 flex flex-col items-center justify-center gap-6 px-8">
          <div className="w-12 h-12 rounded-full bg-[#FFF0F0] flex items-center justify-center">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path d="M7 7l10 10M17 7L7 17" stroke="#C92A2A" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
          </div>

          <div className="text-center space-y-2">
            <p className="text-[18px] font-bold text-[#222222]">주문이 취소됐어요</p>
            <p className="text-[13px] text-[#727272]">선결제 잔액은 그대로 돌아갔어요</p>
          </div>

          <div className="w-full rounded-xl bg-[#F5F5F5] px-4 py-3.5 text-center">
            <p className="text-[12px] text-[#727272] mb-1">취소 사유</p>
            <p className="text-[15px] font-semibold text-[#222222] leading-relaxed">
              {rejectedReason || '매장에서 사유를 남기지 않았어요'}
            </p>
          </div>
        </div>
      </div>
    )
  }

  // 미리보기에서는 '7분 전 출발'이 보이도록 출발 시각을 가짜로 둔다
  const previewDepartedAt = previewReadyMethod === '배달'
    ? new Date(Date.now() - 7 * 60_000).toISOString()
    : null

  const isReady = previewReadyMethod !== null || posCompleted || timerDone
  const method = previewReadyMethod ?? orderMethod
  const isDelivery = method === '배달'

  /**
   * 점주가 접수했는가 = 문구·아이콘이 '준비중'으로 넘어가는 기준.
   *
   * status 가 'accepted' 면 orders.status 가 '조리중'/'완료' 로 바뀐 것이고,
   * 그 UPDATE 에 prep_minutes 가 실려 온다(realtime). 즉 "접수 버튼을 눌렀다"와
   * 같은 순간이다. 타이머(hasTimer)를 기준으로 삼지 않은 이유: 점주가 예상시간을
   * 0으로 두고 접수하면 타이머가 안 생기는데, 그래도 접수는 된 것이다.
   * 그때 '확인하고 있어요'가 계속 떠 있으면 거짓말이 된다.
   */
  const isCooking = !isReady && (previewCooking || status === 'accepted')

  /**
   * 지금 화면이 말해야 하는 것 — 문구와 그림이 한 쌍으로 움직인다.
   *
   * 준비 완료는 **이용방법마다 할 일이 다르다.** 전엔 셋을 뭉뚱그려
   * "메뉴가 준비됐어요"로 적었는데, 배달 손님은 그 말을 보고도 매장으로 갈지
   * 기다릴지 알 수 없다. 받는 방법을 문구가 직접 말해야 한다.
   */
  const statusKind: StatusKind =
    !isReady   ? (isCooking ? 'cooking' : 'waiting')
    : isDelivery      ? 'delivery'
    : method === '내점' ? 'dinein'
    : 'takeout'

  /** 출발한 지 몇 분. departedAt 이 없으면 null */
  const departedShownAt = departedAt ?? previewDepartedAt
  const departedMinsAgo = departedShownAt
    ? Math.max(0, Math.floor((Date.now() - new Date(departedShownAt).getTime()) / 60_000))
    : null

  const statusLabel =
    statusKind === 'waiting'  ? '주문을 확인하고 있어요'
    : statusKind === 'cooking' ? '음식을 준비중이에요'
    : statusKind === 'delivery' ? '배달 라이더가 출발했어요'
    : statusKind === 'dinein'   ? '음식이 다 준비됐어요!'
    : '포장이 다 준비됐어요!'

  return (
    <div className="screen" style={{ paddingBottom: showReview ? '80px' : '0' }}>
      {/* pt-8 → pt-14. 상태 문구가 화면 맨 위에 바짝 붙어 있었다.
          노치·상태바 아래 첫 줄이라 숨 쉴 자리가 필요하다. */}
      <div className="flex-1 overflow-y-auto px-4 pt-14 pb-6 space-y-4">

        {/* ── 상태 머리 ──
            다섯 상태가 **같은 틀**을 쓴다(문구 + 그림). 전엔 준비 완료만 초록
            그라디언트 배너에 주문번호를 또 크게 박아 넣어서, 아래 주문번호 줄과
            같은 숫자가 두 번 나왔다. 틀이 하나면 상태가 바뀌어도 눈이 같은 자리를 본다.

            글자는 **어느 상태든 검정**이다. 준비 완료만 초록으로 해봤는데, 바로 아래
            주문번호가 이미 초록이라 둘이 한 덩어리로 뭉쳐 보였다. 상태는 그림이 말한다.

            머리와 서브텍스트를 한 묶음으로 감싼다 — 바깥 space-y-4(16px)가 둘 사이에
            끼면 서브텍스트가 다음 블록처럼 떨어져 보인다. */}
        <div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-[24px] font-bold text-[#1E1E1E] leading-snug tracking-tight">
              {isReady ? statusLabel : <WaitingLabel label={statusLabel} />}
            </p>
            <StatusBadge kind={statusKind} />
          </div>

          {/* 받는 방법 한 줄 — 준비 완료일 때만. 전엔 초록 배너 안에 있던 정보다.
              13 → 16px, 회색 → 검정. 이 줄이 "그래서 내가 뭘 해야 하나"를 말하는
              유일한 문장이다. 각주 크기에 회색으로 두면 장식처럼 읽혀 그냥 지나친다.
              머리에 바짝 붙인다 — 음수 margin 이다. 머리 글자(24px)의 line-height 가
              만드는 여백까지 걷어내야 두 줄이 한 덩어리로 읽힌다. */}
          {isReady && (
            <p className="-mt-[3px] text-[16px] text-[#1E1E1E] leading-snug">
              {isDelivery
                ? (departedMinsAgo === null ? '조금 전 출발'
                   : departedMinsAgo === 0  ? '방금 출발'
                   : `${departedMinsAgo}분 전 출발`)
                : '매장에서 받아가세요'}
            </p>
          )}
        </div>

        {/* ── 예상 대기시간 ──
            주문번호와 **자리를 바꿨다.** 손님이 이 화면에서 계속 보는 건 "얼마나
            기다리나"이고, 주문번호는 받을 때 한 번 쓴다. 자주 보는 것이 위로 온다.

            접수 전에는 이 자리가 **빈다.** 위의 '주문을 확인하고 있어요…'가 이미
            상태를 말하고 있어서, 여기에 또 안내문을 넣으면 같은 말이 두 번 된다.
            (주문 취소 버튼을 여기 두는 안이 있었는데 걷어냈다 — 선결제 거래처
             손님이라 익명 소비자용 취소 흐름이 필요한 자리가 아니다.) */}
        {isCooking && (hasTimer || previewCooking) && (
          <div className="rounded-2xl px-5 py-4" style={{ background: 'linear-gradient(135deg, #02a84e 0%, #017333 60%, #015a28 100%)' }}>
            <p className="text-[11px] font-semibold text-white/70 mb-1">{isDelivery ? '출발까지 예상 대기시간' : '예상 대기시간'}</p>
            <p className="text-[24px] font-extrabold text-white leading-none mb-3 tabular-nums">
              {formatTime(secondsLeft ?? 13 * 60 + 10)}
            </p>
            <div className="h-2 bg-white/25 rounded-full overflow-hidden">
              <div
                className="h-full bg-white rounded-full transition-all duration-1000 ease-linear"
                style={{ width: `${(hasTimer ? progress : 0.11) * 100}%` }}
              />
            </div>
            <p className="text-[11px] text-white/60 mt-2 text-center">
              준비가 일찍 끝날 수도 있어요
            </p>
          </div>
        )}

        {/* ── 주문번호 ──
            박스 대신 **양옆 가는 선** 사이에 놓는다.
            테두리를 두르면 주변 카드들과 같은 격이 되어 "정보 묶음 하나"로 읽히고,
            아무 장식 없이 두면 본문 한 줄로 흘러가 버린다. 선은 면을 만들지 않으면서
            "여기서 한 번 끊긴다"만 말해준다 — 영수증을 뜯은 자리처럼.

            라벨과 숫자는 색·크기·글꼴이 같다. '주문번호 042' 는 제목+값이 아니라
            한 덩어리로 한 번에 읽히는 말이라서다.

            Pretendard: 시스템 한글 폰트는 기기마다 숫자 폭과 한글 높이가 달라서
            한 줄에 선 '주문번호'와 '042' 의 밑선이 기기마다 다르게 맞는다. */}
        {(orderNumber ?? orderCode) && (
          <div className="flex items-center gap-[16px] py-[6px]">
            {/* 선은 글자보다 훨씬 옅게. 같은 농도면 선이 글자와 경쟁해서
                '표 머리글'처럼 보인다 — 여기선 글자가 주인공이다. */}
            <span className="h-px flex-1 bg-[#EDEDED]" />
            <p className="font-pretendard text-[21px] font-semibold text-[#017333] tracking-[-0.01em] truncate max-w-full">
              {orderOrderer && `${orderOrderer}님 `}주문번호
              <span className="ml-[2px]">{orderNumber ?? orderCode}</span>
            </p>
            <span className="h-px flex-1 bg-[#EDEDED]" />
          </div>
        )}

        {/* ── 배달 지도 ──
            배달 주문에만, '주문을 확인하고 있어요' 때부터 보여준다.
            배달은 "내가 어디로 시켰더라"가 가장 불안한 지점이라, 주소 한 줄보다
            점 두 개가 찍힌 그림이 훨씬 빨리 안심시킨다. 받는 방법이 정해진 뒤가
            아니라 **처음부터** 보여야 하는 이유도 그것이다 — 주소를 잘못 넣었으면
            점주가 접수하기 전에 알아차려야 한다.

            좌표가 둘 다 있을 때만 그린다. 하나라도 없으면 지도가 엉뚱한 곳을
            가리키므로 아예 안 그리는 게 낫다. */}
        {isDelivery && storeLoc && destLoc && (
          <div>
            {/* 소요시간과 출발지는 **지도 안에** 얹는다. 밖에 한 줄로 두면 지도는
                그냥 그림이 되고 글자는 각주가 되는데, 둘은 같은 이야기다.
                지도 위에 있어야 "이 거리를 이만큼 걸려 온다"로 한 번에 읽힌다. */}
            <DeliveryMap store={storeLoc} dest={destLoc} eta={eta} />
          </div>
        )}

        {/* 다른 선결제 가게 제보 — 주문번호 바로 아래.
            아래 '주문 정보'부터는 다시 내 주문 얘기라, 다른 주제는 그 앞에서 닫는다. */}
        <div className="pt-1">
          <OtherStoreLeadButton
            storeLocation={storeLoc}
            fromStoreId={account?.storeId ?? null}
            fromAccountCode={account?.code ?? null}
            onReported={() => { track('store_lead_submitted'); ampTrack('store_lead_submitted') }}
          />
        </div>

        {/* 주문 정보 */}
        <div className="bg-[#F2F2F2] rounded-xl px-4 py-4 space-y-2 text-sm">
          {orderAccount && (
            <div className="flex justify-between">
              <span className="text-[#727272]">거래처</span>
              <span className="font-normal text-[#222222]">{orderAccount}</span>
            </div>
          )}
          {orderOrderer && (
            <div className="flex justify-between">
              <span className="text-[#727272]">주문자</span>
              <span className="font-normal text-[#222222]">{orderOrderer}</span>
            </div>
          )}
          {orderPhone && (
            <div className="flex justify-between">
              <span className="text-[#727272]">연락처</span>
              <span className="font-normal text-[#222222]">{orderPhone}</span>
            </div>
          )}
          {orderMethod && (
            <div className="flex justify-between">
              <span className="text-[#727272]">이용방법</span>
              <span className="font-normal text-[#222222]">
                {orderMethod}{orderMethod === '배달' && orderDeliveryFee > 0 ? (
                  ` (+${formatWon(orderDeliveryFee)}${orderDistanceM != null ? ` · ${formatDistance(orderDistanceM)}` : ''})`
                ) : ''}
              </span>
            </div>
          )}
          {/* 배달 주소는 **여기**가 자리다. 지도 밑에 한 줄로 두면 지도의 캡션처럼
              읽히는데, 이건 주문의 사실 하나라 거래처·주문자·연락처와 같은 묶음에
              있어야 한다. 배달이 아니면 보여줄 게 없다. */}
          {isDelivery && destAddress && (
            <div className="flex justify-between gap-4">
              <span className="text-[#727272] flex-shrink-0">배달 주소</span>
              <span className="font-normal text-[#222222] text-right">{destAddress}</span>
            </div>
          )}
          {orderBalanceBefore !== null && (
            <div className="flex justify-between pt-2 border-t border-[#F2F2F2]">
              <span className="text-[#727272]">기존 선결제 잔액</span>
              <span className="font-normal text-[#222222]">{formatWon(orderBalanceBefore)}</span>
            </div>
          )}
          {orderTotal > 0 && (
            <div className="flex justify-between">
              <span className="text-[#727272] font-semibold">결제 금액</span>
              <span className="font-bold text-[#222222]">{formatWon(orderTotal)}</span>
            </div>
          )}
          {orderBalanceAfter !== null && (
            <div className="flex justify-between pt-3 mt-1 border-t border-[#E8E8E8]">
              <span className="text-[#727272]">주문 후 잔액</span>
              <span className={`font-normal ${orderBalanceAfter < 0 ? 'text-[#C92A2A]' : 'text-[#222222]'}`}>
                {formatWon(orderBalanceAfter)}
              </span>
            </div>
          )}
        </div>

        {/* 잔액 차감 안내 */}
        {account && (
          <div className="flex items-center justify-center gap-1.5 px-4 py-2.5 bg-[#E6F4EC] rounded-xl">
            <span className="text-[#017333] text-sm">✓</span>
            <p className="text-sm text-[#017333] font-semibold">
              선결제 잔액에서 {formatWon(orderTotal)}이 차감되었어요
            </p>
          </div>
        )}

        {/* 주문 메뉴 목록 */}
        {savedItems.length > 0 && (
          <div>
            <p className="text-[15px] font-bold text-[#222222] mb-2">주문 메뉴</p>
            <div className="space-y-3">
              {savedItems.map((item, idx) => {
                const imgUrl = menuImages[item.menuCode]
                return (
                  <div key={idx} className="flex gap-3 items-start">
                    {/* 메뉴 사진 */}
                    <div className="w-[60px] h-[60px] rounded-xl overflow-hidden flex-shrink-0 bg-[#F2F2F2]">
                      {imgUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={imgUrl}
                          alt={item.menuName}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-2xl">
                          🍽️
                        </div>
                      )}
                    </div>

                    {/* 메뉴 정보 */}
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-start gap-2">
                        <p className="text-[14px] font-semibold text-[#222222] leading-snug">
                          {item.menuName}
                          <span className="text-[#727272] font-normal ml-1">×{item.qty}</span>
                        </p>
                        <p className="text-[15px] font-bold text-[#222222] flex-shrink-0">
                          {formatWon(item.subtotal)}
                        </p>
                      </div>
                      {item.selectedOptions.length > 0 && (
                        <p className="text-[11px] text-[#727272] mt-0.5 leading-relaxed">
                          {item.selectedOptions.map(o => o.optionName).join(' · ')}
                        </p>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* 취소 불가 안내 */}
        {/* 테두리 박스 + ℹ️ 를 뺐다. 이 화면에서 가장 조용해야 할 줄인데 테두리가 쳐져 있어
            위의 결제 정보만큼 눈에 들어왔다. 글자만 남긴다. */}
        <p className="px-1 text-[12px] text-[#ADADAD] leading-relaxed text-center">
          주문 접수 후에는 취소 및 환불이 어려워요<br />
          문의는 매장으로 직접 연락해 주세요
        </p>

      </div>

      {/* 네이버 리뷰 — 하단 스티키 플로팅 */}
      {showReview && (
        <div
          className="fixed bottom-0 left-0 right-0 max-w-[430px] mx-auto px-4 py-3 bg-white border-t border-[#F2F2F2]"
          style={{ boxShadow: '0 -4px 20px rgba(0,0,0,0.08)' }}
        >
          <p className="text-[12px] text-[#B0B0B0] text-center mb-2">
            소중한 리뷰 작성이 큰 힘이 돼요!
          </p>
          <a
            href="https://naver.me/5b013Rvl"
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => { track('naver_review_click'); ampTrack('naver_review_click') }}
            className="block w-full py-4 rounded-xl bg-[#03C75A] text-white text-[16px] font-extrabold text-center transition-transform duration-100 active:scale-95 active:brightness-90"
          >
            네이버 리뷰 남기기
          </a>
        </div>
      )}
    </div>
  )
}
