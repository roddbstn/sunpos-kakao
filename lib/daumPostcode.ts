// 다음(Daum) 우편번호 검색 — checkout, profile-setup 양쪽 화면이 공유한다.
// (브라우저에서 직접 도는 일반 웹앱이라 팝업 .open() 방식 그대로 사용 — Electron 앱인
// sallaria-pos는 팝업이 막혀서 .embed() 방식을 따로 쓴다, 거기서는 이 모듈을 공유하지 않음)
'use client'

export interface DaumPostcodeResult {
  roadAddress:     string
  autoRoadAddress: string
  jibunAddress:    string
}

declare global {
  interface Window {
    daum: {
      Postcode: new (opts: { oncomplete: (d: DaumPostcodeResult) => void }) => { open: () => void }
    }
  }
}

export function loadDaumPostcodeScript(): Promise<void> {
  return new Promise((resolve) => {
    const scriptId = 'daum-postcode'
    if (document.getElementById(scriptId)) { resolve(); return }
    const script = document.createElement('script')
    script.id = scriptId
    script.src = 'https://t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js'
    script.async = true
    script.onload = () => resolve()
    document.body.appendChild(script)
  })
}

// 주소 검색 팝업을 열고 선택 결과를 반환한다. 사용처에서 track/상태 초기화 등 후속 처리를 이어서 한다.
export async function searchAddress(): Promise<DaumPostcodeResult> {
  await loadDaumPostcodeScript()
  return new Promise((resolve) => {
    new window.daum.Postcode({
      oncomplete: (data) => resolve(data),
    }).open()
  })
}

// Daum이 주는 세 가지 주소 필드 중 실제로 쓸 도로명(또는 지번) 주소 하나를 고른다.
export function pickRoadAddress(data: DaumPostcodeResult): string {
  return data.roadAddress || data.autoRoadAddress || data.jibunAddress || ''
}
