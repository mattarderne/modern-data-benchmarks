export type Organization = {
  id: string;
  name: string;
  created_at: string;
};

export type User = {
  id: string;
  organization_id: string;
  stripe_customer_id: string;
  email: string;
  role: 'admin' | 'member' | 'viewer';
  created_at: string;
  last_login_at: string;
};

export type ApiUsage = {
  id: string;
  user_id: string;
  model: string;
  tokens: number;
  latency_ms: number;
  created_at: string;
};

export type ChatSession = {
  id: string;
  user_id: string;
  model: string;
  message_count: number;
  duration_seconds: number;
  created_at: string;
};

export type FeatureFlag = {
  id: string;
  key: string;
  enabled: boolean;
  created_at: string;
};
