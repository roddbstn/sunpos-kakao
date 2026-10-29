'use client'

import { useEffect } from 'react'
import { getFirebaseAnalytics } from '@/lib/firebase'

/**
 * Analytics 초기화 — layout 에서 한 번만 마운트.
 *
 * ⚠️ **브라우저가 한가해진 뒤**에 붙인다. 전엔 마운트 즉시 돌아서
 * firebase.googleapis.com 왕복(실측 214ms)이 PIN 화면 첫 로딩과 대역폭을
 * 다퉜다. 손님이 아직 아무것도 안 눌렀는데 분석이 먼저 나가고 있었다.
 * 이벤트는 초기화 후에만 쌓이므로 몇백 ms 늦어도 집계에 영향이 없다.
 */
export default function FirebaseInit() {
  useEffect(() => {
    // ⚠️ requestIdleCallback 만으로는 부족하다. 페이지가 금방 한가해져서
    //    첫 데이터 호출(qr_account_public)과 다시 겹쳤고, 그 호출이 107ms → 309ms 로
    //    늘었다. **하한 지연을 먼저 두고** 그 다음에 한가한 틈을 기다린다.
    //    PIN 화면의 첫 추적 이벤트는 PIN 입력 성공 이후라 2초는 안전하다.
    let idle = 0
    const t = setTimeout(() => {
      const w = window as Window & {
        requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number
        cancelIdleCallback?: (id: number) => void
      }
      if (typeof w.requestIdleCallback === 'function') {
        idle = w.requestIdleCallback(() => { getFirebaseAnalytics() }, { timeout: 3000 })
      } else {
        getFirebaseAnalytics()   // Safari — requestIdleCallback 없음
      }
    }, 2000)
    return () => {
      clearTimeout(t)
      const w = window as Window & { cancelIdleCallback?: (id: number) => void }
      if (idle && typeof w.cancelIdleCallback === 'function') w.cancelIdleCallback(idle)
    }
  }, [])
  return null
}
