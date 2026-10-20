'use client'

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { Account, KakaoUser, ActiveLink } from '@/lib/types'

interface SessionState {
  // 인증 주체 (카카오 OAuth 사용자)
  kakaoUser: KakaoUser | null

  // 현재 선택된 거래처 링크 (user_account_links)
  activeLink: ActiveLink | null

  // menu/cart/checkout 호환성 유지용 Account 객체
  account: Account | null

  // 주문자 정보 (checkout에서 입력)
  orderer: string
  phone: string

  // 세션 시작 시각 (ms)
  loginAt: number | null

  // 카드 기반 QR 인증 (Phase 2)
  cardId: string | null          // 스캔된 카드 UUID
  qrToken: string | null         // 64자리 HMAC 토큰
  pinVerified: boolean           // 이번 세션에서 PIN 인증 완료 여부
  selectedStoreId: string | null // 홈화면에서 선택한 매장

  setKakaoUser: (user: KakaoUser) => void
  setActiveLink: (link: ActiveLink) => void
  setAccount: (account: Account) => void
  setOrderer: (name: string) => void
  setPhone: (phone: string) => void
  setLoginAt: (t: number) => void
  setCardSession: (cardId: string, qrToken: string) => void
  setPinVerified: (v: boolean) => void
  setSelectedStoreId: (id: string) => void
  clearActiveLink: () => void
  resetSession: () => void
  clearSession: () => void  // 하위 호환
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      kakaoUser: null,
      activeLink: null,
      account: null,
      orderer: '',
      phone: '',
      loginAt: null,
      cardId: null,
      qrToken: null,
      pinVerified: false,
      selectedStoreId: null,

      setKakaoUser: (kakaoUser) => set({ kakaoUser }),
      setActiveLink: (activeLink) => set({ activeLink }),
      setAccount: (account) => set({ account }),
      setOrderer: (orderer) => set({ orderer }),
      setPhone: (phone) => set({ phone }),
      setLoginAt: (t) => set({ loginAt: t }),
      setCardSession: (cardId, qrToken) => set({ cardId, qrToken }),
      setPinVerified: (pinVerified) => set({ pinVerified }),
      setSelectedStoreId: (selectedStoreId) => set({ selectedStoreId }),
      clearActiveLink: () => set({ activeLink: null, account: null }),
      resetSession: () => set({
        kakaoUser: null,
        activeLink: null,
        account: null,
        orderer: '',
        phone: '',
        loginAt: null,
        cardId: null,
        qrToken: null,
        pinVerified: false,
        selectedStoreId: null,
      }),
      // 하위 호환 alias — resetSession과 동일
      clearSession: () => get().resetSession(),
    }),
    {
      name: 'sunpos-session-v3',
      version: 3,
      storage: createJSONStorage(() => {
        if (typeof window === 'undefined') {
          return {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {},
          }
        }
        return sessionStorage
      }),
    },
  ),
)
