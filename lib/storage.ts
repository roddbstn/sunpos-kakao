/**
 * 스토리지 URL 해석기 — 현재 Supabase Storage 사용.
 * S3 / R2 / 기타 스토리지로 교체 시 이 파일의 return 문만 수정하면 됩니다.
 */
export function getStoreImageUrl(path: string | null | undefined): string | null {
  if (!path) return null
  // ── Supabase Storage (현재) ──
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL
  return `${base}/storage/v1/object/public/store-covers/${path}`
  // ── AWS S3로 교체 시 ──
  // return `https://my-bucket.s3.ap-northeast-2.amazonaws.com/store-covers/${path}`
  // ── Cloudflare R2로 교체 시 ──
  // return `https://pub-xxxx.r2.dev/store-covers/${path}`
}
