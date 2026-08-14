// ddrive v4 — Auth store (Zustand)

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
  ark: CryptoKey | null;
  filesKey: CryptoKey | null;

  setAuth: (token: string, user: PersistedUser, ark?: CryptoKey | null, filesKey?: CryptoKey | null) => void;
  setKeys: (ark: CryptoKey, filesKey: CryptoKey) => void;
  setUser: (user: PersistedUser) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      ark: null,
      filesKey: null,

      setAuth: (token, user, ark, filesKey) => set({ token, user, ark: ark ?? null, filesKey: filesKey ?? null }),
      setKeys: (ark, filesKey) => set({ ark, filesKey }),
      setUser: (user) => set({ user }),
      logout: () => set({ token: null, user: null, ark: null, filesKey: null }),
    }),
    {
      name: "ddv4-auth",
      partialize: (state) => ({ token: state.token, user: state.user }),
    },
  ),
);
