import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseServer } from '@/lib/supabase/server'
import crypto from 'crypto'

// sallaria-pos(Electron, 고객추가 시 PIN 암호화 호출)처럼 다른 origin에서도 쓰는 엔드포인트라 CORS 허용 필요.
// verify/decrypt는 쿠키 세션으로 인증되므로 Access-Control-Allow-Origin: * 를 붙여도
// 크리덴셜이 전달되지 않아 실질적으로 열리지 않음 — encrypt만 실제로 cross-origin에서 쓰임.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

function json(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: { ...CORS_HEADERS, ...init?.headers },
  })
}

// AES-256-CBC 키 (32바이트 = 64 hex)
// 반드시 .env에 PIN_AES_KEY=<64자리 hex> 설정 — 조용한 폴백 금지(고정 키로 암호화되는 사고 재발 방지)
function getKey(): Buffer {
  const hex = process.env.PIN_AES_KEY
  if (!hex || hex.length !== 64) {
    throw new Error('PIN_AES_KEY가 설정되지 않았거나 길이가 64자리 hex가 아닙니다.')
  }
  return Buffer.from(hex, 'hex')
}

function encryptPin(pin: string): string {
  const key = getKey()
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
  let ciphertext = cipher.update(pin, 'utf8', 'hex')
  ciphertext += cipher.final('hex')
  return `${iv.toString('hex')}:${ciphertext}`
}

function decryptPin(encrypted: string): string {
  const key = getKey()
  const [ivHex, ciphertext] = encrypted.split(':')
  const iv = Buffer.from(ivHex, 'hex')
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
  let plain = decipher.update(ciphertext, 'hex', 'utf8')
  plain += decipher.final('utf8')
  return plain
}

export async function POST(request: NextRequest) {
  const body = await request.json()
  const { action } = body

  // ── PIN 암호화 (최초 설정 시) ──
  if (action === 'encrypt') {
    const { pin } = body
    if (!pin || !/^\d{4}$/.test(pin)) {
      return json({ error: 'invalid_pin' }, { status: 400 })
    }
    const encrypted = encryptPin(pin)
    return json({ encrypted })
  }

  // ── PIN 검증 (로그인 시) ──
  if (action === 'verify') {
    const { pin, kakaoId } = body
    if (!pin || !/^\d{4}$/.test(pin) || !kakaoId) {
      return json({ error: 'invalid_params' }, { status: 400 })
    }

    const supabase = await getSupabaseServer()

    // 서버 세션으로 본인 확인
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return json({ error: 'unauthorized' }, { status: 401 })
    }

    // sunpos_users에서 PIN 정보 조회
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: profile } = await (supabase as any)
      .from('sunpos_users')
      .select('pin_encrypted, pin_attempts, pin_locked_until, kakao_id')
      .eq('id', user.id)
      .maybeSingle()

    if (!profile || !profile.pin_encrypted) {
      return json({ success: false, reason: 'pin_not_set' })
    }

    // 잠금 확인
    if (profile.pin_locked_until && new Date(profile.pin_locked_until) > new Date()) {
      return json({
        success: false,
        reason: 'locked',
        locked_until: profile.pin_locked_until,
      })
    }

    // PIN 검증
    let pinMatches = false
    try {
      const decrypted = decryptPin(profile.pin_encrypted)
      pinMatches = decrypted === pin
    } catch {
      return json({ error: 'decrypt_failed' }, { status: 500 })
    }

    // 시도 횟수 기록 RPC 호출
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: attemptResult } = await (supabase as any)
      .rpc('record_pin_attempt', {
        p_kakao_id: profile.kakao_id,
        p_success:  pinMatches,
      })

    if (pinMatches) {
      return json({ success: true })
    } else {
      return json({
        success:      false,
        reason:       attemptResult?.reason ?? 'wrong_pin',
        attempts_left: attemptResult?.attempts_left ?? 0,
        locked_until: attemptResult?.locked_until ?? null,
      })
    }
  }

  // ── 거래처 공유 PIN 검증 (QR 주문 진입 시) ──
  if (action === 'verify_account') {
    const { pin, accountCode } = body
    if (!pin || !/^\d{4}$/.test(pin) || !accountCode) {
      return json({ error: 'invalid_params' }, { status: 400 })
    }

    const supabase = await getSupabaseServer()

    // ⚠️ 로그인 검사도, 복호화도 여기서 하지 않는다.
    //    흐름이 뒤집혔다 — QR 을 찍은 사람이 **로그인 전에** PIN 을 넣는다.
    //    그래서 검증을 통째로 DB 안에서 끝낸다(verify_account_pin_public):
    //    잠금 판정 · 비교 · 시도 기록이 한 트랜잭션이고, 암호문도 AES 키도
    //    네트워크에 올라가지 않는다. 돌아오는 건 참/거짓과 남은 횟수뿐이다.
    //
    //    예전엔 get_account_pin_encrypted() 로 암호문을 받아 Node 에서 풀었는데,
    //    그 RPC 가 auth.uid() 와 승인된 링크를 요구해서 비로그인 호출이 예외로 떨어졌고,
    //    라우트가 그걸 'pin_not_set'(아직 PIN이 설정되지 않았어요)으로 뭉개 보여줬다.
    //    PIN 은 멀쩡히 있는데 "설정되지 않았다"가 뜨던 정체가 이것이다.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .rpc('verify_account_pin_public', { p_account_code: accountCode, p_pin: pin })

    if (error) {
      return json({ error: error.message }, { status: 400 })
    }

    const r = Array.isArray(data) ? data[0] : data
    if (r?.success) return json({ success: true })

    return json({
      success:       false,
      reason:        r?.reason ?? 'wrong_pin',
      attempts_left: r?.attempts_left ?? 0,
      locked_until:  r?.locked_until ?? null,
    })
  }

  // ── PIN 복호화 (PIN 찾기 — 이름+전화 본인 확인 후) ──
  if (action === 'decrypt') {
    const { encrypted } = body
    if (!encrypted) {
      return json({ error: 'missing_encrypted' }, { status: 400 })
    }

    // 호출자가 로그인 중인지 확인
    const supabase = await getSupabaseServer()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return json({ error: 'unauthorized' }, { status: 401 })
    }

    try {
      const pin = decryptPin(encrypted)
      return json({ pin })
    } catch {
      return json({ error: 'decrypt_failed' }, { status: 500 })
    }
  }

  return json({ error: 'invalid_action' }, { status: 400 })
}
