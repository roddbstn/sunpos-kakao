'use client'

import { useState, useEffect, useRef, useCallback, Suspense, useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useSessionStore } from '@/lib/store/session'
import RecentMenus from '@/components/menu/recent-menus'
import { useCartStore } from '@/lib/store/cart'
import { getSupabaseClient } from '@/lib/supabase/client'
import { formatWon, isLowBalance, isNegativeBalance, shortRoadAddress, entrySourceBreakdown } from '@/lib/utils'
import MenuCard from '@/components/menu/menu-card'
import { track } from '@/lib/firebase'
import { ampTrack } from '@/lib/amplitude'
import { personProps } from '@/lib/person-key'
import MenuDetailClient from './[code]/menu-detail-client'
import type { Category, Menu } from '@/lib/types'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { mapDbMenu } from '@/lib/mappers'
import LoadingTimer from '@/components/ui/loading-timer'
import KakaoLoginButton from '@/components/KakaoLoginButton'
import SelfRegisterSheet from '@/components/SelfRegisterSheet'
import { getSessionUser, getSunposProfile, getUserStoreLinks, getSunposAddresses } from '@/lib/auth'

export default function MenuPage() {
  return (
    <Suspense>
      <MenuPageInner />
    </Suspense>
  )
}

function MenuPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const selectedItemCode = searchParams.get('item')
  const account = useSessionStore(s => s.account)

  // ── 사람 확인 ───────────────────────────────────────────────────────────
  // PIN 은 '계정'을 열어줄 뿐 '누가' 쓰는지는 모른다. 메뉴는 보여주되,
  // 주문하려면 카카오 로그인 → 이름·전화번호·배달 장소까지 받아야 한다.
  //   미로그인      → 하단 CTA 가 카카오 로그인 버튼
  //   로그인·미등록 → 하단 시트로 정보 입력
  //   둘 다 끝      → 평소대로 장바구니 바
  const [authState, setAuthState] = useState<'checking' | 'anon' | 'unregistered' | 'ready'>('checking')
  const [kakaoNick, setKakaoNick] = useState('')
  const [myName,    setMyName]    = useState('')
  const [myPhone,   setMyPhone]   = useState('')
  const [loginBusy, setLoginBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      const user = await getSessionUser()
      if (!alive) return
      if (!user) { setAuthState('anon'); return }
      setKakaoNick(user.nickname ?? '')
      // profile 과 links 는 서로를 기다릴 이유가 없다. 전엔 순서대로 await 해서
      // 왕복 두 번이 직렬로 쌓였다(실측 ~250ms). 같이 쏘고 같이 받는다.
      const [profile, links] = await Promise.all([
        getSunposProfile(),
        account?.storeId ? getUserStoreLinks(account.storeId).catch(() => []) : Promise.resolve([]),
      ])
      if (!alive) return

      // ⚠️ 등록 여부는 **계정별**이다.
      // 전엔 sunpos_users.phone 만 보고 판단했는데, 그건 사람 단위 프로필이라
      // A계정에 등록한 사람이 B계정 QR 로 들어와도 'ready' 가 됐다. 그래서 톱니가
      // 보이고, 설정 화면은 계정별 링크를 확인하니 "이 계정의 이용자가 아니에요"로
      // 거부했다 — 들어온 사람 입장에선 로그인은 됐는데 설정만 막히는 모양이었다.
      const linked = links.some(l => l.account_code === account?.code && l.status === 'approved')

      if (profile?.phone && linked) {
        const nm = profile.nickname || user.nickname || ''
        setMyName(nm)
        // 세션에도 넣어둔다. 주문 확인 화면은 세션의 orderer/phone 을 미리 채우는데,
        // QR→PIN→카카오 흐름에는 이 값을 넣어주는 자리가 없어서 저장해둔 연락처가
        // 있는데도 빈 칸으로 떴다.
        useSessionStore.getState().setPhone(profile.phone)
        if (nm) useSessionStore.getState().setOrderer(nm)
        setAuthState('ready')
      } else {
        // 프로필이 이미 있으면 시트에 미리 채워 한 번만 확인하면 되게 한다
        setMyName(profile?.nickname || user.nickname || '')
        setMyPhone(profile?.phone ?? '')
        setAuthState('unregistered')
      }
    })()
    return () => { alive = false }
    // account 는 sessionStorage 복원 뒤에야 채워진다. deps 가 비어 있으면 복원 전에
    // 한 번 돌고 끝나서 storeId 가 없는 채로 '미등록'으로 굳는다.
  }, [account?.code, account?.storeId])

  async function handleKakaoLogin() {
    setLoginBusy(true)
    const supabase = getSupabaseClient()
    // 로그인 뒤 메뉴로 돌아온다 — 거기서 하단 시트가 뜬다
    await supabase.auth.signInWithOAuth({
      provider: 'kakao',
      options: {
        redirectTo: `${window.location.origin}/auth/callback/?next=/menu`,
        scopes: 'account_email profile_nickname profile_image',
      },
    })
    setLoginBusy(false)
  }
  const activeLink = useSessionStore(s => s.activeLink)
  const orderer = useSessionStore(s => s.orderer)
  // 분석에 실을 사람. 카카오 로그인 이용자는 세션의 orderer 가 비어 있고 본인 이름은
  // myName 에 있다 — personProps(logOrderer) 만 쓰면 그 사람들의 클릭이 전부 orderer_key
  // 없이 쌓여서 사람별 분해에서 통째로 빠진다. 지난주문 목록을 받는 기준과 같게 맞춘다.
  const logOrderer = myName || orderer
  const cartItems = useCartStore(s => s.items)

  const [lastDeliveryAddress, setLastDeliveryAddress] = useState<{ roadAddress: string; detailAddress: string | null } | null>(null)
  const [categories, setCategories] = useState<Category[]>([])
  const [menus, setMenus] = useState<Menu[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState(false)
  const [retryCount, setRetryCount] = useState(0)
  const [activeCategory, setActiveCategory] = useState('')
  const [showDropdown, setShowDropdown] = useState(false)
  const [showScrollTop, setShowScrollTop] = useState(false)
  const [catBarShadow,  setCatBarShadow]  = useState(false)
  const [searchBarShadow, setSearchBarShadow] = useState(false)
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const tabButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const tabsRef = useRef<HTMLDivElement>(null)
  const isScrollingToRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)  // 내부 스크롤 컨테이너
  const categoryClickCountRef = useRef(0)  // 메뉴 선택 전 카테고리 탭 클릭 횟수

  // ── 검색 상태 ──────────────────────────────────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchActiveCategory, setSearchActiveCategory] = useState('')
  const [searchShowDropdown, setSearchShowDropdown] = useState(false)
  const searchInputRef    = useRef<HTMLInputElement>(null)
  const searchScrollRef   = useRef<HTMLDivElement>(null)
  const searchSectionRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const searchTabRefs     = useRef<Record<string, HTMLButtonElement | null>>({})
  const searchTabsRef     = useRef<HTMLDivElement>(null)
  const searchIsScrolling = useRef(false)

  // 검색 결과: 품절 제외 + 메뉴명 필터 (빈 쿼리면 전체)
  const searchResults = useMemo(() => {
    const q = searchQuery.trim()
    return menus.filter(m => !m.isSoldOut && (q === '' || m.name.includes(q)))
  }, [menus, searchQuery])

  // 검색 결과에 메뉴가 있는 카테고리만
  const searchCategories = useMemo(() => {
    const ids = new Set(searchResults.map(m => m.cat))
    return categories.filter(c => ids.has(c.id))
  }, [categories, searchResults])

  // hydration 완료 여부 추적
  const [hydrated, setHydrated] = useState(() => useSessionStore.persist.hasHydrated())
  useEffect(() => {
    if (useSessionStore.persist.hasHydrated()) { setHydrated(true); return }
    const unsub = useSessionStore.persist.onFinishHydration(() => setHydrated(true))
    return () => unsub()
  }, [])

  // 잔액 실시간 구독 (Supabase Realtime)
  const setAccount = useSessionStore(s => s.setAccount)
  useEffect(() => {
    if (!account) return
    const supabase = getSupabaseClient()

    const currentAccount = account
    supabase
      .from('accounts')
      .select('current_balance')
      .eq('account_code', currentAccount.code)
      .maybeSingle()
      .then(({ data }: { data: { current_balance: number } | null }) => {
        if (data && data.current_balance !== currentAccount.balance) {
          setAccount({ ...currentAccount, balance: data.current_balance })
        }
      })

    const channel: RealtimeChannel = supabase
      .channel(`balance-${account.code}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'accounts',
          filter: `account_code=eq.${account.code}`,
        },
        (payload: { new: Record<string, unknown> }) => {
          const newBalance = payload.new['current_balance']
          if (typeof newBalance === 'number') {
            setAccount({ ...currentAccount, balance: newBalance })
          }
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.code])

  // 현재 배달받는 곳 — 이 거래처에서 가장 최근에 배달 주문했던 주소를 매장명 위에 보여준다
  useEffect(() => {
    if (!account?.code) return
    let cancelled = false
    // 맨 위에 저장된 주소가 '현재 배달 주소'다. 전엔 마지막 **주문**의 주소를 썼는데,
    // 설정에서 주소를 바꿔도 다음 주문 전까진 옛 주소가 계속 떠 있었다.
    getSunposAddresses()
      // list[0] 은 **기본 주소**다 — getSunposAddresses 가 is_default 를 맨 앞으로 정렬한다.
      // 설정 화면에서 주소를 바꾸면 여기 상단 표시도 같이 따라온다.
      .then(list => { if (!cancelled) setLastDeliveryAddress(list[0] ?? null) })
      .catch(() => { if (!cancelled) setLastDeliveryAddress(null) })
    return () => { cancelled = true }
  }, [account?.code])

  // DB에서 카테고리 + 메뉴 로딩
  useEffect(() => {
    if (!account) return
    async function load() {
      setLoading(true)
      setFetchError(false)
      try {
        const supabase = getSupabaseClient()

        // 카테고리 + 메뉴를 **한 번에** 받는다. 전엔 categories 를 받아야 그 id 로
        // menus 를 칠 수 있어서 왕복이 반드시 두 번이었다(실측 82ms + 48ms, 직렬).
        // RPC 는 SECURITY INVOKER 라 RLS 가 그대로 적용되고, 반환 모양도 기존
        // PostgREST 중첩 결과와 같아서 mapDbMenu 를 고칠 필요가 없다.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: board, error: boardError } = await (supabase as any)
          .rpc('qr_menu_board', { p_store_id: account?.storeId ?? null })
        if (boardError) throw boardError

        const catData = (board?.categories ?? []) as { id: string; name: string }[]
        if (catData.length === 0) return

        const cats: Category[] = catData.map(c => ({ id: c.id, name: c.name }))
        setCategories(cats)
        setActiveCategory(cats[0].id)

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setMenus(((board?.menus ?? []) as any[]).map(mapDbMenu))
      } catch {
        setFetchError(true)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [account, retryCount])

  // categories를 ref로 유지 — spy 클로저에서 항상 최신 값을 읽기 위해
  const categoriesRef = useRef<Category[]>([])
  useEffect(() => { categoriesRef.current = categories }, [categories])

  // 스크롤 감지 + 스파이 — loading 끝난 뒤 scrollRef가 DOM에 붙으면 한 번 실행
  const firedDepths = useRef(new Set<number>())
  useEffect(() => {
    if (loading) return
    const container = scrollRef.current
    if (!container) return
    const TABS_H = 56
    const el = container  // TypeScript closure narrowing용

    function onScroll() {
      const top = el.scrollTop
      setShowScrollTop(top > 300)
      setCatBarShadow(top > 10)
      // 스크롤 깊이 트래킹 (25/50/75/90%)
      const pct = Math.floor((top / (el.scrollHeight - el.clientHeight)) * 100)
      for (const milestone of [25, 50, 75, 90]) {
        if (pct >= milestone && !firedDepths.current.has(milestone)) {
          firedDepths.current.add(milestone)
          track('scroll_depth', { depth: milestone, page: 'menu' })
          ampTrack('scroll_depth', { depth: milestone, page: 'menu' })
        }
      }
      // 카테고리 스파이
      if (isScrollingToRef.current) return
      const cats = categoriesRef.current
      if (cats.length === 0) return
      const baseTop = el.getBoundingClientRect().top + TABS_H
      let current = cats[0].id
      for (const cat of cats) {
        const el = sectionRefs.current[cat.id]
        if (!el) continue
        if (el.getBoundingClientRect().top <= baseTop) current = cat.id
      }
      setActiveCategory(current)
    }

    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [loading])

  // 활성 탭 자동 수평 스크롤 — 탭이 탭바 밖으로 나가면 따라옴
  useEffect(() => {
    const btn = tabButtonRefs.current[activeCategory]
    const bar = tabsRef.current
    if (!btn || !bar) return
    const btnLeft  = btn.offsetLeft
    const btnRight = btnLeft + btn.offsetWidth
    const barLeft  = bar.scrollLeft
    const barRight = barLeft + bar.offsetWidth
    if (btnLeft < barLeft + 16) {
      bar.scrollTo({ left: btnLeft - 16, behavior: 'smooth' })
    } else if (btnRight > barRight - 16) {
      bar.scrollTo({ left: btnRight - bar.offsetWidth + 16, behavior: 'smooth' })
    }
  }, [activeCategory])

  // 검색 모달 열릴 때 input 포커스
  useEffect(() => {
    if (!searchOpen) return
    const t = setTimeout(() => searchInputRef.current?.focus(), 150)
    return () => clearTimeout(t)
  }, [searchOpen])

  // 검색 결과 바뀔 때 첫 번째 카테고리로 active 초기화
  useEffect(() => {
    if (searchOpen && searchCategories.length > 0) {
      setSearchActiveCategory(searchCategories[0].id)
    }
  }, [searchOpen, searchCategories])

  // 검색 모달 내 스크롤 스파이
  useEffect(() => {
    if (!searchOpen) return
    const container = searchScrollRef.current
    if (!container) return
    function spy() {
      if (searchIsScrolling.current) return
      if (searchCategories.length === 0) return
      const tabsBottom = searchTabsRef.current?.getBoundingClientRect().bottom ?? 56
      let current = searchCategories[0].id
      for (const cat of searchCategories) {
        const el = searchSectionRefs.current[cat.id]
        if (!el) continue
        if (el.getBoundingClientRect().top <= tabsBottom) current = cat.id
      }
      setSearchActiveCategory(current)
      setSearchBarShadow((container?.scrollTop ?? 0) > 10)
    }
    setSearchBarShadow(false)
    container.addEventListener('scroll', spy, { passive: true })
    return () => { container.removeEventListener('scroll', spy); setSearchBarShadow(false) }
  }, [searchOpen, searchCategories])

  // 검색 모달 활성 탭 자동 수평 스크롤
  useEffect(() => {
    if (!searchOpen) return
    const btn = searchTabRefs.current[searchActiveCategory]
    const bar = searchTabsRef.current
    if (!btn || !bar) return
    const btnLeft  = btn.offsetLeft
    const btnRight = btnLeft + btn.offsetWidth
    const barLeft  = bar.scrollLeft
    const barRight = barLeft + bar.offsetWidth
    if (btnLeft < barLeft + 16) {
      bar.scrollTo({ left: btnLeft - 16, behavior: 'smooth' })
    } else if (btnRight > barRight - 16) {
      bar.scrollTo({ left: btnRight - bar.offsetWidth + 16, behavior: 'smooth' })
    }
  }, [searchActiveCategory, searchOpen])

  const scrollToSearchCategory = useCallback((catId: string) => {
    const el = searchSectionRefs.current[catId]
    const container = searchScrollRef.current
    if (!el || !container) return
    searchIsScrolling.current = true
    setSearchActiveCategory(catId)
    const tabsBottom = searchTabsRef.current?.getBoundingClientRect().bottom ?? 56
    const elTop = el.getBoundingClientRect().top
    container.scrollTo({ top: container.scrollTop + (elTop - tabsBottom), behavior: 'smooth' })
    setTimeout(() => { searchIsScrolling.current = false }, 800)
  }, [])

  const scrollToCategory = useCallback((catId: string, source: 'tab' | 'dropdown' = 'tab') => {
    const el = sectionRefs.current[catId]
    const container = scrollRef.current
    if (!el || !container) return
    const catName = categoriesRef.current.find(c => c.id === catId)?.name ?? catId
    track(source === 'dropdown' ? 'category_dropdown_select' : 'category_tab_click', { category_name: catName })
    ampTrack(source === 'dropdown' ? 'category_dropdown_select' : 'category_tab_click', { category_name: catName })
    categoryClickCountRef.current += 1
    isScrollingToRef.current = true
    setActiveCategory(catId)
    setShowDropdown(false)

    // 탭바 하단 기준으로 스크롤 위치 계산 — 구분선 top이 탭바 bottom에 정확히 닿도록
    const tabsBottom = tabsRef.current?.getBoundingClientRect().bottom ?? 60
    const elTop = el.getBoundingClientRect().top
    const scrollTop = container.scrollTop + (elTop - tabsBottom)
    container.scrollTo({ top: scrollTop, behavior: 'smooth' })
    setTimeout(() => { isScrollingToRef.current = false }, 800)
  }, [])

  const menusByCat = useCallback((catId: string) => {
    if (catId === '__popular__') return menus.filter(m => m.popular)
    return menus.filter(m => m.cat === catId)
  }, [menus])

  const qty = cartItems.reduce((s, i) => s + i.qty, 0)
  const subtotal = cartItems.reduce((s, i) => s + i.subtotal, 0)

  if (!hydrated) return null
  if (!account) {
    return (
      <div className="flex flex-col min-h-screen bg-surface">
        <div className="flex-1 flex flex-col items-center justify-center px-8 text-center">
          <p className="text-[16px] font-semibold text-[#222222] mb-2">세션이 만료되었습니다</p>
          <p className="text-[13px] text-[#727272]">QR 코드를 다시 스캔해 주세요.</p>
        </div>
        <div className="px-5 pb-10 pt-4">
          <a href="/" className="block w-full py-4 rounded-2xl bg-[#2C261F] text-white text-[15px] font-bold text-center">
            처음으로
          </a>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-surface">
        <LoadingTimer size={44} />
      </div>
    )
  }

  if (fetchError) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen px-8 text-center bg-surface gap-3">
        <p className="text-[16px] font-semibold text-[#222222]">메뉴를 불러오지 못했습니다</p>
        <p className="text-[13px] text-[#727272]">네트워크 상태를 확인하고 다시 시도해주세요.</p>
        <button
          onClick={() => setRetryCount(c => c + 1)}
          className="mt-2 px-6 py-2.5 rounded-full bg-[#017333] text-white text-[14px] font-semibold"
        >
          다시 시도
        </button>
      </div>
    )
  }

  return (
    // fixed + centered: 430px 안에서 뷰포트 전체 높이를 점유 → sticky/overflow 동작 유지
    <div
      className="fixed top-0 bottom-0 w-full max-w-[430px] flex flex-col bg-surface"
      style={{ left: '50%', transform: 'translateX(-50%)', paddingTop: 'env(safe-area-inset-top)' }}
    >

      {/* ── 내부 스크롤 컨테이너 ── */}
      <div className="flex-1 overflow-y-auto" ref={scrollRef}>

        {/* 헤더 (스크롤 시 사라짐) */}
        <div className="bg-surface pt-14 px-6 pb-0">
          {/* 현재 배달 주소 — 상단 가운데. 시/도·시군구는 떼고 도로명부터만 보여준다.
              같은 동네 안에서는 앞부분이 전부 같아서 구분에 쓸모가 없고 줄만 길어진다. */}
          {lastDeliveryAddress && (
            <div className="flex items-center justify-center gap-1 mb-2">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#727272" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0Z" />
                <circle cx="12" cy="10" r="3" />
              </svg>
              <span className="text-[12px] font-light text-[#1E1E1E] truncate">
                {shortRoadAddress(lastDeliveryAddress.roadAddress)}
              </span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <h1 className="text-[26px] font-bold text-[#222222]">{account.storeName ?? ''}</h1>
            {authState === 'ready' && (
              <button
                onClick={() => router.push(`/settings/${account.code}`)}
                aria-label="설정"
                /* -mr-2 를 뺐다. 아이콘만 있을 땐 여백을 당겨 시각 보정하는 게 맞았지만,
                   회색 박스가 생기면서 그 가장자리가 아래 잔액 박스보다 8px 밖으로
                   튀어나왔다. 면이 보이는 요소는 컨테이너 패딩에 맞춰야 한다. */
                className="w-9 h-9 flex items-center justify-center rounded-xl bg-gray-50 active:bg-[#E8E4E2] active:scale-95 transition-all duration-100"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#1E1E1E" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.343 3.94c.09-.542.56-.94 1.11-.94h1.093c.55 0 1.02.398 1.11.94l.149.894c.07.424.384.764.78.93.398.164.855.142 1.205-.108l.737-.527a1.125 1.125 0 0 1 1.45.12l.773.774c.39.389.44 1.002.12 1.45l-.527.737c-.25.35-.272.806-.107 1.204.165.397.505.71.93.78l.893.15c.543.09.94.56.94 1.109v1.094c0 .55-.397 1.02-.94 1.11l-.893.149c-.425.07-.765.383-.93.78-.165.398-.143.854.107 1.204l.527.738c.32.447.269 1.06-.12 1.45l-.774.773a1.125 1.125 0 0 1-1.449.12l-.738-.527c-.35-.25-.806-.272-1.203-.107-.397.165-.71.505-.781.929l-.149.894c-.09.542-.56.94-1.11.94h-1.094c-.55 0-1.019-.398-1.11-.94l-.148-.894c-.071-.424-.384-.764-.781-.93-.398-.164-.854-.142-1.204.108l-.738.527c-.447.32-1.06.269-1.45-.12l-.773-.774a1.125 1.125 0 0 1-.12-1.45l.527-.737c.25-.35.273-.806.108-1.204-.165-.397-.505-.71-.93-.78l-.894-.15c-.542-.09-.94-.56-.94-1.109v-1.094c0-.55.398-1.02.94-1.11l.894-.149c.424-.07.765-.383.93-.78.165-.398.143-.854-.108-1.204l-.526-.738a1.125 1.125 0 0 1 .12-1.45l.773-.773a1.125 1.125 0 0 1 1.45-.12l.737.527c.35.25.807.272 1.204.107.397-.165.71-.505.78-.929l.15-.894Z" />
                  <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                </svg>
              </button>
            )}
          </div>

          <div className={`mt-3 mb-4 rounded-xl px-4 py-3 flex items-center justify-between ${
            isNegativeBalance(account.balance) ? 'bg-[#FFF0F0]' : 'bg-gray-50'
          }`}>
            <span className="text-[13px] font-light text-[#1E1E1E]">
              {/* 거래처명도 주문자명과 같은 13px 회색. 강조는 오른쪽 잔액 하나로 몰아준다 —
                  왼쪽에서 굵게 세워두면 "여기도 봐야 하나" 싶어 시선이 둘로 갈린다. */}
              <span>{account.name}</span>
              {(myName || orderer) && <span className="ml-1">· {myName || orderer}</span>}
            </span>
            <div className="text-right">
              <div className="text-[13px] font-light text-ink">선결제 잔액</div>
              <div className={[
                'text-[13px] font-bold',
                isLowBalance(account.balance) ? 'text-danger' : 'text-ink',
              ].join(' ')}>
                {formatWon(account.balance)}
              </div>
            </div>
          </div>
        </div>

        {/* 카테고리 탭 (sticky — 내부 컨테이너 기준으로 동작) */}
        <div className="sticky top-0 z-10 bg-surface" style={{ position: 'sticky' }}>
          <div className="flex items-center">
            <div
              ref={tabsRef}
              className="flex gap-2 overflow-x-auto px-5 py-3 flex-1 scrollbar-hide"
              style={{ scrollbarWidth: 'none' }}
            >
              {categories.map(cat => (
                <button
                  key={cat.id}
                  ref={el => { tabButtonRefs.current[cat.id] = el }}
                  onClick={() => scrollToCategory(cat.id)}
                  className={[
                    'flex-shrink-0 px-[18px] py-[9px] text-[14px] font-semibold transition-colors',
                    'rounded-[27.5px]',
                    activeCategory === cat.id
                      ? 'bg-[#222222] text-white'
                      : 'bg-gray-bg text-gray-text',
                  ].join(' ')}
                >
                  {cat.name}
                </button>
              ))}
            </div>
            <button
              onClick={() => { if (!showDropdown) { track('category_dropdown_open'); ampTrack('category_dropdown_open'); } setShowDropdown(v => !v) }}
              className="flex-shrink-0 w-10 h-10 mr-4 bg-white border border-[#E0E0E0] rounded-full flex items-center justify-center text-[#727272]"
              style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}
              aria-label="전체 카테고리"
            >
              <svg
                className="transition-transform duration-200"
                style={{ transform: showDropdown ? 'rotate(-90deg)' : 'rotate(90deg)', width: 22, height: 22 }}
                viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              >
                <polyline points="9 6 15 12 9 18" />
              </svg>
            </button>
          </div>
          {/* 스크롤 시 아랫변 gradient 그림자 — overflow 컨테이너 안에서도 흰 콘텐츠 위에 보임 */}
          <div
            style={{
              position: 'absolute', bottom: -6, left: 0, right: 0, height: 6,
              background: 'linear-gradient(to bottom, rgba(0,0,0,0.05), transparent)',
              opacity: catBarShadow ? 1 : 0,
              transition: 'opacity 0.2s',
              pointerEvents: 'none',
            }}
          />
        </div>

        {/* 지난 주문 — 카테고리 탭 바로 아래.
            카카오 로그인 상태면 RPC 가 auth.uid() 로 본인 주문을 찾고,
            아직 uid 로 쌓인 주문이 없으면 주문자명으로 떨어진다. */}
        {account?.code && (
          <RecentMenus
            accountCode={account.code}
            ordererName={logOrderer}
            // 아직 자기 정보를 안 낸 사람(로그인 전·등록 전)에게는 이 매장의 실제
            // 메뉴로 만든 예시를 보여준다. 빈 줄로 두면 이 기능이 있는 줄도 모른다.
            demoPool={authState === 'ready' ? undefined : menus}
            onShown={count => {
              track('recent_menus_shown', { count })
              ampTrack('recent_menus_shown', { count })
            }}
            onPick={(menuId, meta) => {
              // Menu.code 가 곧 menus.id 다 (lib/mappers.ts: code = row.id)
              const menu = menus.find(m => m.code === menuId)
              if (!menu) return
              const payload = {
                menu_name: menu.name, menu_code: menu.code,
                rank: meta.rank,          // 지난주문 줄에서 몇 번째 카드였나
                times: meta.times,        // 그 사람이 몇 번 시킨 메뉴인가
                is_top: meta.isTop,       // '가장 많이 주문함' 뱃지가 달린 카드였나
                source: 'recent',
                ...personProps(logOrderer),
              }
              track('recent_menu_click', payload)
              ampTrack('recent_menu_click', payload)
              // 뱃지 달린 카드를 고른 경우는 따로도 한 번 — 퍼널에서 바로 분모/분자로 쓰려고
              if (meta.isTop) {
                track('recent_menu_top_click', payload)
                ampTrack('recent_menu_top_click', payload)
              }
              // ?from= 은 상세 화면의 add_to_cart 가 '어느 목록에서 들어왔는지'를 알기 위한 것.
              // 클릭 시점엔 아는 정보인데 상세는 오버레이라 컴포넌트가 달라서, URL 로 넘긴다.
              router.push(`/menu?item=${menu.code}&from=recent`)
            }}
          />
        )}

        {/* 메뉴 목록 */}
        <div className="pb-[100px]">
          {categories.filter(c => menusByCat(c.id).length > 0).map((cat, i) => {
            const catMenus = menusByCat(cat.id)

            return (
              <div key={cat.id}>
                {/* 카테고리 사이를 가르는 바. **첫 카테고리 위에는 긋지 않는다** —
                    바로 위가 카테고리 탭이라, 거기에 바가 붙으면 탭이 회색 띠를
                    깔고 앉은 것처럼 보인다. 스크롤 위치 계산에 ref 가 필요하므로
                    엘리먼트는 남기고 높이·배경만 없앤다. */}
                <div
                  ref={el => { sectionRefs.current[cat.id] = el }}
                  data-cat={cat.id}
                  className={i === 0 ? 'h-0' : 'h-2 bg-gray-50 mt-2'}
                />
                <div className="px-5 pt-5 pb-1">
                  <h2 className="text-[20px] font-bold text-[#222222]">{cat.name}</h2>
                </div>

                <div className="px-5">
                  {catMenus.map(menu => (
                    <MenuCard
                      key={menu.code}
                      menu={menu}
                      onClick={() => {
                        const el = scrollRef.current
                        const scrollPct = el ? Math.round((el.scrollTop / (el.scrollHeight - el.clientHeight)) * 100) : 0
                        const catClicks = categoryClickCountRef.current
                        categoryClickCountRef.current = 0
                        track('menu_card_click', { menu_name: menu.name, menu_code: menu.code, scroll_pct: scrollPct, category_click_count: catClicks })
                        ampTrack('menu_card_click', { menu_name: menu.name, menu_code: menu.code, scroll_pct: scrollPct, category_click_count: catClicks })
                        router.push(`/menu?item=${menu.code}&from=list`)
                      }}
                    />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* 맨 위로 버튼 */}
      {showScrollTop && (
        <button
          onClick={() => { ampTrack('scroll_to_top'); scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' }) }}
          className="fixed right-5 z-20 w-10 h-10 bg-white border border-[#D7D7D7] rounded-full shadow-md flex items-center justify-center text-[#727272] text-[13px]"
          style={{ bottom: qty > 0 ? '160px' : '80px' }}
          aria-label="맨 위로"
        >
          ↑
        </button>
      )}

      {/* 검색 플로팅 버튼 */}
      <button
        onClick={() => {
          const p = personProps(logOrderer)
          track('search_open', p); ampTrack('search_open', p)
          setSearchQuery(''); setSearchOpen(true)
        }}
        className="fixed right-5 z-20 w-10 h-10 bg-[#222222] text-white rounded-full shadow-lg flex items-center justify-center"
        style={{ bottom: qty > 0 ? '100px' : '20px' }}
        aria-label="메뉴 검색"
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </button>

      {/* 카테고리 모달 */}
      {showDropdown && (
        <div
          className="fixed inset-0 z-30 flex items-center justify-center bg-black/50"
          onClick={() => setShowDropdown(false)}
        >
          <div
            className="bg-white rounded-2xl w-[90vw] max-w-[380px] px-5 py-5 mx-4"
            onClick={e => e.stopPropagation()}
          >
            <p className="text-[13px] font-bold text-[#222222] mb-3 text-center">카테고리</p>
            <div className="flex flex-wrap gap-2">
              {categories.map(cat => (
                <button
                  key={cat.id}
                  onClick={() => scrollToCategory(cat.id, 'dropdown')}
                  className={[
                    'whitespace-nowrap py-2 px-3 text-[12px] font-semibold rounded-xl transition-colors',
                    activeCategory === cat.id
                      ? 'bg-[#222222] text-white'
                      : 'bg-gray-bg text-gray-text',
                  ].join(' ')}
                >
                  {cat.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── 하단 바 ──
          로그인 전에는 **메뉴를 보되 주문은 못 한다.** 장바구니 바 대신 카카오 로그인이
          그 자리를 차지한다 — 담아놓고 결제 직전에 로그인하라고 하면, 고른 걸 잃을까 봐
          뒤로 못 가는 상태에서 로그인을 강요받는 꼴이 된다. */}
      {authState === 'anon' ? (
        <div className="flex-shrink-0 px-5 py-4 bg-white" style={{ boxShadow: '0 -4px 20px rgba(0,0,0,0.08)' }}>
          <KakaoLoginButton onClick={handleKakaoLogin} loading={loginBusy} />
        </div>
      ) : qty > 0 && (
        <div
          className="flex-shrink-0 px-5 py-4 bg-white"
          style={{ boxShadow: '0 -4px 20px rgba(0,0,0,0.08)' }}
        >
          <button
            onClick={() => {
              // 담긴 항목의 유입 경로 구성비를 같이 보낸다 — 담기→주문 기여도를 재려면
              // 이 단계부터 경로가 안 끊겨야 한다.
              // item_count 는 이 이벤트에서 예전부터 **총 수량**(qty)이라 그 의미를 유지한다.
              const p = { ...entrySourceBreakdown(cartItems), item_count: qty }
              track('cart_bar_click', p); ampTrack('cart_bar_click', p)
              router.push('/cart')
            }}
            className="w-full py-[16px] bg-[#2C261F] text-white rounded-xl font-bold text-[15px] flex items-center justify-between px-5"
          >
            <span className="bg-black/10 rounded-lg px-2 py-0.5 text-[13px]">{qty}개</span>
            <span>장바구니 보기</span>
            <span>{formatWon(subtotal)}</span>
          </button>
        </div>
      )}

      {/* 로그인은 했는데 아직 자기 정보를 안 낸 사람 — 메뉴를 가리고 받는다 */}
      {authState === 'unregistered' && account?.code && (
        <SelfRegisterSheet
          accountCode={account.code}
          defaultName={kakaoNick}
          onDone={name => { setMyName(name); setAuthState('ready') }}
        />
      )}

      {/* ── 검색 모달 ── */}
      {searchOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40"
          style={{ animation: 'backdropFadeIn 0.2s ease', paddingTop: 'env(safe-area-inset-top)' }}
          onClick={() => { ampTrack('search_modal_close', { trigger: 'backdrop' }); setSearchOpen(false) }}
        >
          <div
            className="absolute left-0 right-0 bottom-0 bg-white rounded-t-2xl flex flex-col overflow-hidden"
            style={{
              top: 'calc(48px + env(safe-area-inset-top))',
              animation: 'searchModalOpen 0.3s cubic-bezier(0.34, 1.4, 0.64, 1)',
              transformOrigin: 'bottom right',
            }}
            onClick={e => e.stopPropagation()}
          >
            {/* 헤더 + 검색 입력 (스크롤 시 아랫변 그림자) */}
            <div className="flex-shrink-0 relative">
              <div style={{ position: 'absolute', bottom: -6, left: 0, right: 0, height: 6, background: 'linear-gradient(to bottom, rgba(0,0,0,0.05), transparent)', opacity: searchBarShadow ? 1 : 0, transition: 'opacity 0.2s', pointerEvents: 'none', zIndex: 1 }} />
            {/* 헤더 */}
            <div className="px-5 pt-5 pb-3 flex items-center justify-between">
              <h2 className="text-[18px] font-extrabold text-[#222222]">메뉴 검색</h2>
              <button
                onClick={() => { ampTrack('search_modal_close', { trigger: 'button' }); setSearchOpen(false) }}
                className="w-9 h-9 flex items-center justify-center text-[#727272]"
                aria-label="닫기"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>

            {/* 검색 입력 */}
            <div className="px-5 pb-3">
              <div className="flex items-center gap-2 bg-[#F2F2F2] rounded-xl px-4 py-3">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#727272" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  ref={searchInputRef}
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  onFocus={() => {
                    const p = personProps(logOrderer)
                    track('search_field_focus', p); ampTrack('search_field_focus', p)
                  }}
                  onKeyDown={e => {
                    // 엔터 = "찾아달라"는 분명한 의사표시. 글자를 치다 만 것과 구분된다.
                    if (e.key !== 'Enter') return
                    const q = searchQuery.trim()
                    if (!q) return
                    const p = { query: q, query_len: q.length, ...personProps(logOrderer) }
                    track('search_submit', p); ampTrack('search_submit', p)
                  }}
                  placeholder="메뉴 이름을 입력하세요"
                  className="flex-1 bg-transparent outline-none text-[15px] text-[#222222] placeholder:text-[#727272]"
                />
                {searchQuery && (
                  <button onClick={() => setSearchQuery('')} className="text-[#727272] text-[16px] leading-none">✕</button>
                )}
              </div>
            </div>

            </div>{/* end 헤더+검색 wrapper */}

            {/* 스크롤 영역 (카테고리 탭 + 메뉴 목록) */}
            <div ref={searchScrollRef} className="flex-1 overflow-y-auto bg-white">

              {/* 카테고리 탭 sticky */}
              {searchCategories.length > 0 && (
                <div className="sticky top-0 z-10 bg-surface" style={{ position: 'sticky' }}>
                  <div className="flex items-center">
                    <div
                      ref={searchTabsRef}
                      className="flex gap-2 overflow-x-auto px-5 py-3 flex-1"
                      style={{ scrollbarWidth: 'none' }}
                    >
                      {searchCategories.map(cat => (
                        <button
                          key={cat.id}
                          ref={el => { searchTabRefs.current[cat.id] = el }}
                          onClick={() => { ampTrack('search_category_tab_click', { category_id: cat.id, category_name: cat.name }); scrollToSearchCategory(cat.id) }}
                          className={[
                            'flex-shrink-0 px-[18px] py-[9px] text-[14px] font-semibold transition-colors rounded-[27.5px]',
                            searchActiveCategory === cat.id
                              ? 'bg-[#222222] text-white'
                              : 'bg-gray-bg text-gray-text',
                          ].join(' ')}
                        >
                          {cat.name}
                        </button>
                      ))}
                    </div>
                    <button
                      onClick={() => { ampTrack('search_category_dropdown_open'); setSearchShowDropdown(v => !v) }}
                      className="flex-shrink-0 w-10 h-10 mr-4 bg-white border border-[#E0E0E0] rounded-full flex items-center justify-center text-[#727272]"
                      style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}
                      aria-label="전체 카테고리"
                    >
                      <svg
                        className="transition-transform duration-200"
                        style={{ transform: searchShowDropdown ? 'rotate(-90deg)' : 'rotate(90deg)', width: 22, height: 22 }}
                        viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                      >
                        <polyline points="9 6 15 12 9 18" />
                      </svg>
                    </button>
                  </div>
                </div>
              )}

              {/* 메뉴 목록 */}
              {searchCategories.length > 0 ? (
                <div className="pb-10">
                  {searchCategories.map(cat => (
                    <div key={cat.id}>
                      <div
                        ref={el => { searchSectionRefs.current[cat.id] = el }}
                        className="h-2 bg-gray-50 mt-2"
                      />
                      <div className="px-5 pt-5 pb-1">
                        <h2 className="text-[20px] font-bold text-[#222222]">{cat.name}</h2>
                      </div>
                      <div className="px-5">
                        {searchResults.filter(m => m.cat === cat.id).map((menu, si) => (
                          <MenuCard
                            key={menu.code}
                            menu={menu}
                            onClick={() => {
                              const sp = {
                                menu_name: menu.name, menu_code: menu.code,
                                query: searchQuery.trim(), rank: si + 1,
                                ...personProps(logOrderer),
                              }
                              track('search_menu_click', sp)
                              ampTrack('search_menu_click', sp)
                              setSearchOpen(false)
                              router.push(`/menu?item=${menu.code}&from=search`)
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : searchQuery.trim() ? (
                <div className="flex flex-col items-center justify-center py-24 px-8 text-center">
                  <p className="text-[40px] mb-4">🔍</p>
                  <p className="text-[16px] font-semibold text-[#222222]">검색 결과가 없습니다</p>
                  <p className="text-[13px] text-[#727272] mt-1">다른 키워드로 검색해 보세요</p>
                </div>
              ) : null}
            </div>

            {/* 검색 내 카테고리 드롭다운 */}
            {searchShowDropdown && (
              <div
                className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 rounded-t-2xl"
                onClick={() => setSearchShowDropdown(false)}
              >
                <div
                  className="bg-white rounded-2xl w-[90%] max-w-[380px] px-5 py-5"
                  onClick={e => e.stopPropagation()}
                >
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-[13px] font-bold text-[#222222]">카테고리</p>
                    <button
                      onClick={() => setSearchShowDropdown(false)}
                      className="w-8 h-8 flex items-center justify-center text-[#727272]"
                      aria-label="닫기"
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {searchCategories.map(cat => (
                      <button
                        key={cat.id}
                        onClick={() => { scrollToSearchCategory(cat.id); setSearchShowDropdown(false) }}
                        className={[
                          'whitespace-nowrap py-2 px-3 text-[12px] font-semibold rounded-xl transition-colors',
                          searchActiveCategory === cat.id
                            ? 'bg-[#222222] text-white'
                            : 'bg-gray-bg text-gray-text',
                        ].join(' ')}
                      >
                        {cat.name}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 메뉴 상세 오버레이 — ?item=code 파라미터가 있을 때 표시 */}
      {selectedItemCode && (
        <div className="fixed top-0 bottom-0 w-full max-w-[430px] z-50 bg-white" style={{ left: '50%', transform: 'translateX(-50%)', paddingTop: 'env(safe-area-inset-top)' }}>
          <Suspense>
            <MenuDetailClient code={selectedItemCode} />
          </Suspense>
        </div>
      )}
    </div>
  )
}
