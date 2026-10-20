-- ====================================================
-- stores 테이블에 위치 정보 추가
-- 홈화면 "이런 곳도 있어요" 거리 계산에 사용
-- representative_name 컬럼은 이미 존재하므로 lat/lng만 추가
-- ====================================================

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS lat FLOAT,
  ADD COLUMN IF NOT EXISTS lng FLOAT;
