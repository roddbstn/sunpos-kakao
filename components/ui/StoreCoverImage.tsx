import { getStoreImageUrl } from '@/lib/storage'

interface Props {
  path?: string | null
  size?: number
}

/** 매장 대표 이미지. path가 없거나 로드 실패 시 "(준비중)" 텍스트 표시. */
export default function StoreCoverImage({ path, size = 64 }: Props) {
  const url = getStoreImageUrl(path)
  return (
    <div
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: 8,
        overflow: 'hidden',
        background: '#F2F2F2',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt="매장 대표 사진"
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
        />
      ) : (
        <span style={{ fontSize: 10, color: '#BBBBBB', textAlign: 'center', lineHeight: 1.3 }}>
          (준비중)
        </span>
      )}
    </div>
  )
}
