-- user_invite_complete: SELECT-then-INSERT/UPDATE 패턴이 동시 호출(더블클릭/재시도) 시
-- 레이스 윈도우를 만들어 "duplicate key value violates unique constraint
-- user_account_links_user_id_account_code_key" 에러를 유발했음.
-- INSERT ... ON CONFLICT 로 원자적 upsert 처리해서 레이스를 근본적으로 제거.
--
-- 주의: ON CONFLICT (user_id, account_code) 형태로 컬럼명을 직접 나열하면
-- 함수의 OUT 파라미터 account_code와 충돌(ambiguous column reference)한다 —
-- 제약조건 이름(ON CONSTRAINT)으로 지정해서 회피.
CREATE OR REPLACE FUNCTION public.user_invite_complete(p_token text)
RETURNS TABLE(account_code uuid, account_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_link     user_invite_links;
  v_account  accounts;
  v_link_id  uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '로그인이 필요해요';
  END IF;

  SELECT * INTO v_link FROM user_invite_links WHERE user_invite_links.token = p_token;
  IF v_link IS NULL OR v_link.revoked_at IS NOT NULL OR v_link.expires_at < now() THEN
    RAISE EXCEPTION '유효하지 않은 초대링크예요';
  END IF;

  SELECT * INTO v_account FROM accounts WHERE accounts.account_code = v_link.account_code;
  IF v_account IS NULL OR v_account.is_active = false THEN
    RAISE EXCEPTION '더 이상 유효하지 않은 거래처예요';
  END IF;

  INSERT INTO user_account_links (user_id, account_code, store_id, role, status, approved_at)
  VALUES (auth.uid(), v_link.account_code, v_account.store_id, '이용자', 'approved', now())
  ON CONFLICT ON CONSTRAINT user_account_links_user_id_account_code_key
  DO UPDATE SET status = 'approved', approved_at = now()
  RETURNING id INTO v_link_id;

  INSERT INTO user_account_link_status_history (link_id, status, changed_by)
  VALUES (v_link_id, 'approved', auth.uid());

  RETURN QUERY SELECT v_account.account_code, v_account.account_name;
END;
$function$;
