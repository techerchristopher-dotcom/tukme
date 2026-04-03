export type UserRole = 'client' | 'driver';

export type Profile = {
  id: string;
  role: UserRole | null;
  full_name: string | null;
  phone: string | null;
};

export function isCompleteRole(role: string | null | undefined): role is UserRole {
  return role === 'client' || role === 'driver';
}
