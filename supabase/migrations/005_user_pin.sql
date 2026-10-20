-- ====================================================
-- 사용자 PIN — 카카오 계정에 종속된 개인 4자리 PIN
-- PIN은 AES-256으로 암호화 저장 (복호화 가능, PIN 찾기 기능용)
-- ====================================================

ALTER TABLE sunpos_users
  ADD COLUMN IF NOT EXISTS pin_encrypted    TEXT,          -- AES-256 암호화된 4자리 PIN
  ADD COLUMN IF NOT EXISTS pin_attempts     SMALLINT NOT NULL DEFAULT 0,  -- 연속 실패 횟수
  ADD COLUMN IF NOT EXISTS pin_locked_until TIMESTAMPTZ;  -- NULL = 잠금 없음
