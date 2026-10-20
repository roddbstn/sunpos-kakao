// 카카오 JS SDK 타입 선언
declare global {
  interface Window {
    Kakao: {
      init: (key: string) => void
      isInitialized: () => boolean
      Auth: {
        authorize: (params: { redirectUri: string; scope?: string }) => void
      }
      Channel: {
        chat: (params: { channelPublicId: string }) => void
        addChannel: (params: { channelPublicId: string }) => void
      }
      API: {
        request: (params: {
          url: string
          data?: Record<string, string>
        }) => Promise<unknown>
      }
    }
  }
}

// 카카오 JS SDK 동적 로드 + 초기화
export async function loadKakaoSdk(): Promise<void> {
  if (typeof window === 'undefined') return
  if (window.Kakao?.isInitialized?.()) return

  const jsKey = process.env.NEXT_PUBLIC_KAKAO_JS_KEY
  if (!jsKey) {
    console.warn('NEXT_PUBLIC_KAKAO_JS_KEY 환경변수가 설정되지 않았습니다.')
    return
  }

  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector('script[src*="kakao_js_sdk"]')
    if (existing) {
      if (window.Kakao && !window.Kakao.isInitialized()) {
        window.Kakao.init(jsKey)
      }
      resolve()
      return
    }
    const script = document.createElement('script')
    script.src = 'https://t1.kakaocdn.net/kakao_js_sdk/2.7.4/kakao.min.js'
    script.crossOrigin = 'anonymous'
    script.onload = () => {
      window.Kakao.init(jsKey)
      resolve()
    }
    script.onerror = reject
    document.head.appendChild(script)
  })
}

// 카카오 채널 친구 여부 확인
// NEXT_PUBLIC_KAKAO_CHANNEL_CHECK_ENABLED=false이면 항상 통과 (비즈앱 심사 전)
export async function checkChannelFriend(channelPublicId: string): Promise<boolean> {
  const enabled = process.env.NEXT_PUBLIC_KAKAO_CHANNEL_CHECK_ENABLED === 'true'
  if (!enabled) return true

  try {
    await loadKakaoSdk()
    const res = await window.Kakao.API.request({
      url: '/v1/api/talk/channels',
      data: { channel_public_id: channelPublicId },
    }) as { channels: Array<{ channel_public_id: string; relation: string }> }
    return res.channels.some(
      c => c.channel_public_id === channelPublicId && c.relation === 'ADDED'
    )
  } catch {
    return false
  }
}

// 카카오 채널 친구 추가 팝업
export function openKakaoChannel(channelPublicId: string) {
  loadKakaoSdk().then(() => {
    window.Kakao.Channel.addChannel({ channelPublicId })
  })
}
