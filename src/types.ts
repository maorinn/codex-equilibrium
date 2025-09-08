export type TokenRecord = {
  id: string;
  // discriminator: oauth (default) or relay
  type?: 'oauth' | 'relay';
  // oauth fields
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  account_id?: string;
  email?: string;
  // relay fields
  name?: string;
  base_url?: string;
  api_key?: string;
  // common
  expire?: string;
  created_at?: string;
  last_refresh?: string;
  last_used?: string;
  // health/meta
  disabled?: boolean;
  cooldown_until?: string;
  fail_count?: number;
  last_error_code?: number;
};
