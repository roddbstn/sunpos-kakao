-- sunpos_users에 phone, affiliation 컬럼 추가
-- phone은 profile-setup에서 이미 사용 중 (DB에 있을 수 있으나 migration 누락)
-- affiliation: 소속 기관/부서 (선택 입력)

ALTER TABLE sunpos_users
  ADD COLUMN IF NOT EXISTS phone       TEXT,
  ADD COLUMN IF NOT EXISTS affiliation TEXT;

-- upsert_sunpos_user RPC에 phone, affiliation 반영
CREATE OR REPLACE FUNCTION upsert_sunpos_user(
  p_kakao_id      TEXT,
  p_nickname      TEXT,
  p_profile_image TEXT    DEFAULT NULL,
  p_phone         TEXT    DEFAULT NULL,
  p_affiliation   TEXT    DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO sunpos_users (id, kakao_id, nickname, profile_image, phone, affiliation, updated_at)
  VALUES (auth.uid(), p_kakao_id, p_nickname, p_profile_image, p_phone, p_affiliation, now())
  ON CONFLICT (id) DO UPDATE
    SET nickname      = EXCLUDED.nickname,
        profile_image = EXCLUDED.profile_image,
        phone         = COALESCE(EXCLUDED.phone, sunpos_users.phone),
        affiliation   = COALESCE(EXCLUDED.affiliation, sunpos_users.affiliation),
        updated_at    = now();
END;
$$;

-- 본인정보 저장 전용 RPC (profile-setup 화면에서 호출)
CREATE OR REPLACE FUNCTION update_sunpos_profile(
  p_nickname    TEXT,
  p_phone       TEXT,
  p_affiliation TEXT DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE sunpos_users
  SET nickname    = p_nickname,
      phone       = p_phone,
      affiliation = p_affiliation,
      updated_at  = now()
  WHERE id = auth.uid();
END;
$$;
