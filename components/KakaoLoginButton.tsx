'use client'

interface Props {
  onClick: () => void
  loading?: boolean
}

export default function KakaoLoginButton({ onClick, loading }: Props) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="w-full flex items-center justify-center gap-3 py-4 rounded-2xl font-bold text-[16px] text-[#3C1E1E] disabled:opacity-60 transition-opacity active:opacity-70"
      style={{ backgroundColor: '#FEE500' }}
    >
      {/* 카카오 말풍선 아이콘 */}
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
        <path
          d="M11 2C6.03 2 2 5.19 2 9.13c0 2.53 1.67 4.75 4.18 6.04l-.87 3.23a.3.3 0 0 0 .44.33l3.87-2.55A10.7 10.7 0 0 0 11 16.27c4.97 0 9-3.19 9-7.14S15.97 2 11 2Z"
          fill="#3C1E1E"
        />
      </svg>
      {loading ? '로그인 중...' : '카카오로 계속하기'}
    </button>
  )
}
