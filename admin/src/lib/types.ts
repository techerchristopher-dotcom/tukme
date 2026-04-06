export type ApiError = { message: string };
export type ApiOk<T> = { data: T; error: null };
export type ApiErr = { data: null; error: ApiError };
export type ApiResult<T> = ApiOk<T> | ApiErr;

export type Paginated<T> = {
  items: T[];
  count: number;
  limit: number;
  offset: number;
};

export type PlatformDailySummary = {
  business_date: string; // YYYY-MM-DD
  total_rides: number;
  gross_fares_ariary: number;
  total_platform_commission_ariary: number;
  total_driver_gross_ariary: number;
  total_daily_rents_due_ariary: number;
  total_payouts_ariary: number;
  drivers_with_positive_balance_count: number;
  drivers_with_negative_balance_count: number;
  drivers_with_zero_balance_count: number;
  drivers_with_rent_missing_count: number;
  non_finalized_completed_rides_count: number;
};

export type RideStatus = 'completed';

/** Filtre liste chauffeurs (compte soft-delete). */
export type DriverAccountListFilter = 'active' | 'inactive' | 'all';

export type DriverDailySummaryRow = {
  business_date: string; // YYYY-MM-DD
  driver_id: string;
  full_name: string | null;
  phone: string | null;
  /** Présent si désactivé (soft-delete). */
  deleted_at?: string | null;
  rides_count: number;
  gross_fares_ariary: number;
  platform_commission_ariary: number;
  driver_gross_ariary: number;
  daily_rent_due_ariary: number;
  payouts_done_ariary: number;
  current_balance_ariary: number;
  net_payable_today_ariary: number;
  rent_expected: boolean;
  rent_missing: boolean;
  current_vehicle_id: string | null;
  current_vehicle_owner_type: 'platform' | 'driver' | null;
  current_daily_rent_ariary: number | null;
};

export type CompletedRideRow = {
  ride_id: string;
  ride_completed_at: string | null;
  status: RideStatus;
  is_financials_finalized: boolean;
  client_id: string;
  driver_id: string | null;
  driver_full_name: string | null;
  driver_phone: string | null;
  fare_total_ariary: number | null;
  platform_commission_rate_bps: number;
  platform_commission_ariary: number | null;
  driver_gross_ariary: number | null;
  vehicle_id: string | null;
  vehicle_owner_type: 'platform' | 'driver' | null;
  vehicle_kind: string | null;
  vehicle_plate_number: string | null;
};

export type PayoutMethod = 'cash' | 'orange_money';
export type PayoutStatus = 'recorded' | 'sent' | 'confirmed' | 'cancelled';

export type PayoutRow = {
  payout_id: string;
  created_at: string;
  paid_at: string | null;
  status: PayoutStatus;
  method: PayoutMethod;
  amount_ariary: number;
  reference: string | null;
  notes: string | null;
  driver_id: string;
  driver_full_name: string | null;
  driver_phone: string | null;
};

export type CreateDriverPayoutInput = {
  driver_id: string;
  amount_ariary: number;
  method: PayoutMethod;
  reference?: string | null;
  notes?: string | null;
};

export type CreateDriverPayoutResponse = {
  payout_id: string;
};

export type CreateDriverInput = {
  first_name: string;
  last_name: string;
  phone: string;
  vehicle_plate: string;
};

export type CreateDriverResponse = {
  driver_id: string;
};

export type DeactivateDriverResponse = {
  ok: boolean;
};

export type RentStatus = 'due' | 'paid' | 'waived';

export type DailyRentRow = {
  daily_rent_id: string;
  created_at: string;
  business_date: string;
  status: RentStatus;
  rent_ariary: number;
  notes: string | null;
  driver_id: string;
  driver_full_name: string | null;
  driver_phone: string | null;
  vehicle_id: string;
  vehicle_owner_type: 'platform' | 'driver';
  vehicle_kind: string | null;
  vehicle_plate_number: string | null;
};

export type DriverBalanceRow = {
  driver_id: string;
  total_credits_ariary: number;
  total_debits_ariary: number;
  driver_balance_ariary: number;
};

export type DriverProfileRow = {
  id: string;
  full_name: string | null;
  phone: string | null;
  email?: string | null;
  role?: string | null;
  created_at?: string | null;
  /** Si présent : chauffeur désactivé (soft-delete), hors listes opérationnelles. */
  deleted_at?: string | null;
};

export type DriverDetailResponse = {
  driver: DriverProfileRow;
  balance: DriverBalanceRow;
  today: DriverDailySummaryRow | null;
  rides: Paginated<CompletedRideRow>;
  payouts: Paginated<PayoutRow>;
  rents: Paginated<DailyRentRow>;
};

