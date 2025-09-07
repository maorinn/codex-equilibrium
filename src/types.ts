export type TokenRecord = {
  id: string;
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  account_id?: string;
  email?: string;
  expire?: string;
  created_at?: string;
  last_refresh?: string;
  // health/meta
  disabled?: boolean;
  cooldown_until?: string;
  fail_count?: number;
  last_error_code?: number;
  last_used?: string;
};

