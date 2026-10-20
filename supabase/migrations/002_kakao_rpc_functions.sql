-- ====================================================
-- 카카오 OAuth 전환 RPC 함수 모음
-- ====================================================

-- 1. 카카오 로그인 후 사용자 upsert
CREATE OR REPLACE FUNCTION upsert_sunpos_user(
  p_kakao_id      TEXT,
  p_nickname      TEXT,
  p_profile_image TEXT DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO sunpos_users (id, kakao_id, nickname, profile_image, updated_at)
  VALUES (auth.uid(), p_kakao_id, p_nickname, p_profile_image, now())
  ON CONFLICT (id) DO UPDATE
    SET nickname      = EXCLUDED.nickname,
        profile_image = EXCLUDED.profile_image,
        updated_at    = now();
END;
$$;

-- 2. 사용자의 특정 매장 링크 목록 조회
CREATE OR REPLACE FUNCTION get_user_store_links(p_store_id UUID)
RETURNS TABLE(
  link_id         UUID,
  account_code    TEXT,
  account_name    TEXT,
  role            TEXT,
  status          TEXT,
  org_name        TEXT,
  current_balance BIGINT
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT
    ual.id,
    ual.account_code,
    a.account_name,
    ual.role,
    ual.status,
    ual.org_name,
    a.current_balance
  FROM user_account_links ual
  JOIN accounts a ON a.account_code = ual.account_code
  WHERE ual.user_id = auth.uid()
    AND ual.store_id = p_store_id;
END;
$$;

-- 3. 개인 거래처 자동 생성/조회
CREATE OR REPLACE FUNCTION get_or_create_personal_account(
  p_store_id UUID,
  p_nickname TEXT
) RETURNS TABLE(
  link_id         UUID,
  account_code    TEXT,
  account_name    TEXT,
  current_balance BIGINT
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_account_code TEXT;
  v_link_id      UUID;
BEGIN
  -- 이미 개인 링크가 있는지 확인
  SELECT ual.id, ual.account_code
  INTO v_link_id, v_account_code
  FROM user_account_links ual
  WHERE ual.user_id   = auth.uid()
    AND ual.store_id  = p_store_id
    AND ual.role      = '개인'
  LIMIT 1;

  IF v_link_id IS NOT NULL THEN
    RETURN QUERY
    SELECT v_link_id, a.account_code, a.account_name, a.current_balance
    FROM accounts a
    WHERE a.account_code = v_account_code;
    RETURN;
  END IF;

  -- 신규 개인 거래처 생성
  INSERT INTO accounts (account_name, account_type, current_balance, store_id, is_active, warning_threshold)
  VALUES (p_nickname, '개인', 0, p_store_id, true, 30000)
  RETURNING account_code INTO v_account_code;

  -- 링크 생성 (개인은 즉시 승인)
  INSERT INTO user_account_links (user_id, account_code, store_id, role, status)
  VALUES (auth.uid(), v_account_code, p_store_id, '개인', 'approved')
  RETURNING id INTO v_link_id;

  RETURN QUERY
  SELECT v_link_id, a.account_code, a.account_name, a.current_balance
  FROM accounts a
  WHERE a.account_code = v_account_code;
END;
$$;

-- 4. 조직 거래처 가입 요청
-- 반환: link_id (NULL이면 에러), account_code, status, message
CREATE OR REPLACE FUNCTION request_org_membership(
  p_store_id UUID,
  p_org_name TEXT,
  p_role     TEXT   -- '담당자' | '일반멤버'
) RETURNS TABLE(
  link_id      UUID,
  account_code TEXT,
  status       TEXT,
  message      TEXT
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_account_code TEXT;
  v_link_id      UUID;
BEGIN
  -- 이미 같은 조직 링크가 있는지 확인
  SELECT ual.id INTO v_link_id
  FROM user_account_links ual
  JOIN accounts a ON a.account_code = ual.account_code
  WHERE ual.user_id       = auth.uid()
    AND ual.store_id      = p_store_id
    AND a.organization_name = p_org_name;

  IF v_link_id IS NOT NULL THEN
    RETURN QUERY SELECT v_link_id, NULL::TEXT, 'already_linked'::TEXT, '이미 이 조직에 연결되어 있어요.'::TEXT;
    RETURN;
  END IF;

  -- 같은 이름의 조직 거래처 조회 (해당 매장 내)
  SELECT a.account_code INTO v_account_code
  FROM accounts a
  WHERE a.store_id          = p_store_id
    AND a.organization_name = p_org_name
    AND a.account_type      IN ('과', '기업')
    AND a.is_active         = true
  LIMIT 1;

  IF p_role = '담당자' THEN
    -- 조직이 없으면 신규 거래처 생성
    IF v_account_code IS NULL THEN
      INSERT INTO accounts (account_name, organization_name, account_type, current_balance, store_id, is_active, warning_threshold)
      VALUES (p_org_name, p_org_name, '과', 0, p_store_id, true, 30000)
      RETURNING account_code INTO v_account_code;
    END IF;

    INSERT INTO user_account_links (user_id, account_code, store_id, role, status, org_name)
    VALUES (auth.uid(), v_account_code, p_store_id, '담당자', 'pending', p_org_name)
    RETURNING id INTO v_link_id;

    RETURN QUERY SELECT v_link_id, v_account_code, 'pending'::TEXT, '점주 확인 후 이용 가능합니다.'::TEXT;

  ELSIF p_role = '일반멤버' THEN
    -- 조직이 없으면 에러
    IF v_account_code IS NULL THEN
      RETURN QUERY SELECT NULL::UUID, NULL::TEXT, 'org_not_found'::TEXT, '해당 조직이 아직 등록되지 않았어요. 담당자에게 먼저 등록을 요청해주세요.'::TEXT;
      RETURN;
    END IF;

    INSERT INTO user_account_links (user_id, account_code, store_id, role, status, org_name)
    VALUES (auth.uid(), v_account_code, p_store_id, '일반멤버', 'pending', p_org_name)
    ON CONFLICT (user_id, account_code) DO NOTHING
    RETURNING id INTO v_link_id;

    IF v_link_id IS NULL THEN
      RETURN QUERY SELECT NULL::UUID, NULL::TEXT, 'already_linked'::TEXT, '이미 이 조직에 연결되어 있어요.'::TEXT;
      RETURN;
    END IF;

    RETURN QUERY SELECT v_link_id, v_account_code, 'pending'::TEXT, '담당자 승인 후 이용 가능합니다.'::TEXT;
  END IF;
END;
$$;
