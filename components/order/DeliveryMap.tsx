'use client'

import { useEffect, useRef, useState } from 'react'

// 배달 주문 화면의 지도 — 매장과 배달지를 한 화면에 보여준다. (카카오맵 JS SDK)
//
// ── 키 ─────────────────────────────────────────────────────────────────────
// NEXT_PUBLIC_KAKAO_JS_KEY 는 **JavaScript 키**다. REST 키와 다른 값이고,
// 브라우저에 그대로 나가는 게 정상이다 — 카카오가 등록된 도메인에서 온 요청인지로
// 막는다(개발자센터 > 플랫폼 > Web). 그래서 NEXT_PUBLIC_ 이 맞고, 숨길 이유가 없다.
// REST 키(길찾기)는 반대다. 그건 서버에서만 쓴다(/api/route-eta).
//
// ── 왜 지도를 못 만지게 하나 ────────────────────────────────────────────────
// 주문 화면에서 지도를 끌거나 확대할 일이 없고, 드래그를 열어두면 모바일에서
// 페이지 스크롤과 싸운다. 그림 한 장처럼 둔다.

const JS_KEY = process.env.NEXT_PUBLIC_KAKAO_JS_KEY

/** SDK 는 한 번만 받는다 — 지도가 여러 번 그려져도 script 태그는 하나다 */
let sdkPromise: Promise<void> | null = null
function loadKakaoSdk(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((window as any).kakao?.maps?.LatLng) return Promise.resolve()
  if (sdkPromise) return sdkPromise

  sdkPromise = new Promise<void>((resolve, reject) => {
    if (!JS_KEY) { reject(new Error('no key')); return }
    const el = document.createElement('script')
    // autoload=false — 우리가 kakao.maps.load() 를 직접 불러 시점을 잡는다
    el.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${JS_KEY}&autoload=false`
    el.async = true
    el.onload = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).kakao.maps.load(() => resolve())
    }
    el.onerror = () => reject(new Error('sdk load failed'))
    document.head.appendChild(el)
  })
  return sdkPromise
}

export interface MapPoint { lat: number; lng: number }

export default function DeliveryMap({
  store, dest, eta, height = 190,
}: {
  /** 매장 */
  store: MapPoint
  /** 배달 받을 곳 */
  dest: MapPoint
  /** 자동차 소요시간·도로거리. 없으면 띠를 띄우지 않는다 */
  eta?: { durationSec: number; distanceM: number } | null
  height?: number
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let dead = false
    loadKakaoSdk()
      .then(() => {
        if (dead || !boxRef.current) return
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const kakao = (window as any).kakao

        const map = new kakao.maps.Map(boxRef.current, {
          center: new kakao.maps.LatLng((store.lat + dest.lat) / 2, (store.lng + dest.lng) / 2),
          level: 5,
        })
        map.setDraggable(false)
        map.setZoomable(false)

        const a = new kakao.maps.LatLng(store.lat, store.lng)
        const b = new kakao.maps.LatLng(dest.lat, dest.lng)

        pin(kakao, map, a, '매장', '#1E1E1E')
        pin(kakao, map, b, '도착 장소', '#16a84c')   // 소요시간 띠와 같은 초록

        // 두 점이 다 들어오게. 여백을 넉넉히 줘야 핀이 가장자리에 걸리지 않는다.
        // 위쪽을 더 비우는 건 소요시간 띠가 거기 앉기 때문이다.
        const bounds = new kakao.maps.LatLngBounds()
        bounds.extend(a); bounds.extend(b)
        map.setBounds(bounds, 54, 40, 40, 40)
      })
      .catch(() => { if (!dead) setFailed(true) })
    return () => { dead = true }
  }, [store.lat, store.lng, dest.lat, dest.lng])

  return (
    <div className="relative w-full overflow-hidden rounded-[14px] bg-[#EDEDED]" style={{ height }}>
      <div ref={boxRef} className="absolute inset-0" />

      {failed && (
        <div className="absolute inset-0 flex items-center justify-center text-[12px] text-[#ADADAD]">
          지도를 불러오지 못했어요
        </div>
      )}

      {/* 소요시간 띠 — 메뉴의 '가장 많이 주문함' 뱃지와 같은 어법이다.
          같은 초록(#16a84c): CTA 초록(#017333)은 "누르는 것"에 쓰는 색이라
          누를 수 없는 라벨에 쓰면 버튼처럼 읽힌다.
          pt/pb 가 다른 것도 그쪽과 같은 이유 — 한글 글꼴이 안 쓰는 디센더 자리를
          잡아둬서 py 를 같게 주면 글자가 0.6px 위로 뜬다. */}
      {eta && !failed && (
        <span className="absolute left-2 top-2 z-10 rounded-lg bg-[#16a84c] px-2 pt-[3.5px] pb-[2.5px] text-[11px] font-bold text-white whitespace-nowrap shadow-sm">
          차로 약 {Math.max(1, Math.round(eta.durationSec / 60))}분 걸려요
          <span className="ml-[5px] font-semibold opacity-80">
            {eta.distanceM >= 1000
              ? `${(eta.distanceM / 1000).toFixed(1)}km`
              : `${eta.distanceM}m`}
          </span>
        </span>
      )}

    </div>
  )
}

/**
 * 핀 하나 — 라벨 + 꼬리 + 점. 좌표가 **점**에 오도록 아래 기준으로 올려 그린다.
 * CustomOverlay 를 쓰는 이유: 기본 Marker 는 라벨을 못 달고, InfoWindow 는
 * 말풍선 꼬리와 닫기 버튼이 붙어 지도 위가 시끄러워진다.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pin(kakao: any, map: any, pos: any, label: string, color: string) {
  const el = document.createElement('div')
  // ⚠️ transform 을 주지 않는다. yAnchor:1 이 이미 **콘텐츠 맨 아래**를 좌표에 맞춘다
  //    (맨 아래가 점이다). 여기서 translateY(-50%) 를 또 걸었더니 핀이 높이의 절반만큼
  //    위로 떠서, 라벨이 가리키는 곳과 실제 좌표가 어긋났다 — 점선 끝이 맞고
  //    라벨 자리는 틀린 상태였다.
  el.style.cssText = 'display:flex;flex-direction:column;align-items:center'
  // 10 → 12px, 여백도 같이 키웠다. 지도 글자(지하철역·건물명)가 11px 안팎이라
  // 10px 라벨은 배경에 묻혀서 핀인지 지명인지 구분이 안 됐다.
  // 꼬리·점도 같은 비율로 키운다 — 라벨만 키우면 머리만 큰 핀이 된다.
  el.innerHTML =
    `<span style="background:${color};color:#fff;font-size:12px;font-weight:700;`
    + `padding:3px 10px;border-radius:999px;white-space:nowrap;`
    + `box-shadow:0 1px 3px rgba(0,0,0,0.25)">${label}</span>`
    + `<span style="width:2px;height:9px;background:${color}"></span>`
    + `<span style="width:9px;height:9px;border-radius:999px;background:${color};`
    + `border:2px solid #fff;margin-top:-3px;box-shadow:0 1px 2px rgba(0,0,0,0.3)"></span>`
  new kakao.maps.CustomOverlay({ map, position: pos, content: el, yAnchor: 1 }).setMap(map)
}
