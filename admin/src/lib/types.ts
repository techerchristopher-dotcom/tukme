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
  current_vehicle: CurrentVehicle | null;
  rides: Paginated<CompletedRideRow>;
  payouts: Paginated<PayoutRow>;
  rents: Paginated<DailyRentRow>;
};

export type CurrentVehicle = {
  id: string;
  kind: string | null;
  plate_number: string | null;
  active: boolean | null;
};

// ---------------------------------------------------------------------------
// Driver debts (fleet manual)
// ---------------------------------------------------------------------------
export type DriverDebtSummaryItem = {
  driver_id: string;
  driver_name: string | null;
  driver_phone: string | null;
  open_entries_count: number;
  total_debt_ariary: number;
  fuel_debt_ariary: number;
  rent_debt_ariary: number;
  last_payment_at: string | null;
  current_vehicle_id: string | null;
  current_vehicle_label: string | null;
  current_assignment_id: string | null;
};

export type DriverDebtsSummaryResponse = {
  items: DriverDebtSummaryItem[];
};

export type DriverDebtDetailItem = {
  entry_id: string;
  driver_id: string;
  vehicle_id: string;
  vehicle_label: string | null;
  assignment_id: string | null;
  assignment_starts_at: string | null;
  assignment_ends_at: string | null;
  entry_date: string; // YYYY-MM-DD
  category: string;
  label: string | null;
  amount_ariary: number;
  total_paid_ariary: number;
  remaining_amount_ariary: number;
  payment_status: 'non payé' | 'partiel';
  last_payment_at: string | null;
  assignment_resolution_status: string | null;
  assignment_resolution_note: string | null;
};

export type DriverDebtDetailResponse = {
  driver_id: string;
  items: DriverDebtDetailItem[];
};

// ---------------------------------------------------------------------------
// Fleet manual module (Suivi du parc)
// ---------------------------------------------------------------------------
export type FleetVehicleStatus = 'active' | 'inactive' | 'sold' | 'retired';

export type FleetActiveAssignment = {
  driver_id: string;
  driver_full_name: string | null;
  driver_phone: string | null;
  starts_at: string;
  notes?: string | null;
} | null;

export type FleetVehicleListItem = {
  id: string;
  plate_number: string | null;
  brand: string | null;
  model: string | null;
  status: FleetVehicleStatus | string | null;
  purchase_price_ariary: number | null;
  purchase_date: string | null;
  amortization_months: number | null;
  target_resale_price_ariary: number | null;
  daily_rent_ariary: number | null;
  active_assignment: FleetActiveAssignment;
};

export type FleetVehicleCreateInput = {
  plate_number: string;
  brand?: string | null;
  model?: string | null;
  status?: FleetVehicleStatus;
  purchase_price_ariary?: number | null;
  purchase_date?: string | null; // YYYY-MM-DD
  amortization_months?: number | null;
  target_resale_price_ariary?: number | null;
  daily_rent_ariary?: number | null;
  notes?: string | null;

  // Fuel defaults (used as suggested reference values)
  fuel_ref_litres?: number | null;
  fuel_ref_km?: number | null;
};

export type FleetVehiclePatchInput = Partial<FleetVehicleCreateInput>;

export type FleetAssignmentHistoryRow = {
  id: string;
  driver_id: string;
  driver_full_name: string | null;
  driver_phone: string | null;
  starts_at: string;
  ends_at: string | null;
  notes: string | null;
  created_at: string;
};

export type FleetEntryRow = {
  id: string;
  entry_type: 'income' | 'expense';
  amount_ariary: number;
  odometer_km?: number | null;
  entry_date: string; // YYYY-MM-DD
  category: string;
  fuel_mode?: 'structured' | 'legacy' | null;
  label: string;
  notes: string | null;
  created_at: string;

  // Audit / lifecycle (soft delete)
  updated_at?: string;
  updated_by?: string | null;
  deleted_at?: string | null;
  deleted_by?: string | null;
  delete_reason?: string | null;

  // Fuel snapshot fields (for calculated "carburant" entries)
  fuel_km_start?: number | null;
  fuel_km_end?: number | null;
  fuel_km_travelled?: number | null;
  fuel_price_per_litre_ariary_used?: number | null;
  fuel_consumption_l_per_km_used?: number | null;
  fuel_due_ariary?: number | null;

  // Fuel recharge fields (for 'carburant' + 'expense')
  fuel_recharge_litres_used?: number | null;
  fuel_recharge_km_credited_used?: number | null;

  // Partial payment summary (computed server-side; only meaningful for 'carburant' + 'income')
  total_paid_ariary?: number | null;
  remaining_amount_ariary?: number | null;
  payment_status?: 'unpaid' | 'partial' | 'paid' | null;
};

export type FleetFinancialSummary = {
  vehicle_id: string;
  purchase_price_ariary: number | null;
  purchase_date: string | null;
  amortization_months: number | null;
  target_resale_price_ariary: number | null;
  daily_rent_ariary: number | null;
  total_income_ariary: number;
  total_expense_ariary: number;
  net_ariary: number;
  remaining_to_amortize_ariary: number | null;
  amortized_percent: number | null;
  estimated_payoff_date: string | null;
  /** Dette ouverte chauffeur (carburant income) calculée serveur. */
  driver_debt_ariary?: number;
  /** Nombre d’écritures carburant income avec remaining > 0. */
  driver_debt_open_entries_count?: number;
};

export type FleetVehicleDetailResponse = {
  fuel_summary?: {
    total_recharge_litres: number;
    total_recharge_km_credited: number;
    total_km_consumed: number;
    total_litres_consumed: number | null;
    litres_remaining: number | null;
    km_remaining: number;
    percent_remaining: number | null; // 0..100 (can be <0 if stock negative)
    avg_km_per_day_7d: number | null;
    last_recharge: {
      entry_id: string;
      entry_date: string;
      litres_added: number;
      km_credited: number;
      cost_ariary: number;
    } | null;
    last_km_end: {
      entry_id: string;
      entry_date: string;
      km_end: number;
    } | null;
    autonomy_status: 'confortable' | 'limite' | 'insuffisante';
  };
  open_fuel_income_debt?: {
    open_remaining_ariary: number;
    open_entries_count: number;
  } | null;
  vehicle: {
    id: string;
    plate_number: string;
    brand: string | null;
    model: string | null;
    status: FleetVehicleStatus | string;
    purchase_price_ariary: number | null;
    purchase_date: string | null;
    amortization_months: number | null;
    target_resale_price_ariary: number | null;
    daily_rent_ariary: number | null;
    notes: string | null;
    fuel_ref_litres?: number | null;
    fuel_ref_km?: number | null;
    created_at: string;
    updated_at: string;
  };
  active_assignment: FleetActiveAssignment;
  assignment_history: FleetAssignmentHistoryRow[];
  recent_entries: FleetEntryRow[];
  financial_summary: FleetFinancialSummary;
};

export type FleetEntryCreateInput = {
  entry_type: 'income' | 'expense';
  amount_ariary: number;
  odometer_km?: number | null;
  entry_date: string; // YYYY-MM-DD
  category: string;
  label: string;
  notes?: string | null;
  fuel_mode?: 'structured' | 'legacy' | null;

  // Fuel snapshot fields (for calculated "carburant" entries)
  fuel_km_start?: number | null;
  fuel_km_end?: number | null;
  fuel_km_travelled?: number | null;
  fuel_price_per_litre_ariary_used?: number | null;
  fuel_consumption_l_per_km_used?: number | null;
  fuel_due_ariary?: number | null;

  // Fuel recharge fields (for 'carburant' + 'expense')
  fuel_recharge_litres_used?: number | null;
  fuel_recharge_km_credited_used?: number | null;
};

export type FleetEntryPatchInput = Partial<{
  entry_type: 'income' | 'expense';
  amount_ariary: number;
  odometer_km: number | null;
  entry_date: string; // YYYY-MM-DD
  category: string;
  fuel_mode: 'structured' | 'legacy' | null;
  label: string;
  notes: string | null;

  // Fuel snapshot fields (for calculated "carburant" entries)
  fuel_km_start: number;
  fuel_km_end: number;
  fuel_price_per_litre_ariary_used: number;
  fuel_consumption_l_per_km_used: number;

  // Fuel recharge fields (for 'carburant' + 'expense')
  fuel_recharge_litres_used: number;
  fuel_recharge_km_credited_used: number;
}>;

export type FleetEntryPaymentRow = {
  id: string;
  entry_id: string;
  amount_ariary: number;
  paid_at: string;
  notes: string | null;
  created_at: string;
};

export type FleetVehicleOpenFuelIncomeDebtItem = {
  entry_id: string;
  entry_date: string;
  category: string;
  description: string;
  amount_ariary: number;
  total_paid_ariary: number;
  remaining_amount_ariary: number;
  payment_status: 'non payé' | 'partiel';
  is_legacy: boolean;
};

export type FleetVehicleOpenFuelIncomeDebtsResponse = {
  driver_debt_ariary: number;
  driver_debt_open_entries_count: number;
  items: FleetVehicleOpenFuelIncomeDebtItem[];
};

export type FleetAssignmentCreateInput = {
  driver_id: string;
  starts_at?: string | null; // ISO timestamp
  notes?: string | null;
};

