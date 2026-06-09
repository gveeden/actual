export type SyncServerTrueLayerAccount = {
  account_id: string;
  name: string;
  official_name?: string;
  mask: string;
  institution: string | { name: string; id?: string };
  balance?: number;
};
