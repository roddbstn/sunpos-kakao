-- ====================================================
-- 카드 시스템 RPC 함수 9개
-- ====================================================

-- ────────────────────────────────────────────────────
-- 1. verify_qr_token
--    QR 스캔 후 토큰 유효성 검증
--    반환: { valid, card_id, reason }
-- ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION verify_qr_token(p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_session qr_sessions%ROWTYPE;
  v_card    cards%ROWTYPE;
BEGIN
  SELECT * INTO v_session FROM qr_sessions WHERE token = p_token;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'token_not_found');
  END IF;

  IF v_session.consumed_at IS NOT NULL THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'token_already_used');
  END IF;

  IF now() > v_session.expires_at THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'token_expired');
  END IF;

  IF NOT v_session.is_active THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'token_inactive');
  END IF;

  SELECT * INTO v_card FROM cards WHERE card_id = v_session.card_id;

  IF NOT v_card.is_active THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'card_deactivated');
  END IF;

  RETURN jsonb_build_object(
    'valid',   true,
    'card_id', v_session.card_id::TEXT,
    'reason',  null
  );
END;
$$;

-- ────────────────────────────────────────────────────
-- 2. consume_qr_token
--    PIN 인증 완료 후 토큰 소비 처리
--    반환: { success }
-- ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION consume_qr_token(p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_verify JSONB;
BEGIN
  v_verify := verify_qr_token(p_token);

  IF NOT (v_verify->>'valid')::BOOLEAN THEN
    RETURN jsonb_build_object('success', false, 'reason', v_verify->>'reason');
  END IF;

  UPDATE qr_sessions
  SET consumed_at = now()
  WHERE token = p_token;

  RETURN jsonb_build_object('success', true);
END;
$$;

-- ────────────────────────────────────────────────────
-- 3. check_card_active
--    주문 흐름 중 카드 활성 여부 재확인 (각 라우트 진입 시)
--    반환: { active }
-- ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION check_card_active(p_card_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_active BOOLEAN;
BEGIN
  SELECT is_active INTO v_active FROM cards WHERE card_id = p_card_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('active', false, 'reason', 'card_not_found');
  END IF;

  RETURN jsonb_build_object('active', v_active);
END;
$$;

-- ────────────────────────────────────────────────────
-- 4. get_card_stores
--    카드에 등록된 매장 목록 반환 (홈화면 내 등록 매장 섹션)
--    반환: [{ store_id, store_name, account_code, account_name, balance, registered_at }]
-- ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_card_stores(p_card_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_result JSONB;
BEGIN
  SELECT jsonb_agg(
    jsonb_build_object(
      'store_id',      s.id,
      'store_name',    s.name,
      'cover_image',   s.cover_image_path,
      'account_code',  cr.account_code,
      'account_name',  a.account_name,
      'balance',       a.current_balance,
      'registered_at', cr.registered_at
    ) ORDER BY cr.registered_at ASC
  )
  INTO v_result
  FROM card_registrations cr
  JOIN stores   s ON s.id = cr.store_id
  JOIN accounts a ON a.account_code = cr.account_code
  WHERE cr.card_id = p_card_id
    AND s.is_open  = true;  -- 영업 중인 매장만 (비활성 매장 제외)

  RETURN COALESCE(v_result, '[]'::JSONB);
END;
$$;

-- ────────────────────────────────────────────────────
-- 5. get_nearby_stores
--    "이런 곳도 있어요" — 등록되지 않은 주변 가맹점 조회
--    Haversine 공식으로 거리 계산, 10km 이내, LIMIT 20
--    반환: [{ store_id, store_name, distance_m, cover_image }]
-- ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_nearby_stores(
  p_ref_lat          FLOAT,
  p_ref_lng          FLOAT,
  p_exclude_store_ids UUID[]
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_result JSONB;
BEGIN
  SELECT jsonb_agg(
    jsonb_build_object(
      'store_id',    sub.id,
      'store_name',  sub.name,
      'distance_m',  ROUND(sub.distance_m::NUMERIC),
      'cover_image', sub.cover_image_path
    )
  )
  INTO v_result
  FROM (
    -- 서브쿼리로 거리 계산 후 필터링 (HAVING 오용 방지)
    SELECT * FROM (
      SELECT
        s.id,
        s.name,
        s.cover_image_path,
        -- Haversine 공식 (단위: 미터)
        6371000 * 2 * ASIN(
          SQRT(
            POWER(SIN(RADIANS(s.lat - p_ref_lat) / 2), 2)
            + COS(RADIANS(p_ref_lat)) * COS(RADIANS(s.lat))
            * POWER(SIN(RADIANS(s.lng - p_ref_lng) / 2), 2)
          )
        ) AS distance_m
      FROM stores s
      WHERE s.lat IS NOT NULL
        AND s.lng IS NOT NULL
        AND (p_exclude_store_ids IS NULL OR s.id != ALL(p_exclude_store_ids))
    ) dist
    WHERE dist.distance_m <= 10000  -- 10km 이내
    ORDER BY dist.distance_m ASC
    LIMIT 20
  ) sub;

  RETURN COALESCE(v_result, '[]'::JSONB);
END;
$$;

-- ────────────────────────────────────────────────────
-- 6. set_user_pin
--    최초 PIN 설정 / PIN 변경
--    p_pin_encrypted: 클라이언트에서 AES-256 암호화한 값
-- ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_user_pin(p_pin_encrypted TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE sunpos_users
  SET pin_encrypted    = p_pin_encrypted,
      pin_attempts     = 0,
      pin_locked_until = NULL,
      updated_at       = now()
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_not_found';
  END IF;
END;
$$;

-- ────────────────────────────────────────────────────
-- 7. verify_user_pin
--    PIN 입력 검증 + 잠금 로직
--    p_kakao_id: 로그인한 카카오 사용자 ID
--    p_pin_plain: 사용자가 입력한 평문 4자리
--    반환: { success, locked_until, attempts_left }
--    NOTE: 실제 PIN 복호화는 서버 API route에서 처리.
--          이 RPC는 시도 횟수와 잠금 상태만 관리.
-- ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION record_pin_attempt(
  p_kakao_id TEXT,
  p_success  BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user          sunpos_users%ROWTYPE;
  v_new_attempts  SMALLINT;
  v_locked_until  TIMESTAMPTZ;
BEGIN
  SELECT * INTO v_user
  FROM sunpos_users
  WHERE kakao_id = p_kakao_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'user_not_found');
  END IF;

  -- 잠금 중인지 확인
  IF v_user.pin_locked_until IS NOT NULL AND now() < v_user.pin_locked_until THEN
    RETURN jsonb_build_object(
      'success',      false,
      'reason',       'locked',
      'locked_until', v_user.pin_locked_until
    );
  END IF;

  IF p_success THEN
    -- 성공: 시도 횟수 리셋
    UPDATE sunpos_users
    SET pin_attempts = 0, pin_locked_until = NULL, updated_at = now()
    WHERE kakao_id = p_kakao_id;

    RETURN jsonb_build_object('success', true, 'attempts_left', 5);
  ELSE
    -- 실패: 시도 횟수 증가
    v_new_attempts := COALESCE(v_user.pin_attempts, 0) + 1;

    IF v_new_attempts >= 5 THEN
      v_locked_until := now() + INTERVAL '5 minutes';
      UPDATE sunpos_users
      SET pin_attempts     = v_new_attempts,
          pin_locked_until = v_locked_until,
          updated_at       = now()
      WHERE kakao_id = p_kakao_id;

      RETURN jsonb_build_object(
        'success',      false,
        'reason',       'locked',
        'locked_until', v_locked_until,
        'attempts_left', 0
      );
    ELSE
      UPDATE sunpos_users
      SET pin_attempts = v_new_attempts, updated_at = now()
      WHERE kakao_id = p_kakao_id;

      RETURN jsonb_build_object(
        'success',      false,
        'reason',       'wrong_pin',
        'attempts_left', 5 - v_new_attempts
      );
    END IF;
  END IF;
END;
$$;

-- ────────────────────────────────────────────────────
-- 8. get_encrypted_pin_by_identity
--    PIN 찾기 — 이름 + 전화번호로 본인 확인 후 암호화된 PIN 반환
--    복호화는 서버 API route에서 처리
--    반환: { found, pin_encrypted }
-- ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_encrypted_pin_by_identity(
  p_name  TEXT,
  p_phone TEXT
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_pin_encrypted TEXT;
BEGIN
  SELECT pin_encrypted INTO v_pin_encrypted
  FROM sunpos_users
  WHERE nickname = p_name
    AND phone    = p_phone
    AND id       = auth.uid();  -- 본인 세션에서만 조회 가능

  IF NOT FOUND OR v_pin_encrypted IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  RETURN jsonb_build_object('found', true, 'pin_encrypted', v_pin_encrypted);
END;
$$;

-- ────────────────────────────────────────────────────
-- 9. deactivate_card
--    카드 비활성화 (분실 대응)
--    + 해당 카드의 미소비 qr_sessions도 즉시 무효화
-- ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION deactivate_card(p_card_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- 카드 비활성화
  UPDATE cards
  SET is_active = false
  WHERE card_id = p_card_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'card_not_found';
  END IF;

  -- 미소비 세션 즉시 무효화
  UPDATE qr_sessions
  SET is_active = false
  WHERE card_id     = p_card_id
    AND consumed_at IS NULL
    AND expires_at  > now();
END;
$$;
