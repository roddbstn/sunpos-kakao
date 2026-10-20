'use client'

import { useState, useCallback, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useSessionStore } from '@/lib/store/session'
import { useCartStore } from '@/lib/store/cart'
import { getSupabaseClient } from '@/lib/supabase/client'
import { formatWon, calcSubtotal, isLowBalance, isNegativeBalance } from '@/lib/utils'
import { track } from '@/lib/firebase'
import { ampTrack } from '@/lib/amplitude'
import type { Menu, SelectedOption } from '@/lib/types'
import OptionGroup from '@/components/menu/option-group'
import { mapDbMenu } from '@/lib/mappers'
import LoadingTimer from '@/components/ui/loading-timer'
import ScreenHeader, { HEADER_H } from '@/components/ui/screen-header'

export default function MenuDetailClient({ code }: { code: string }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const editCartId = searchParams.get('edit')   // 장바구니 수정 모드

  const account    = useSessionStore(s => s.account)
  const addItem    = useCartStore(s => s.addItem)
  const updateItem = useCartStore(s => s.updateItem)
  const items      = useCartStore(s => s.items)

  const [menu, setMenu] = useState<Menu | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedMap, setSelectedMap] = useState<Record<number, string[]>>({})
  const [qty, setQty] = useState(1)
  const [missingGroups, setMissingGroups] = useState<number[]>([])
  /** 담기 실패 안내 — 빨간 세로선만으로는 화면 밖에 있을 때 아무것도 전해지지 않는다 */
  const [notice, setNotice] = useState('')
  const [imgZoom, setImgZoom] = useState(false)

  useEffect(() => {
    async function fetchMenu() {
      setLoading(true)
      const supabase = getSupabaseClient()
      const { data, error } = await supabase
        .from('menus')
        .select(`
          id, category_id, name, description, base_price, image_url,
          is_popular, is_recommended, is_new, is_sold_out, is_hidden,
          menu_option_groups (
            display_order,
            option_groups (
              id, name, is_required, is_multi, max_select, is_sold_out, is_hidden,
              option_items ( id, name, extra_price, is_sold_out, is_hidden, display_order )
            )
          )
        `)
        .eq('id', code)
        .single()

      if (error || !data) {
        router.replace('/menu')
        return
      }
      const mapped = mapDbMenu(data)
      setMenu(mapped)

      // 편집 모드: 장바구니의 기존 옵션·수량 복원
      const editingItem = editCartId ? items.find(i => i.cartId === editCartId) : null
      if (editingItem) {
        setQty(editingItem.qty)
        const restored: Record<number, string[]> = {}
        editingItem.selectedOptions.forEach(opt => {
          if (!restored[opt.optionGroupIndex]) restored[opt.optionGroupIndex] = []
          restored[opt.optionGroupIndex].push(opt.optionId)
        })
        setSelectedMap(restored)
      } else {
        // 신규 담기: 필수 옵션그룹의 첫 번째 항목 자동 선택
        const initial: Record<number, string[]> = {}
        mapped.options.forEach((group, idx) => {
          if (group.required && group.items.length > 0) {
            const first = group.items.find(it => !it.isSoldOut) ?? group.items[0]
            initial[idx] = [first.id]
          }
        })
        if (Object.keys(initial).length > 0) setSelectedMap(initial)
      }

      setLoading(false)
    }
    fetchMenu()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code])

  const handleToggle = useCallback((groupIndex: number, itemId: string) => {
    if (!menu) return
    const group = menu.options[groupIndex]
    if (!group) return

    setSelectedMap(prev => {
      const current = prev[groupIndex] ?? []
      let next: string[]

      if (group.multi) {
        next = current.includes(itemId)
          ? current.filter(id => id !== itemId)
          : [...current, itemId]
      } else if (group.required) {
        // 필수 단일선택은 **끌 수 없다**. 어차피 하나는 골라야 하는데, 고른 걸 다시 누르면
        // 비워지는 바람에 "담기를 눌러도 아무 일이 없는" 상태로 빠졌다.
        // 다른 항목으로 바꾸는 건 그대로 된다.
        next = [itemId]
      } else {
        next = current[0] === itemId ? [] : [itemId]
      }

      return { ...prev, [groupIndex]: next }
    })

    setMissingGroups(prev => prev.filter(i => i !== groupIndex))
  }, [menu])

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-surface">
        <LoadingTimer size={44} />
      </div>
    )
  }

  if (!menu) return null

  const selectedOptions: SelectedOption[] = menu.options.flatMap((group, gIdx) =>
    (selectedMap[gIdx] ?? []).flatMap(id => {
      const item = group.items.find(it => it.id === id)
      return item ? [{ optionGroupIndex: gIdx, optionId: id, optionName: item.name, plus: item.plus }] : []
    })
  )

  const subtotal = calcSubtotal(menu.price, selectedOptions, qty)
  const currentBalance = account ? account.balance : 0
  const afterBalance = currentBalance - subtotal

  const validateRequired = (): number[] => {
    const missing: number[] = []
    menu.options.forEach((group, idx) => {
      if (group.required && (selectedMap[idx] ?? []).length === 0) missing.push(idx)
    })
    setMissingGroups(missing)
    return missing
  }

  const handleAddToCart = () => {
    const missing = validateRequired()
    if (missing.length > 0) {
      // ⚠️ 여기서 document.querySelector('[data-missing="true"]') 로 찾으면 안 된다.
      //    바로 위 setMissingGroups 는 비동기라 이 줄에서는 DOM 에 아직 그 표시가 없다 —
      //    querySelector 가 null 을 돌려주고 scrollIntoView 가 조용히 아무 일도 안 했다.
      //    그래서 화면 아래에 있는 필수 그룹은 보이지도 않고 스크롤도 안 돼서,
      //    손님에겐 "담기 버튼이 눌리기만 하는" 고장으로 보였다.
      //    인덱스로 직접 찾고, 다음 프레임(=렌더 뒤)에 스크롤한다.
      setNotice('필수 옵션을 선택해 주세요')
      requestAnimationFrame(() => {
        document.querySelector(`[data-group-index="${missing[0]}"]`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      })
      return
    }
    setNotice('')

    if (editCartId) {
      updateItem(editCartId, qty, selectedOptions)
      router.push('/cart')
    } else {
      addItem(menu.code, menu.name, menu.price, qty, selectedOptions, menu.imageUrl)
      track('add_to_cart', { item_name: menu.name, price: menu.price, quantity: qty, value: subtotal, currency: 'KRW' })
      ampTrack('add_to_cart', { menu_name: menu.name, price: menu.price, quantity: qty })
      router.refresh()  // /menu 라우터 캐시 무효화 → 장바구니 바 즉시 반영
      router.back()
    }
  }

  return (
    <div className="flex flex-col h-full bg-surface">
      {/* ── 헤더 ── */}
      <ScreenHeader title="메뉴 선택" onBack={() => router.back()} fixed />

      {/* ── 스크롤 영역 ──
          paddingTop 은 HEADER_H 와 **같은 상수**를 쓴다. 전엔 57px 로 적어 뒀는데
          실제 바는 그보다 커서 사진 위쪽이 바에 가려져 있었다. */}
      <div className="flex-1 pb-[100px] overflow-y-auto" style={{ paddingTop: `calc(env(safe-area-inset-top) + ${HEADER_H}px)` }}>
        <div
          className="w-full bg-[#F2F2F2] overflow-hidden flex items-center justify-center"
          style={{ aspectRatio: '16/10' }}
          onClick={() => menu.imageUrl && setImgZoom(true)}
        >
          {menu.imageUrl
            ? <img src={menu.imageUrl} alt={menu.name} className={`w-full h-full object-cover ${menu.imageUrl ? 'cursor-zoom-in' : ''}`} />
            : <span style={{ fontSize: '72px' }}>{menu.emoji}</span>
          }
        </div>

        {/* 이미지 확대 오버레이 */}
        {imgZoom && menu.imageUrl && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
            onClick={() => setImgZoom(false)}
          >
            <img
              src={menu.imageUrl}
              alt={menu.name}
              className="max-w-[92vw] max-h-[80vh] rounded-xl object-contain"
              onClick={e => e.stopPropagation()}
            />
          </div>
        )}

        <div className="px-5 pt-5 pb-4">
          {(menu.popular || menu.recommended || menu.isNew) && (
            <div className="flex gap-1 flex-wrap mb-2">
              {menu.popular     && <span style={{ backgroundColor: '#F97316', color: 'white' }} className="inline-block text-[13px] font-bold px-[8px] py-[2px] rounded-full">인기</span>}
              {menu.recommended && <span style={{ backgroundColor: '#16a84c', color: 'white' }} className="inline-block text-[13px] font-bold px-[8px] py-[2px] rounded-full">추천</span>}
              {menu.isNew       && <span style={{ backgroundColor: '#1D6FE8', color: 'white' }} className="inline-block text-[13px] font-bold px-[8px] py-[2px] rounded-full">신메뉴</span>}
            </div>
          )}
          <h1 className="text-[20px] font-[800] text-[#222222] mb-1">{menu.name}</h1>
          <p className="text-[13px] text-[#727272] leading-relaxed">{menu.desc}</p>
        </div>

        {/* 가격·수량은 같은 모양의 두 줄이다. 라벨은 옵션그룹 제목(bold)보다 한 단계 얇게 —
            그룹 제목은 연한 바를 달고 있어서 같은 굵기면 둘이 같은 층처럼 보인다.
            가격은 숫자라 오른쪽 정렬해야 수량 숫자와 세로로 맞는다. */}
        <div className="flex items-center justify-between px-5 pb-3">
          <span className="text-[16px] font-semibold text-[#1E1E1E]">가격</span>
          <span className="text-[18px] font-bold text-[#1E1E1E] tabular-nums text-right">{formatWon(menu.price)}</span>
        </div>

        <div className="flex items-center justify-between px-5 pb-4">
          <span className="text-[16px] font-semibold text-[#1E1E1E]">수량</span>
          <div className="flex items-center gap-4">
            <button
              onClick={() => { const next = Math.max(1, qty - 1); if (next !== qty) { track('quantity_change', { menu_name: menu.name, direction: 'down', new_qty: next }); ampTrack('quantity_change', { menu_name: menu.name, direction: 'down', new_qty: next }) } setQty(q => Math.max(1, q - 1)) }}
              className="w-9 h-9 rounded-full border border-[#D7D7D7] flex items-center justify-center transition-transform active:scale-90"
              disabled={qty <= 1}
              aria-label="수량 줄이기"
            >
              {/* 1이면 기호까지 더 연하게 — 테두리만 흐려두면 아직 눌릴 것처럼 보인다 */}
              <MinusIcon color={qty <= 1 ? '#DEDEDE' : '#ABABAB'} />
            </button>
            <span className="text-[16px] font-bold w-6 text-center">{qty}</span>
            <button
              onClick={() => { track('quantity_change', { menu_name: menu.name, direction: 'up', new_qty: qty + 1 }); ampTrack('quantity_change', { menu_name: menu.name, direction: 'up', new_qty: qty + 1 }); setQty(q => q + 1) }}
              className="w-9 h-9 rounded-full border border-[#D7D7D7] flex items-center justify-center transition-transform active:scale-90"
              aria-label="수량 늘리기"
            >
              <PlusIcon color="#ABABAB" />
            </button>
          </div>
        </div>

        {menu.options.length > 0 && (
          <div className="flex flex-col">
            {menu.options.map((group, idx) => (
              // 선택지가 1개뿐인 필수 그룹은 그리지 않는다. '가격(필수) - 훈제오리 단백질 도시락'
              // 처럼 메뉴값을 옵션으로 넣어둔 그룹이 메뉴마다 붙어 있는데, 고를 게 없는 줄이
              // 화면 맨 위 한 칸을 먹고 가격을 한 번 더 반복한다.
              group.required && !group.multi && group.items.filter(it => !it.isSoldOut).length === 1 ? null : (
              <div
                key={idx}
                data-group-index={idx}
                data-missing={missingGroups.includes(idx) ? 'true' : 'false'}
              >
                <OptionGroup
                  group={group}
                  groupIndex={idx}
                  selectedIds={selectedMap[idx] ?? []}
                  onToggle={handleToggle}
                  isMissing={missingGroups.includes(idx)}
                  basePrice={menu.price}
                />
              </div>
              )
            ))}
          </div>
        )}

        <div className="h-4" />
      </div>

      {/* 담기가 막힌 이유 — 하단 바 바로 위. 손가락이 있는 자리에서 말해야 읽힌다.
          필수 그룹은 화면 아래에 있을 수 있어서 그쪽 표시만으론 아무것도 전해지지 않는다. */}
      {notice && (
        <div
          className="fixed left-0 right-0 z-10 px-5"
          style={{ maxWidth: '430px', margin: '0 auto', bottom: 'calc(72px + env(safe-area-inset-bottom))' }}
        >
          <p className="bg-[#FFF0F0] text-[#C92A2A] text-[13px] font-semibold rounded-xl px-4 py-2.5 text-center">
            {notice}
          </p>
        </div>
      )}

      {/* ── 하단 고정 영역 ── */}
      <div
        className="fixed bottom-0 left-0 right-0 bg-surface px-5 py-3 z-10 flex items-center justify-between gap-4"
        style={{ maxWidth: '430px', margin: '0 auto', boxShadow: '0 -4px 20px rgba(0,0,0,0.08)' }}
      >
        {/* 왼쪽: 선결제 잔액 */}
        {account && (
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] text-gray-text">선결제 잔액</span>
            <span className={[
              'text-[16px] font-bold',
              isNegativeBalance(account.balance) || isLowBalance(account.balance) ? 'text-danger' : 'text-ink',
            ].join(' ')}>
              {formatWon(account.balance)}
            </span>
          </div>
        )}

        {/* 오른쪽: 담기 버튼 */}
        <button
          onClick={handleAddToCart}
          className="flex-shrink-0 py-[12px] px-7 bg-ink text-white rounded-xl font-bold flex items-center gap-1.5 active:scale-95 transition-transform"
        >
          <span className="text-[15px]">{editCartId ? '변경하기' : '담기'}</span>
          <span className="text-[16px]">{formatWon(subtotal)}</span>
        </button>
      </div>
    </div>
  )
}

// 수량 ± 아이콘. 글자 '−'/'+' 는 폰트마다 굵기·세로 위치가 달라 원 안에서 미세하게
// 삐뚤어 보인다. 1.2px 선으로 직접 그리면 두 버튼이 정확히 같은 모양이 된다.
function MinusIcon({ color }: { color: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <line x1="2.5" y1="7" x2="11.5" y2="7" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function PlusIcon({ color }: { color: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <line x1="2.5" y1="7" x2="11.5" y2="7" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
      <line x1="7" y1="2.5" x2="7" y2="11.5" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}
