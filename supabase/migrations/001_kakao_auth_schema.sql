-- ====================================================
-- 카카오 OAuth 전환 마이그레이션
-- 실행 순서: 이 파일 → 002_kakao_rpc_functions.sql
-- ====================================================

-- 1. accounts.pin_code nullable 처리 (기존 PIN 데이터 보존)
ALTER TABLE accounts ALTER COLUMN pin_code DROP NOT NULL;

-- 2. 선포스 사용자 테이블 (auth.users와 1:1)
CREATE TABLE IF NOT EXISTS sunpos_users (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  kakao_id      TEXT UNIQUE NOT NULL,
  nickname      TEXT NOT NULL DEFAULT '',
  profile_image TEXT,
  created_at    TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at    TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- 3. 사용자 ↔ 거래처 연결 테이블
CREATE TABLE IF NOT EXISTS user_account_links (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_code TEXT NOT NULL REFERENCES accounts(account_code) ON DELETE CASCADE,
  store_id     UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('개인', '담당자', '일반멤버')),
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'approved', 'rejected')),
  org_name     TEXT,
  approved_by  UUID REFERENCES auth.users(id),
  approved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT now() NOT NULL,
  UNIQUE(user_id, account_code)
);

-- 4. RLS
ALTER TABLE sunpos_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_account_links ENABLE ROW LEVEL SECURITY;

-- sunpos_users: 본인만 조회/수정
CREATE POLICY "sunpos_users_own" ON sunpos_users
  FOR ALL USING (auth.uid() = id);

-- user_account_links: 본인 링크 전체 접근
CREATE POLICY "ual_own" ON user_account_links
  FOR ALL USING (auth.uid() = user_id);

-- 5. Realtime 활성화 (승인 대기 폴링용)
ALTER PUBLICATION supabase_realtime ADD TABLE user_account_links;
