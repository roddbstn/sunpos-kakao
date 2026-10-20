'use client'

import { useState } from 'react'
import { searchAddress } from '@/lib/daumPostcode'
import { geocodeAddress, upsertSunposAddress, updateSunposAddress, type SunposAddress } from '@/lib/auth'

// 주소 추가 — 설정 화면에서 바로 고치지 않고 이 모달을 거친다.
//
// 전엔 '+ 추가'를 누르면 우편번호 창이 뜨고, 닫히는 즉시 저장됐다. 상세 주소는 목록에
// 생긴 칸에 따로 적어야 했다. 그래서 "몇 층인지"를 안 적고 넘어가는 일이 잦았다.
// 한 모달 안에서 도로명 → 상세까지 받고 한 번에 저장한다.
//
// 주소는 최대 10곳이다. 꽉 찬 상태로 저장을 누르면 서버가 needsConfirmation 과 함께
// **지워질 주소**를 알려준다. 그걸 그대로 보여주고 한 번 더 묻는다 — 조용히 지우면
// 나중에 "내 주소가 왜 없지"가 된다.

export default function AddressAddModal({ onClose, onSaved, editing }: {
  onClose: () => void
  onSaved: () => void
  /** 넘기면 '수정' 모드 — 추가 대신 그 주소를 고친다 */
  editing?: SunposAddress
}) {
  const [road,   setRoad]   = useState(editing?.roadAddress ?? '')
  const [detail, setDetail] = useState(editing?.detailAddress ?? '')
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')
  /** 10곳이 찼을 때 지워질 주소 — 값이 있으면 확인 모달을 띄운다 */
  const [dropping, setDropping] = useState<string | null>(null)

  async function pick() {
    try {
      const r = await searchAddress()
      const next = r.roadAddress || r.autoRoadAddress || r.jibunAddress
      if (next) { setRoad(next); setError('') }
    } catch { /* 창을 닫은 것 — 아무 일도 하지 않는다 */ }
  }

  async function save(confirmDeleteOldest = false) {
    if (!road.trim() || saving) return
    setSaving(true); setError('')
    try {
      const geo = await geocodeAddress(road).catch(() => null)

      // 수정 모드는 10곳 제한과 무관하다 — 개수가 늘지 않으니까
      if (editing) {
        await updateSunposAddress(editing.id, {
          roadAddress:   road.trim(),
          detailAddress: detail.trim() || undefined,
          lat:           geo?.lat ?? editing.lat ?? 0,
          lng:           geo?.lng ?? editing.lng ?? 0,
        })
        onSaved()
        return
      }

      const r = await upsertSunposAddress({
        roadAddress:   road.trim(),
        detailAddress: detail.trim() || undefined,
        lat:           geo?.lat ?? 0,
        lng:           geo?.lng ?? 0,
        confirmDeleteOldest,
      })
      if (r.needsConfirmation) {
        setDropping(r.oldestAddress ?? '가장 먼저 추가한 주소')
        setSaving(false)
        return
      }
      onSaved()
    } catch {
      setError('주소를 저장하지 못했어요. 다시 시도해 주세요')
      setSaving(false)
    }
  }

  const field = 'w-full h-[48px] px-4 rounded-xl border border-[#D7D7D7] text-[15px] text-[#1E1E1E] placeholder:text-[#C4C4C4] outline-none focus:border-[#1E1E1E] transition-colors'

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-full max-w-[430px] bg-white rounded-t-2xl flex flex-col max-h-[88dvh] overflow-hidden"
        style={{ animation: 'searchModalOpen 0.28s cubic-bezier(0.34, 1.4, 0.64, 1)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 pt-6 pb-4 flex-shrink-0">
          <h2 className="text-[19px] font-bold text-[#1E1E1E] leading-snug">{editing ? '주소 수정' : '주소 추가'}</h2>
          <p className="text-[13px] text-[#727272] mt-1.5">배달받을 곳을 알려주세요</p>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-4 space-y-4">
          <div>
            <label className="block text-[13px] font-semibold text-[#727272] mb-2">도로명 주소</label>
            <button type="button" onClick={pick}
                    className={`${field} text-left ${road ? 'text-[#1E1E1E]' : 'text-[#C4C4C4]'}`}>
              {road || '주소 검색'}
            </button>
          </div>

          <div>
            <label className="block text-[13px] font-semibold text-[#727272] mb-2">상세 주소</label>
            <input value={detail} onChange={e => setDetail(e.target.value.slice(0, 40))}
                   placeholder="예: 3층 공원녹지과" className={field} />
          </div>

          {error && <p className="text-[13px] text-[#C92A2A]">{error}</p>}
        </div>

        <div className="flex-shrink-0 px-5 pt-3 flex gap-2" style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}>
          <button onClick={onClose}
                  className="h-[52px] px-6 rounded-xl bg-[#F2F2F2] text-[#727272] font-bold text-[15px]">
            취소
          </button>
          <button
            onClick={() => save(false)}
            disabled={!road.trim() || saving}
            className={`flex-1 h-[52px] rounded-xl font-bold text-[15px] transition-colors ${
              road.trim() && !saving ? 'bg-ink text-white active:scale-[0.99]' : 'bg-[#E5E5E5] text-[#ADADAD]'
            }`}
          >
            {saving ? '저장 중…' : '확인'}
          </button>
        </div>
      </div>

      {/* 10곳이 찼다 — 무엇이 지워지는지 이름을 대고 묻는다 */}
      {dropping && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-8"
             onClick={e => e.stopPropagation()}>
          <div className="w-full max-w-[320px] bg-white rounded-xl px-5 py-6">
            <h3 className="text-[16px] font-bold text-[#1E1E1E] leading-snug">
              주소는 10곳까지 저장할 수 있어요
            </h3>
            <p className="text-[13px] text-[#727272] mt-2 leading-relaxed">
              지금 추가하면 가장 먼저 등록한 주소가 없어져요.
            </p>
            <p className="text-[13px] font-semibold text-[#1E1E1E] mt-2 rounded-lg bg-[#F5F5F5] px-3 py-2 leading-snug">
              {dropping}
            </p>
            <p className="text-[13px] text-[#727272] mt-2">계속할까요?</p>
            <div className="flex gap-2 mt-5">
              <button onClick={() => setDropping(null)}
                      className="flex-1 h-[46px] rounded-xl bg-[#F2F2F2] text-[#727272] font-bold text-[14px]">
                아니요
              </button>
              <button onClick={() => { setDropping(null); save(true) }}
                      className="flex-1 h-[46px] rounded-xl bg-ink text-white font-bold text-[14px]">
                네
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
