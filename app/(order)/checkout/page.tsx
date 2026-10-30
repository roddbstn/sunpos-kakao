'use client'

import { useRouter } from 'next/navigation'
import { useState, useEffect } from 'react'
import { useCartStore } from '@/lib/store/cart'
import { useSessionStore } from '@/lib/store/session'
import { formatWon, formatOptionsLabel, DELIVERY_FEE, entrySourceBreakdown } from '@/lib/utils'
import type { OrderMethod, OrderItemPayload } from '@/lib/types'
import { PICKUP_OPTIONS, needsPickupTime, pickupSummary } from '@/lib/pickup-time'
import { getSupabaseClient } from '@/lib/supabase/client'
import { track, setGAUserId } from '@/lib/firebase'
import { ampTrack } from '@/lib/amplitude'
import { personProps } from '@/lib/person-key'
import { getSunposAddresses, upsertSunposAddress, getSunposProfile, type SunposAddress } from '@/lib/auth'
import { searchAddress, pickRoadAddress } from '@/lib/daumPostcode'
import ScreenHeader from '@/components/ui/screen-header'

const DEFAULT_DELIVERY_REMARK = '전화주시면 마중 나갈게요.'
const DELIVERY_REMARK_OPTIONS = [
  '문 앞에 두고 초인종 눌러주세요.',
  '문 앞에 두고 노크해주세요.',
  '초인종, 노크 없이 문 앞에만 놔주세요.',
  '직접 받을게요.',
  '전화주시면 마중 나갈게요.',
  '직접 입력',
]

// 이모지를 뺐다. 세 칸에 서로 다른 그림이 들어가면 눈이 그림을 먼저 보고 글자를 다시 읽는다 —
// 고를 게 셋뿐이라 글자만으로 충분하고, 선택 상태(초록)가 훨씬 또렷해진다.
const METHOD_OPTIONS: { value: OrderMethod; label: string; extra?: string }[] = [
  { value: '포장', label: '포장' },
  { value: '내점', label: '매장 식사' },
  { value: '배달', label: '배달', extra: `+${formatWon(DELIVERY_FEE)}~` },
]

export default function CheckoutPage() {
  const router = useRouter()
  const {
    items,
    method,
    remarks,
    setMethod,
    setRemarks,
    totalSubtotal,
    deliveryFee,
    totalAmount,
    clearCart,
    deliveryDistanceM,
    deliveryLat,
    deliveryLng,
    setDeliveryCalculation,
  } = useCartStore()
  const { account, setAccount, setOrderer, setPhone, orderer: sessionOrderer, phone: sessionPhone } = useSessionStore()

  // 이름·전화번호는 카카오 로그인 + profile-setup에서 이미 확정된 값 — 매 주문마다 다시 입력받지 않는다.
  // 전화번호만 "이번 주문 받을 연락처"로 바꿀 수 있게 편집 가능한 채로 미리 채워둔다.
  const [phoneNumber, setPhoneNumber] = useState('')
  const [baseAddress, setBaseAddress] = useState('')
  const [detailAddress, setDetailAddress] = useState('')
  const [deliveryRemarks, setDeliveryRemarks] = useState(DEFAULT_DELIVERY_REMARK)
  const [showDeliveryModal, setShowDeliveryModal] = useState(false)
  const [draftOption, setDraftOption] = useState(DEFAULT_DELIVERY_REMARK)
  const [draftCustomText, setDraftCustomText] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 기본 체크. 점주 요청 — 매번 같은 사람이 같은 동의를 다시 누르는 게 번거롭다는 피드백.
  // (참고: 개인정보보호법은 사전 동의를 원칙으로 해서, 미리 체크된 동의는 다툼의 소지가 있다.
  //  해제는 여전히 가능하고, 해제하면 주문 버튼이 잠긴다.)
  const [privacyAgreed, setPrivacyAgreed] = useState(true)
  const [deliveryCalculating, setDeliveryCalculating] = useState(false)
  const [deliveryCalcError,  setDeliveryCalcError]  = useState('')
  // 예상 수령시간 — 포장/내점 필수. null = 아직 안 고름
  const [pickupMinutes, setPickupMinutes] = useState<number | null>(null)
  const [savedAddresses, setSavedAddresses]           = useState<SunposAddress[]>([])
  const [savedAddressesLoaded, setSavedAddressesLoaded] = useState(false)
  const [selectedSavedAddressId, setSelectedSavedAddressId] = useState<string | null>(null)
  const [autoSelectedOnce, setAutoSelectedOnce]       = useState(false)
  const [saveAddressChecked, setSaveAddressChecked]   = useState(true)
  // 연락처가 이미 세션에 있으면(카카오 로그인 때 확정된 값) 평문으로 보여주고, "변경" 눌렀을 때만 입력창을 연다.
  const [phoneEditing, setPhoneEditing] = useState(false)

  // 세션(zustand persist)이 sessionStorage에서 복원되기 전엔 sessionPhone이 비어있을 수 있어서,
  // 값이 생기는 시점에 한 번만 채워준다 (사용자가 이미 직접 고친 값은 덮어쓰지 않음).
  useEffect(() => {
    if (sessionPhone && !phoneNumber) setPhoneNumber(formatPhone(sessionPhone))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionPhone])

  // 세션에 연락처가 없으면 저장해둔 프로필에서 가져온다.
  // 메뉴 화면이 넣어주지만, 거기를 안 거치고 바로 들어온 경우(새로고침·딥링크)엔 비어 있다.
  // 설정 화면엔 번호가 멀쩡히 있는데 주문할 때만 빈 칸이면 납득이 안 된다.
  useEffect(() => {
    if (sessionPhone || phoneNumber) return
    let alive = true
    void (async () => {
      const profile = await getSunposProfile().catch(() => null)
      if (!alive || !profile?.phone) return
      setPhoneNumber(formatPhone(profile.phone))
      setPhone(profile.phone)
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionPhone])

  // 도로명주소 설정 즉시(상세주소 입력 전) 거리별 배달팁 계산 — 대기화면 없이 백그라운드로 처리.
  // knownCoords가 있으면(저장된 주소 재사용) 재지오코딩 없이 그 좌표를 그대로 서버에 보낸다.
  async function calculateDelivery(road: string, knownCoords?: { lat: number; lng: number }) {
    if (!account?.storeId) {
      setDeliveryCalcError('매장 정보를 확인할 수 없어요. 처음부터 다시 접속해 주세요.')
      return
    }
    setDeliveryCalculating(true)
    setDeliveryCalcError('')
    try {
      const supabase = getSupabaseClient()
      const body: { store_id: string; road_address?: string; lat?: number; lng?: number } = {
        store_id: account.storeId,
      }
      if (knownCoords) { body.lat = knownCoords.lat; body.lng = knownCoords.lng }
      else body.road_address = road
      const { data, error: fnError } = await supabase.functions.invoke('calculate-delivery-fee', { body })
      if (fnError || !data?.delivery_fee) {
        setDeliveryCalcError(data?.error ?? '배달팁 계산에 실패했어요. 주소를 다시 확인해 주세요.')
        setDeliveryCalculation(null, null)
        return
      }
      setDeliveryCalculation(data.delivery_fee, data.distance_m, data.lat, data.lng)
    } catch {
      setDeliveryCalcError('배달팁 계산에 실패했어요. 주소를 다시 확인해 주세요.')
      setDeliveryCalculation(null, null)
    } finally {
      setDeliveryCalculating(false)
    }
  }

  // 저장된 배달주소 목록 로드 (배달 선택 시) + 첫 진입이면 1번째(가장 오래된) 주소 자동 적용
  useEffect(() => {
    if (method !== '배달' || !account?.storeId) return
    let cancelled = false
    getSunposAddresses().then(list => {
      if (cancelled) return
      setSavedAddresses(list)
      setSavedAddressesLoaded(true)
      if (!autoSelectedOnce && list.length > 0 && !baseAddress) {
        setAutoSelectedOnce(true)
        // list[0] = 설정에서 고른 기본 주소 (getSunposAddresses 가 맨 앞으로 정렬)
        selectSavedAddress(list[0])
      }
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, account?.storeId])

  function selectSavedAddress(addr: SunposAddress) {
    setBaseAddress(addr.roadAddress)
    setDetailAddress(addr.detailAddress ?? '')
    setSelectedSavedAddressId(addr.id)
    setDeliveryCalcError('')
    track('delivery_saved_address_select', { has_coords: addr.lat != null && addr.lng != null })
    ampTrack('delivery_saved_address_select', { has_coords: addr.lat != null && addr.lng != null })
    if (addr.lat != null && addr.lng != null) {
      calculateDelivery(addr.roadAddress, { lat: addr.lat, lng: addr.lng })
    } else {
      calculateDelivery(addr.roadAddress)
    }
  }

  async function openAddressSearch() {
    const data = await searchAddress()
    const road = pickRoadAddress(data)
    setBaseAddress(road)
    setSelectedSavedAddressId(null)
    setDeliveryCalcError('')
    setDeliveryCalculation(null, null)
    track('delivery_address_search', { filled: road.length > 0 })
    ampTrack('delivery_address_search', { filled: road.length > 0 })
    if (road) calculateDelivery(road)
  }

  function formatPhone(raw: string): string {
    const digits = raw.replace(/\D/g, '').slice(0, 11)
    if (digits.length <= 3) return digits
    if (digits.length <= 7) return `${digits.slice(0,3)}-${digits.slice(3)}`
    return `${digits.slice(0,3)}-${digits.slice(3,7)}-${digits.slice(7)}`
  }

  const isPhoneValid = phoneNumber.replace(/\D/g, '').length === 11

  function openDeliveryModal() {
    const isPredefined = DELIVERY_REMARK_OPTIONS.slice(0, -1).includes(deliveryRemarks)
    if (isPredefined) {
      setDraftOption(deliveryRemarks)
      setDraftCustomText('')
    } else {
      setDraftOption('직접 입력')
      setDraftCustomText(deliveryRemarks)
    }
    setShowDeliveryModal(true)
  }

  function closeDeliveryModal() {
    setShowDeliveryModal(false)
  }

  function confirmDeliveryOption() {
    if (draftOption === '직접 입력') {
      setDeliveryRemarks(draftCustomText.trim() || DEFAULT_DELIVERY_REMARK)
    } else {
      setDeliveryRemarks(draftOption)
    }
    setShowDeliveryModal(false)
  }

  function handleTag(label: string) {
    const active = remarks.includes(label)
    function remove(str: string, tag: string) {
      return str.replace(tag, '').replace(/^,\s*|,\s*$|,\s*,/g, '').trim()
    }
    if (active) {
      setRemarks(remove(remarks, label))
    } else {
      // 수저·포크 O / X 는 상호 배타적
      const partner = label === '수저·포크 O' ? '수저·포크 X'
                    : label === '수저·포크 X' ? '수저·포크 O'
                    : null
      const base = partner ? remove(remarks, partner) : remarks
      setRemarks(base ? `${base}, ${label}` : label)
    }
  }

  const currentBalance = account?.balance ?? 0
  const subtotal = totalSubtotal()
  const fee = deliveryFee()
  const total = totalAmount()
  const afterBalance = currentBalance - total
  const isNegative = afterBalance < 0

  // 포장/내점은 수령시간을 골라야 주문 가능. 배달은 주소가 그 역할을 하고 도착시간이 거리에 달려 있다
  const pickupRequired = needsPickupTime(method)
  const pickupMissing  = pickupRequired && pickupMinutes === null

  // 주문 버튼 차단 조건 — disabled 와 className 두 곳에 똑같이 적었던 긴 식을 한 군데로 모았다.
  // 조건이 늘 때마다 두 곳을 같이 고쳐야 했고, 한쪽만 고치면 "눌리는데 아무 일도 안 나는" 버튼이 된다.
  const orderBlocked =
    isSubmitting ||
    !method ||
    !isPhoneValid ||
    !privacyAgreed ||
    (method === '배달' && (!baseAddress.trim() || deliveryCalculating || !!deliveryCalcError)) ||
    pickupMissing

  async function handleOrder() {
    if (!account || !method || items.length === 0) return
    if (!isPhoneValid || !privacyAgreed) return
    if (method === '배달' && (!baseAddress.trim() || deliveryCalculating || deliveryCalcError)) return
    if (pickupMissing) return
    setIsSubmitting(true)
    setError(null)

    // 이름은 카카오 로그인 당시 profile-setup에서 확정된 값 그대로 — 매 주문마다 다시 입력받지 않는다
    // (서버의 create_order_kakao RPC도 sunpos_users.nickname에서 직접 가져오지, 클라이언트 값을 안 믿는다)
    const finalOrderer = sessionOrderer || account.name
    // GA user_id 설정 — 이후 Firebase Analytics에서 사용자별 행동 추적 가능
    setGAUserId(account.code, finalOrderer)
    const finalPhone = phoneNumber
    setOrderer(finalOrderer)
    setPhone(finalPhone)

    // ── 1. RPC 페이로드 미리 구성 ──
    const payload: OrderItemPayload[] = items.map((item) => ({
      menu_id:         item.menuCode,
      menu_name:       item.menuName,
      quantity:        item.qty,
      unit_price:      item.basePrice + item.selectedOptions.reduce((s, o) => s + o.plus, 0),
      option_item_ids: item.selectedOptions.map((o) => o.optionId),
      option_names:    item.selectedOptions.map((o) => o.optionName),
      option_prices:   item.selectedOptions.map((o) => o.plus),
    }))

    const rpcNote = (() => {
      const parts: string[] = []
      if (method === '배달' && baseAddress.trim())    parts.push(`[배달주소] ${baseAddress.trim()}`)
      if (method === '배달' && detailAddress.trim())  parts.push(`[배달상세] ${detailAddress.trim()}`)
      if (method === '배달' && deliveryRemarks.trim()) parts.push(`[배달요청] ${deliveryRemarks.trim()}`)
      if (remarks.trim()) parts.push(remarks.trim())
      return parts.length > 0 ? parts.join(' / ') : null
    })()

    // ── 1.5. 새로 입력한 배달주소 저장 (체크박스 켜져있을 때, 백그라운드 best-effort) ──
    // 이미 배달팁 계산 때 구한 lat/lng를 그대로 써서 재지오코딩하지 않는다.
    // 주소 10개가 꽉 차 있으면(needsConfirmation) 체크아웃 흐름을 막지 않고 그냥 저장을 건너뛴다 —
    // 정리는 profile-setup의 주소 관리 화면에서 하면 된다.
    if (method === '배달' && !selectedSavedAddressId && saveAddressChecked && baseAddress.trim() && deliveryLat != null && deliveryLng != null) {
      upsertSunposAddress({
        roadAddress:   baseAddress.trim(),
        detailAddress: detailAddress.trim(),
        lat:           deliveryLat,
        lng:           deliveryLng,
      }).catch(err => console.error('[checkout] 배달주소 저장 실패:', err))
    }

    // ── 2. 즉시 /success 이동 (낙관적 네비게이션) ──
    const tempCode = `TEMP-${Date.now()}`

    sessionStorage.removeItem('last_order_accepted_at')
    sessionStorage.removeItem('last_order_total_seconds')
    sessionStorage.removeItem('last_order_rejected')
    sessionStorage.removeItem('last_order_rej_reason')
    sessionStorage.removeItem('last_order_failed')
    sessionStorage.removeItem('last_order_fail_reason')

    sessionStorage.setItem('last_order_code',           tempCode)
    sessionStorage.setItem('last_order_number',         '')   // RPC 완료 후 업데이트
    sessionStorage.setItem('last_order_method',         method!)
    sessionStorage.setItem('last_order_pickup_minutes', pickupRequired && pickupMinutes !== null ? String(pickupMinutes) : '')
    sessionStorage.setItem('last_order_delivery_fee',   String(fee))
    sessionStorage.setItem('last_order_delivery_distance_m', deliveryDistanceM != null ? String(deliveryDistanceM) : '')
    // 배달지 좌표 — 주문 완료 화면의 지도가 쓴다.
    // orders 에도 들어가지만(p_delivery_lat/lng) get_order_status 가 돌려주지 않아서,
    // 화면이 바로 쓸 수 있게 여기서도 남긴다.
    sessionStorage.setItem('last_order_delivery_lat', deliveryLat != null ? String(deliveryLat) : '')
    sessionStorage.setItem('last_order_delivery_lng', deliveryLng != null ? String(deliveryLng) : '')
    sessionStorage.setItem('last_order_delivery_address',
      [baseAddress.trim(), detailAddress.trim()].filter(Boolean).join(' '))
    sessionStorage.setItem('last_order_total',          String(total))
    sessionStorage.setItem('last_order_orderer',        finalOrderer)
    sessionStorage.setItem('last_order_phone',          finalPhone)
    sessionStorage.setItem('last_order_account',        account!.name)
    sessionStorage.setItem('last_order_items',          JSON.stringify(items))
    sessionStorage.setItem('last_order_balance_before', String(currentBalance))
    sessionStorage.setItem('last_order_balance_after',  String(afterBalance))

    setAccount({ ...account!, balance: afterBalance })
    clearCart()
    router.push('/success')  // 즉시 이동 — 아래 RPC는 백그라운드 실행

    // ── 3. 데모 모드: demo_orders 테이블에 INSERT 후 성공 이벤트 ──
    if (account.isDemo) {
      const supabase = getSupabaseClient()
      const demoItems = items.map(item => ({
        name: item.menuName,
        qty: item.qty,
        options: item.selectedOptions.map((o: { optionName: string }) => o.optionName).filter(Boolean).join(', '),
        price: item.subtotal,
      }))

      const { data: demoOrder } = await supabase
        .from('demo_orders')
        .insert({
          account_name: account.name,
          orderer: finalOrderer || '익명',
          method: method || '포장',
          items: demoItems,
          subtotal: subtotal,
          delivery_fee: fee,
          total: total,
        })
        .select('id')
        .single()

      const demoCode = demoOrder?.id ?? `DEMO-${Date.now()}`
      sessionStorage.setItem('last_order_code',   demoCode)
      sessionStorage.setItem('last_order_number', 'D001')
      window.dispatchEvent(new CustomEvent('order_rpc_done', {
        detail: { order_code: demoCode, order_number: 'D001' },
      }))
      return
    }

    // ── 4. 백그라운드 RPC (keepalive fetch — navigation 후에도 요청 유지) ──
    try {
      const SUPABASE_URL      = process.env.NEXT_PUBLIC_SUPABASE_URL!
      const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

      // create_order_kakao는 auth.uid()로 주문자를 검증하므로 anon key가 아니라
      // 로그인 세션의 access_token을 실어 보내야 함 (주문자명도 이 토큰으로 서버가 직접 조회)
      const { data: { session } } = await getSupabaseClient().auth.getSession()
      const accessToken = session?.access_token ?? SUPABASE_ANON_KEY

      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/create_order_kakao`, {
        method:    'POST',
        keepalive: true,          // navigation 중에도 요청 살아있음
        headers: {
          'Content-Type':  'application/json',
          'apikey':        SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${accessToken}`,
          'Prefer':        'return=representation',
        },
        body: JSON.stringify({
          p_account_code:  account.code,
          p_orderer_phone: finalPhone,
          p_method:        method,
          p_items:         payload,
          p_delivery_fee:  fee,
          p_note:          rpcNote,
          // 배달은 null — 도착시간이 거리에 달려 있어 고객이 고를 값이 아니다
          p_requested_pickup_minutes: pickupRequired ? pickupMinutes : null,
          ...(method === '배달' ? {
            p_delivery_road_address:   baseAddress.trim() || null,
            p_delivery_detail_address: detailAddress.trim() || null,
            p_delivery_lat:            deliveryLat,
            p_delivery_lng:            deliveryLng,
            p_delivery_distance_m:     deliveryDistanceM,
          } : {}),
        }),
      })

      const data = await res.json().catch(() => null)
      const rpcError = res.ok ? null : data

      if (!res.ok || !data) {
        console.error('[checkout] RPC error:', rpcError)
        const rawMessage = typeof data?.message === 'string' ? data.message : null
        const reason = rawMessage === 'STORE_CLOSED'
          ? '가게 운영이 종료되어 주문할 수 없습니다.'
          : rawMessage?.startsWith('배달팁 금액이 일치하지 않습니다')
          ? '배달팁 정보가 변경됐어요. 배달 주소를 다시 검색한 후 주문해 주세요.'
          : rawMessage ?? '주문 처리에 실패했습니다.'
        sessionStorage.setItem('last_order_failed',      '1')
        sessionStorage.setItem('last_order_fail_reason', reason)
        window.dispatchEvent(new CustomEvent('order_rpc_failed', { detail: { reason } }))
        track('order_fail', { error: reason })
        ampTrack('order_fail', { error: reason })
        return
      }

      // Supabase REST RPC는 배열 또는 단일 객체로 반환
      const result = (Array.isArray(data) ? data[0] : data) as { order_code: string; order_number: string }

      // sessionStorage 실제 코드로 업데이트
      sessionStorage.setItem('last_order_code',   result.order_code)
      sessionStorage.setItem('last_order_number', result.order_number)

      // localStorage 주문 이력 저장
      try {
        const prev = JSON.parse(localStorage.getItem('sallaria_order_history') ?? '[]')
        const entry = {
          order_code:   result.order_code,
          order_number: result.order_number,
          account_name: account!.name,
          orderer_name: finalOrderer,
          ordered_at:   new Date().toISOString(),
          total_amount: total,
          method:       method!,
        }
        localStorage.setItem('sallaria_order_history', JSON.stringify([entry, ...prev].slice(0, 20)))
      } catch { /* ignore */ }

      // success 페이지에 결과 전달
      window.dispatchEvent(new CustomEvent('order_rpc_done', {
        detail: { order_code: result.order_code, order_number: result.order_number },
      }))

      // 유입 경로 구성비를 함께 보낸다 — 장바구니엔 경로가 섞이므로 건수·금액 구성비로 싣는다
      const breakdown = entrySourceBreakdown(items)
      track('purchase', {
        transaction_id: result.order_code,
        value:          total,
        currency:       'KRW',
        items:          items.map(i => ({ item_name: i.menuName, quantity: i.qty, price: i.basePrice })),
        method,
        ...breakdown,
      })
      ampTrack('purchase', { order_code: result.order_code, total, method, ...breakdown })
    } catch (err) {
      console.error('[checkout] unexpected error:', err)
      const reason = '주문 처리에 실패했습니다.'
      sessionStorage.setItem('last_order_failed',      '1')
      sessionStorage.setItem('last_order_fail_reason', reason)
      window.dispatchEvent(new CustomEvent('order_rpc_failed', { detail: { reason } }))
    }
  }

  if (items.length === 0) {
    return (
      <div className="screen">
        <div className="flex-1 flex items-center justify-center text-[#727272]">
          <p className="text-sm">장바구니가 비어있습니다.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="screen">
      <ScreenHeader title="주문 확인" onBack={() => router.back()} />

      {/* 데모 모드 배너 */}
      {account?.isDemo && (
        <div className="bg-[#222222] text-white text-center text-[12px] font-semibold py-2 px-4 flex-shrink-0">
          🎮 데모 모드 — 실제 주문은 접수되지 않습니다
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 pt-5 pb-6 space-y-7">
        {/* 거래처 + 주문자 (이름은 카카오 로그인 때 확정된 값 사용, 다시 안 물어봄) */}
        <section className="space-y-3">
          <p className="text-base font-bold text-[#222222]">{account?.name}</p>
          {/* 주문자와 연락처는 한 줄이다. 둘로 쪼개 라벨을 달면 '입력해야 할 칸' 두 개로
              보이는데, 실제로는 이미 정해진 값을 확인만 하는 자리다. */}
          <div>
            {!phoneEditing && isPhoneValid ? (
              <div className="flex items-center justify-between gap-3">
                <p className="text-[13px] text-[#222222] min-w-0 truncate">
                  {sessionOrderer || account?.name} · {phoneNumber}
                </p>
                <button
                  type="button"
                  onClick={() => setPhoneEditing(true)}
                  className="flex-shrink-0 h-[28px] px-3 rounded-lg bg-[#F5F5F5] text-[#222222] text-[12px] font-semibold"
                >
                  변경
                </button>
              </div>
            ) : (
              <>
                {/* 아직 번호가 없을 때만 라벨을 보여준다 — 필수라는 걸 알려야 하니까 */}
                <label className="block text-[12px] font-semibold text-[#727272] mb-1.5">
                  연락처 <span className="text-[#C92A2A]">*</span>
                </label>
                <input
                  type="tel"
                  value={phoneNumber}
                  onChange={e => setPhoneNumber(formatPhone(e.target.value))}
                  onBlur={e => {
                    const valid = e.target.value.replace(/\D/g, '').length === 11
                    track('phone_input', { valid }); ampTrack('phone_input', { valid })
                    if (valid) setPhoneEditing(false)
                  }}
                  placeholder="010-0000-0000"
                  inputMode="numeric"
                  autoFocus={phoneEditing}
                  className="w-full border border-[#D7D7D7] rounded-xl px-4 py-3 text-sm text-[#222222] placeholder:text-[#D7D7D7] outline-none focus:border-[#222222] transition-colors"
                />
              </>
            )}
          </div>
        </section>

        {/* 이용방법 선택 */}
        <section>
          <h2 className="text-[13px] font-semibold text-[#727272] mb-2">이용방법 <span className="text-[#C92A2A]">*</span></h2>
          <div className="flex gap-2">
            {METHOD_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => { track('method_select', { method: opt.value }); ampTrack('method_select', { method: opt.value }); setMethod(opt.value) }}
                className={`flex-1 h-[56px] rounded-xl text-[14px] font-medium transition-colors flex flex-col items-center justify-center gap-0.5 ${
                  method === opt.value
                    ? 'bg-[#E6F4EC] text-[#017333]'
                    : 'bg-[#F5F5F5] text-[#222222]'
                }`}
              >
                <span>{opt.label}</span>
                {opt.extra && (
                  <span className="text-[12px] text-[#727272]">{opt.extra}</span>
                )}
              </button>
            ))}
          </div>
        </section>

        {/* 예상 수령시간 (포장/내점 선택 시에만 — 배달은 아래 주소 입력이 이 자리를 쓴다) */}
        {pickupRequired && (
          <section>
            <h2 className="text-[13px] font-semibold text-[#727272] mb-3">
              예상 수령시간 <span className="text-[#C92A2A]">*</span>
            </h2>
            <div className="grid grid-cols-4 gap-2">
              {PICKUP_OPTIONS.map((opt) => {
                const active = pickupMinutes === opt.minutes
                return (
                  <button
                    key={opt.minutes}
                    type="button"
                    disabled={opt.disabled}
                    onClick={() => {
                      // 몇 분을 고르는지 — 주방 소요시간을 실제 수요에 맞추는 근거가 된다
                      const pt = { minutes: opt.minutes, ...personProps(sessionOrderer) }
                      track('pickup_time_select', pt)
                      ampTrack('pickup_time_select', pt)
                      setPickupMinutes(opt.minutes)
                    }}
                    className={`py-2.5 rounded-xl text-[13px] font-light transition-colors ${
                      opt.disabled
                        ? 'bg-[#FAFAFA] text-[#D7D7D7] cursor-not-allowed'
                        : active
                        ? 'bg-[#E6F4EC] text-[#017333]'
                        : 'bg-[#F2F2F2] text-[#414141] active:scale-95'
                    }`}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
            {/* 선택 결과 — 맨 초록 글자 대신 카드로 묶어 "확정된 값"처럼 보이게.
                칩('+10분')을 되읊지 않고 받을 시각을 머리말로 올린다 */}
            {pickupMinutes !== null && (() => {
              const { headline } = pickupSummary(pickupMinutes)
              return (
                <div className="mt-3 flex items-center gap-2.5 rounded-xl bg-[#E6F4EC] px-3.5 py-3">
                  <svg width="18" height="18" viewBox="0 0 20 20" fill="none" className="flex-shrink-0">
                    <circle cx="10" cy="10" r="7.6" stroke="#017333" strokeWidth="1.5" />
                    <path d="M10 6.2V10L12.4 11.6" stroke="#017333" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <div className="min-w-0">
                    <p className="text-[13px] font-bold text-[#017333] leading-tight">{headline}</p>
                  </div>
                </div>
              )
            })()}
            <p className="mt-2.5 text-[11px] text-[#ADADAD] leading-relaxed">
              1시간 이상 걸리신다면 아래 가게 요청사항에 적어주세요
            </p>
          </section>
        )}

        {/* 배달 주소 + 배달 요청사항 (배달 선택 시에만) */}
        {method === '배달' && (
          <section className="space-y-3">
            <div>
              <label className="text-[13px] font-semibold text-[#727272] mb-2 block">
                배달 주소 <span className="text-[#C92A2A]">*</span>
              </label>
              {/* 저장된 주소 선택 — 여러 개면 고를 수 있게, 1개면 자동 적용됨을 보여줌 */}
              {savedAddressesLoaded && savedAddresses.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {savedAddresses.map(addr => (
                    <button
                      key={addr.id}
                      type="button"
                      onClick={() => selectSavedAddress(addr)}
                      className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors max-w-[180px] truncate ${
                        selectedSavedAddressId === addr.id
                          ? 'bg-[#222222] text-white border-[#222222]'
                          : 'bg-[#F2F2F2] text-[#727272] border-transparent'
                      }`}
                    >
                      {addr.roadAddress}
                    </button>
                  ))}
                </div>
              )}
              {/* 도로명 주소 검색 */}
              <div className="flex gap-2 mb-2">
                <div className="flex-1 border border-[#D7D7D7] rounded-xl px-4 py-3 text-sm bg-[#F2F2F2] text-[#222222] min-h-[48px] flex items-center">
                  {baseAddress ? (
                    <span>{baseAddress}</span>
                  ) : (
                    <span className="text-[#D7D7D7]">도로명 주소</span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={openAddressSearch}
                  className="flex-shrink-0 px-4 py-3 bg-[#222222] text-white text-sm font-semibold rounded-xl active:scale-95 transition-transform"
                >
                  주소 검색
                </button>
              </div>
              {/* 상세주소 입력 */}
              <input
                type="text"
                value={detailAddress}
                onChange={e => setDetailAddress(e.target.value)}
                placeholder="예: 2층, 101호"
                maxLength={60}
                className="w-full border border-[#D7D7D7] rounded-xl px-4 py-3 text-sm text-[#222222] placeholder:text-[#D7D7D7] outline-none focus:border-[#222222] transition-colors"
              />
              {/* 거리별 배달팁 계산 상태 */}
              {deliveryCalculating && (
                <p className="mt-1.5 text-xs text-[#727272]">배달팁 계산 중...</p>
              )}
              {!deliveryCalculating && deliveryCalcError && (
                <p className="mt-1.5 text-xs text-[#C92A2A]">{deliveryCalcError}</p>
              )}
              {!deliveryCalculating && !deliveryCalcError && baseAddress && deliveryDistanceM != null && (
                <p className="mt-1.5 text-xs text-[#727272]">
                  매장에서 약 {deliveryDistanceM >= 1000 ? `${(deliveryDistanceM / 1000).toFixed(1)}km` : `${deliveryDistanceM}m`} · 배달팁 {formatWon(fee)}
                </p>
              )}
              {/* 새로 입력한 주소일 때만 — 이미 저장된 주소를 고른 경우엔 또 저장할 필요 없음 */}
              {!selectedSavedAddressId && baseAddress && (
                <label className="flex items-center gap-2 mt-2 cursor-pointer">
                  <div
                    onClick={() => setSaveAddressChecked(v => !v)}
                    className={`w-4 h-4 rounded flex items-center justify-center flex-shrink-0 border-2 transition-colors ${
                      saveAddressChecked ? 'bg-[#222222] border-[#222222]' : 'border-[#D7D7D7]'
                    }`}
                  >
                    {saveAddressChecked && <span className="text-white text-[9px] font-bold leading-none">✓</span>}
                  </div>
                  <span className="text-xs text-[#727272]">이 주소 저장해두고 다음에도 쓸게요</span>
                </label>
              )}
            </div>
            <div>
              <label className="text-[13px] font-semibold text-[#727272] mb-2 block">배달 요청사항</label>
              <button
                type="button"
                onClick={openDeliveryModal}
                className="w-full border border-[#D7D7D7] rounded-xl px-4 py-3 text-sm text-[#222222] flex items-center justify-between text-left"
              >
                <span className="flex-1 truncate">{deliveryRemarks}</span>
                <svg className="flex-shrink-0 ml-2 w-4 h-4 text-[#727272]" viewBox="0 0 16 16" fill="none">
                  <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            </div>
          </section>
        )}

        {/* 가게 요청사항 */}
        <section>
          <h2 className="text-[13px] font-semibold text-[#727272] mb-2">가게 요청사항</h2>
          {/* 퀵 선택 버튼 */}
          <div className="flex flex-wrap gap-2 mb-3.5">
            {['수저·포크 O', '수저·포크 X', '소스 따로', '덜 맵게'].map((label) => {
              const active = remarks.includes(label)
              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => { track('quick_tag_click', { tag: label, active: !remarks.includes(label) }); ampTrack('quick_tag_click', { tag: label, active: !remarks.includes(label) }); handleTag(label) }}
                  className={`px-3 py-1.5 rounded-full text-[13px] font-light transition-colors ${
                    active
                      ? 'bg-[#E6F4EC] text-[#017333]'
                      : 'bg-[#F2F2F2] text-[#414141]'
                  }`}
                >
                  {label}
                </button>
              )
            })}
          </div>
          <input
            type="text"
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
            onBlur={e => { if (e.target.value.trim()) { track('remarks_input', { filled: true }); ampTrack('remarks_input', { filled: true }) } }}
            placeholder="직접 입력"
            className="w-full px-4 py-3 rounded-xl border border-[#D7D7D7] text-sm text-[#222222] placeholder:text-[#D7D7D7] focus:outline-none focus:border-[#222222] transition-colors"
          />
        </section>

        {/* 주문 내역 — 메뉴 줄과 금액 줄을 한 박스에.
            제목('주문 메뉴'·'결제 내역')은 뺐다. 메뉴명과 금액이 나란히 있으면 무슨
            목록인지 따로 말해줄 필요가 없고, 제목이 있으면 아래 금액 줄과 층이 갈려 보인다.
            '메뉴 소계'도 뺐다 — 배달료가 없으면 총 금액과 늘 같은 숫자다. */}
        <section className="bg-[#FAFAFA] rounded-xl p-4">
          <div className="space-y-2.5 text-sm">
            {items.map((item) => {
              const optionLabel = formatOptionsLabel(item.selectedOptions)
              return (
                <div key={item.cartId} className="flex justify-between">
                  <div className="flex-1 min-w-0 pr-4">
                    <p className="font-medium text-[#1E1E1E]">
                      {item.menuName} × {item.qty}
                    </p>
                    {optionLabel && (
                      <p className="text-xs text-[#727272] mt-0.5 truncate">{optionLabel}</p>
                    )}
                  </div>
                  <p className="font-semibold text-[#1E1E1E] flex-shrink-0">
                    {formatWon(item.subtotal)}
                  </p>
                </div>
              )
            })}

            {/* 배달료는 붙을 때만 — '배달료 0원'은 아무것도 안 알려주면서 한 줄을 먹는다 */}
            {method === '배달' && fee > 0 && (
              <div className="flex justify-between">
                <p className="font-medium text-[#1E1E1E]">배달료</p>
                <p className="font-semibold text-[#1E1E1E] flex-shrink-0">{formatWon(fee)}</p>
              </div>
            )}
          </div>

          <div className="mt-3 pt-3 border-t border-[#D7D7D7] text-sm">
            <div className="flex justify-between font-bold text-[#1E1E1E]">
              <span>총 금액</span>
              <span className="font-extrabold">{formatWon(total)}</span>
            </div>
          </div>

          {/* 잔액 정보 */}
          <div className="mt-4 pt-4 border-t border-[#D7D7D7] space-y-1.5 text-sm">
            <div className="flex justify-between text-[#727272]">
              <span>선결제 잔액</span>
              <span>{formatWon(currentBalance)}</span>
            </div>
            <div className="flex justify-between">
              <span className="font-medium text-[#727272]">주문 후 잔액</span>
              <span className={`font-semibold ${isNegative ? 'text-[#C92A2A]' : 'text-[#1E1E1E]'}`}>
                {formatWon(afterBalance)}
              </span>
            </div>
          </div>

          {/* 잔액 부족 경고 */}
          {isNegative && (
            <div className="mt-3 px-3 py-2 bg-red-50 rounded-lg">
              <p className="text-xs text-[#C92A2A] font-semibold">
                ⚠️ 잔액이 부족합니다. 다음 충전 시 정산됩니다.
              </p>
            </div>
          )}
        </section>

        {/* 오류 메시지 */}
        {error && (
          <div className="px-4 py-3 bg-red-50 rounded-xl">
            <p className="text-sm text-[#C92A2A] font-semibold">{error}</p>
          </div>
        )}
      </div>

      {/* 배달 요청사항 바텀 시트 — 아래에서 밀려 올라온다 */}
      {showDeliveryModal && (
        <>
          <div className="fixed inset-0 bg-black/45 z-40 backdrop-in" onClick={closeDeliveryModal} />
          <div className="fixed bottom-0 left-0 right-0 max-w-[430px] mx-auto bg-white rounded-t-[24px] z-50 sheet-in">
            {/* 모달 헤더 */}
            <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-[#F2F2F2]">
              <h3 className="text-[16px] font-bold text-[#222222]">배달 요청사항</h3>
              <button
                onClick={closeDeliveryModal}
                className="w-8 h-8 flex items-center justify-center text-[#727272] text-lg leading-none"
              >
                ✕
              </button>
            </div>

            {/* 라디오 옵션 */}
            <div className="px-5 pt-1 pb-2">
              {DELIVERY_REMARK_OPTIONS.map((option) => (
                <label
                  key={option}
                  className="flex items-center gap-3 py-3.5 border-b border-[#F2F2F2] last:border-0 cursor-pointer"
                  onClick={() => setDraftOption(option)}
                >
                  <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                    draftOption === option ? 'border-[#222222]' : 'border-[#D7D7D7]'
                  }`}>
                    {draftOption === option && (
                      <div className="w-2.5 h-2.5 rounded-full bg-[#222222]" />
                    )}
                  </div>
                  <span className={`text-[14px] select-none ${draftOption === option ? 'font-semibold text-[#222222]' : 'text-[#727272]'}`}>
                    {option}
                  </span>
                </label>
              ))}

              {/* 직접 입력 텍스트필드 — 부드럽게 나타남 */}
              <div className={`overflow-hidden transition-all duration-300 ease-in-out ${
                draftOption === '직접 입력' ? 'max-h-16 opacity-100 mb-2' : 'max-h-0 opacity-0'
              }`}>
                <input
                  type="text"
                  value={draftCustomText}
                  onChange={e => setDraftCustomText(e.target.value)}
                  placeholder="배달 기사에게 자세하게 요청해주세요"
                  maxLength={20}
                  className="w-full border border-[#D7D7D7] rounded-xl px-4 py-3 text-sm text-[#222222] placeholder:text-[#D7D7D7] outline-none focus:border-[#222222] transition-colors"
                />
              </div>
            </div>

            {/* 완료 버튼 */}
            <div className="px-5 py-4 border-t border-[#F2F2F2]">
              <button
                onClick={confirmDeliveryOption}
                className="w-full py-4 bg-[#1E1E1E] text-white rounded-xl font-bold text-base active:scale-95 transition-transform"
              >
                완료
              </button>
            </div>
          </div>
        </>
      )}

      {/* Footer */}
      <footer className="flex-shrink-0 px-4 pt-3 pb-4 border-t border-[#D7D7D7] bg-white shadow-[0_-4px_20px_rgba(0,0,0,0.08)]">
        {/* 개인정보 수집 동의 */}
        <label className="flex items-start gap-2.5 mb-3 cursor-pointer">
          <div
            onClick={() => setPrivacyAgreed(v => !v)}
            className={`w-5 h-5 rounded flex items-center justify-center flex-shrink-0 mt-0.5 border-2 transition-colors ${
              privacyAgreed ? 'bg-[#222222] border-[#222222]' : 'border-[#D7D7D7]'
            }`}
          >
            {privacyAgreed && <span className="text-white text-[11px] font-bold leading-none">✓</span>}
          </div>
          <span className="text-[12px] text-[#727272] leading-relaxed">
            연락처 수집에 동의합니다.{' '}
            <a
              href="/privacy"
              onClick={e => e.stopPropagation()}
              className="inline-block align-middle ml-0.5 px-2.5 py-1 rounded-lg bg-[#EDEDED] text-[12px] font-normal text-[#222222] no-underline active:bg-[#E0E0E0] transition-colors"
            >
              개인정보처리방침
            </a>
          </span>
        </label>
        <button
          onClick={handleOrder}
          disabled={orderBlocked}
          className={`w-full py-4 rounded-xl font-bold text-base transition-colors ${
            orderBlocked ? 'bg-[#CCC] text-[#1E1E1E] cursor-not-allowed' : 'bg-[#1E1E1E] text-white active:scale-95'
          }`}
        >
          {isSubmitting ? '주문 중...' : '주문하기'}
        </button>
        <p className="text-center text-xs text-[#727272] mt-2">
          주문 취소는 어려워요. 신중하게 확인해주세요.
        </p>
      </footer>
    </div>
  )
}
