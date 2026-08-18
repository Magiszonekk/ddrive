// ddrive — Auth store (Zustand)
//
// Post-E2EE-removal: a session is just a JWT + user record. No client-held
// crypto keys (no ARK, no filesKey) — see docs/hermes/concept.md.

import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface PersistedUser {
  id: string;
  email: string;
  username: string | null;
}

interface AuthState {
  token: string | null;
  user: PersistedUser | null;

  setAuth: (token: string, user: PersistedUser) => void;
  setUser: (user: PersistedUser) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,

      setAuth: (token, user) => set({ token, user }),
      setUser: (user) => set({ user }),
      logout: () => set({ token: null, user: null }),
    }),
    {
      name: "ddv4-auth",
      partialize: (state) => ({ token: state.token, user: state.user }),
    },
  ),
);
