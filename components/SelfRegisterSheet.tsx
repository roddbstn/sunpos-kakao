'use client'

import { useState } from 'react'
import { getSupabaseClient } from '@/lib/supabase/client'
import { searchAddress } from '@/lib/daumPostcode'
import { geocodeAddress, upsertSunposAddress } from '@/lib/auth'

// 카카오 로그인을 막 마친 사람에게 이름·전화번호·배달 장소를 받는 하단 시트.
//
// 왜 여기서 받나: 카카오는 닉네임과 프로필 사진만 준다. 전화번호도 실명도 안 준다.
// 그런데 선결제 장부는 **누가 썼는지**가 전부다 — 종이 장부 시절에도 이름은 적었다.
// 그래서 로그인 직후, 메뉴를 고르기 전에 한 번만 받는다.
//
// 세 칸을 다 채우고 동의해야 확인 버튼이 열린다. 하나라도 비우면 장부에 '누구'가
// 비어버리고, 그건 이 제품이 존재하는 이유를 없앤다.
//
// 전엔 이 자리에 '관리자가 보낸 초대링크'가 있었다. 이제 없다 — QR 과 PIN 을 아는
// 사람이 곧 이용자다.

export default function SelfRegisterSheet({
  accountCode, defaultName, onDone,
}: {
  accountCode: string
  /** 카카오 닉네임 — 실명일 때가 많아 초기값으로 깔아준다 */
  defaultName?: string
  onDone: (name: string) => void
}) {
  const [name,   setName]   = useState(defaultName ?? '')
  const [phone,  setPhone]  = useState('')
  const [road,   setRoad]   = useState('')
  const [detail, setDetail] = useState('')
  const [agree,  setAgree]  = useState(false)
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  const digits = phone.replace(/[^0-9]/g, '')
  const ready  = name.trim().length > 0 && digits.length >= 10 && road.trim().length > 0 && agree

  /** 010-1234-5678 꼴로 — 입력하면서 바로 보이게 */
  function onPhone(v: string) {
    const d = v.replace(/[^0-9]/g, '').slice(0, 11)
    if (d.length < 4)      setPhone(d)
    else if (d.length < 8) setPhone(`${d.slice(0, 3)}-${d.slice(3)}`)
    else                   setPhone(`${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`)
  }

  async function pickAddress() {
    try {
      const r = await searchAddress()
      setRoad(r.roadAddress || r.autoRoadAddress || r.jibunAddress)
    } catch { /* 팝업을 닫은 것 — 아무 일도 하지 않는다 */ }
  }

  async function submit() {
    if (!ready || saving) return
    setSaving(true); setError('')
    try {
      const supabase = getSupabaseClient()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: regErr } = await (supabase as any).rpc('register_self_to_account', {
        p_account_code: accountCode,
        p_name:         name.trim(),
        p_phone:        digits,
      })
      if (regErr) throw regErr

      // 배달 장소 — 좌표를 못 구해도 등록 자체는 막지 않는다.
      // 주소는 사람이 읽는 값이고 좌표는 배달료 계산용 보조값이다.
      const geo = await geocodeAddress(road).catch(() => null)
      await upsertSunposAddress({
        roadAddress:   road.trim(),
        detailAddress: detail.trim() || undefined,
        lat:           geo?.lat ?? 0,
        lng:           geo?.lng ?? 0,
      })

      onDone(name.trim())
    } catch (e) {
      setError((e as Error).message || '등록에 실패했어요. 다시 시도해 주세요')
      setSaving(false)
    }
  }

  const field = 'w-full h-[48px] px-4 rounded-xl border border-[#D7D7D7] text-[15px] text-[#1E1E1E] placeholder:text-[#C4C4C4] outline-none focus:border-[#1E1E1E] transition-colors'

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40">
      <div
        className="w-full max-w-[430px] bg-white rounded-t-2xl flex flex-col max-h-[88dvh] overflow-hidden"
        style={{ animation: 'searchModalOpen 0.28s cubic-bezier(0.34, 1.4, 0.64, 1)' }}
      >
        <div className="px-5 pt-6 pb-4 flex-shrink-0">
          <h2 className="text-[19px] font-bold text-[#1E1E1E] leading-snug">
            전화번호와 주소가 필요해요
          </h2>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-4 space-y-4">
          <div>
            <label className="block text-[13px] font-semibold text-[#727272] mb-2">이름</label>
            <input value={name} onChange={e => setName(e.target.value.slice(0, 20))}
                   placeholder="예: 김지은" className={field} />
          </div>

          <div>
            <label className="block text-[13px] font-semibold text-[#727272] mb-2">전화번호</label>
            <input value={phone} onChange={e => onPhone(e.target.value)} inputMode="numeric"
                   placeholder="010-0000-0000" className={field} />
          </div>

          <div>
            <label className="block text-[13px] font-semibold text-[#727272] mb-2">배달받을 장소</label>
            <button type="button" onClick={pickAddress}
                    className={`${field} text-left ${road ? 'text-[#1E1E1E]' : 'text-[#C4C4C4]'}`}>
              {road || '주소 검색'}
            </button>
            {road && (
              <input value={detail} onChange={e => setDetail(e.target.value.slice(0, 40))}
                     placeholder="상세 주소 (예: 3층 공원녹지과)" className={`${field} mt-2`} />
            )}
          </div>

          {/* 방침 링크를 label 안에 두면 안 된다 — 링크를 눌러도 체크박스가 같이 토글된다.
              형제로 빼서 오른쪽 끝 '>' 로 세운다. */}
          <div className="flex items-start gap-2.5 pt-1">
            <label className="flex-1 min-w-0 flex items-start gap-2.5 cursor-pointer">
              <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)}
                     className="mt-0.5 w-[18px] h-[18px] flex-shrink-0" />
              <span className="text-[13px] text-[#414141] leading-relaxed">
                이름·전화번호·배달 장소 수집에 동의합니다.
              </span>
            </label>
            <a href="/privacy" target="_blank" rel="noreferrer"
               aria-label="개인정보처리방침 보기"
               className="flex-shrink-0 p-1 -mr-1 mt-0.5 text-[#ADADAD]">
              <svg width="7" height="12" viewBox="0 0 8 14" fill="none">
                <path d="M1.5 1L6.5 7L1.5 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </a>
          </div>

          {error && <p className="text-[13px] text-[#C92A2A]">{error}</p>}
        </div>

        <div className="flex-shrink-0 px-5 pt-3" style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}>
          <button
            onClick={submit}
            disabled={!ready || saving}
            className={`w-full py-4 rounded-xl font-bold text-[16px] transition-colors ${
              ready && !saving ? 'bg-[#2C261F] text-white active:scale-[0.99]' : 'bg-[#E5E5E5] text-[#ADADAD]'
            }`}
          >
            {saving ? '등록 중…' : '확인'}
          </button>
        </div>
      </div>
    </div>
  )
}
