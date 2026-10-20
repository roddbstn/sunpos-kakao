-- ====================================================
-- 카드 시스템 — 물리 카드 기반 QR 주문 인증
-- ====================================================

-- 1. 카드 테이블
--    card_number: 8자리 (매장코드 3 + 순번 4 + 체크섬 1), 예: "00100017"
CREATE TABLE IF NOT EXISTS cards (
  card_id     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  card_number CHAR(8)     NOT NULL UNIQUE,
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. 카드 등록 테이블
--    카드 1개가 여러 매장에 등록 가능 (크로스 매장)
--    단, 한 매장 내에서 카드는 하나의 거래처에만 연결
CREATE TABLE IF NOT EXISTS card_registrations (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id      UUID        NOT NULL REFERENCES cards(card_id) ON DELETE CASCADE,
  store_id     UUID        NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  account_code TEXT        NOT NULL REFERENCES accounts(account_code) ON DELETE CASCADE,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(card_id, store_id)  -- 매장당 카드 1개 = 거래처 1개
);

-- 3. QR 세션 테이블
--    카드 QR 스캔 시 발급되는 일회용 토큰 (HMAC-SHA256, 5분 TTL)
--    consumed_at: PIN 인증 완료 시각
CREATE TABLE IF NOT EXISTS qr_sessions (
  token       VARCHAR(64) PRIMARY KEY,
  card_id     UUID        NOT NULL REFERENCES cards(card_id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,           -- NULL = 아직 미사용
  is_active   BOOLEAN     NOT NULL DEFAULT true
);

-- 4. 인덱스
CREATE INDEX IF NOT EXISTS idx_card_registrations_card_id  ON card_registrations(card_id);
CREATE INDEX IF NOT EXISTS idx_card_registrations_store_id ON card_registrations(store_id);
CREATE INDEX IF NOT EXISTS idx_qr_sessions_card_id         ON qr_sessions(card_id);
CREATE INDEX IF NOT EXISTS idx_qr_sessions_expires_at      ON qr_sessions(expires_at);

-- 5. RLS
ALTER TABLE cards             ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE qr_sessions       ENABLE ROW LEVEL SECURITY;

-- cards: anon 읽기 허용 (QR 검증 시 필요)
CREATE POLICY "cards_anon_read" ON cards
  FOR SELECT USING (true);

-- card_registrations: anon 읽기 허용 (매장 목록 조회 시 필요)
CREATE POLICY "card_registrations_anon_read" ON card_registrations
  FOR SELECT USING (true);

-- qr_sessions: anon insert + 본인 read
CREATE POLICY "qr_sessions_anon_insert" ON qr_sessions
  FOR INSERT WITH CHECK (true);

CREATE POLICY "qr_sessions_anon_read" ON qr_sessions
  FOR SELECT USING (true);
