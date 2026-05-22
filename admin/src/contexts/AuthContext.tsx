import React, { useState, createContext, useContext, useCallback } from 'react';
import type { ReactNode } from 'react';
import { API_BASE, apiMessage, readApiResponse } from '../api/http';

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  is_super_admin: boolean;
  permissions: string[];
}

interface AuthContextType {
  isAuthenticated: boolean;
  user: AdminUser | null;
  token: string | null;
  isLoading: boolean;
  hasPermission: (path: string) => boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const TOKEN_KEY = 'admin_token';
const USER_KEY = 'admin_user';

function isTokenExpired(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return typeof payload.exp === 'number' && payload.exp * 1000 < Date.now();
  } catch {
    return true;
  }
}

function loadStoredSession(): { token: string | null; user: AdminUser | null } {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const raw = localStorage.getItem(USER_KEY);
    if (!token || !raw) return { token: null, user: null };
    if (isTokenExpired(token)) {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      return { token: null, user: null };
    }
    return { token, user: JSON.parse(raw) };
  } catch {
    return { token: null, user: null };
  }
}

const stored = loadStoredSession();

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(stored.token);
  const [user, setUser] = useState<AdminUser | null>(stored.user);
  const [isLoading, setIsLoading] = useState(false);

  const isAuthenticated = !!token && !!user;

  const hasPermission = useCallback((path: string): boolean => {
    if (!user) return false;
    if (user.is_super_admin) return true;
    return user.permissions.some(p => path === p || (p !== '/' && path.startsWith(p)));
  }, [user]);

  const logout = useCallback(() => {
    const currentToken = localStorage.getItem(TOKEN_KEY);
    if (currentToken) {
      fetch(`${API_BASE}/api/admin/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${currentToken}` },
        keepalive: true,
      }).catch(() => undefined);
    }
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setToken(null);
    setUser(null);
  }, []);

  const login = async (email: string, password: string) => {
    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/admin/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await readApiResponse<Record<string, any>>(res);
      if (!res.ok) throw new Error(apiMessage(data, 'Login failed'));
      localStorage.setItem(TOKEN_KEY, data.token);
      localStorage.setItem(USER_KEY, JSON.stringify(data.user));
      setToken(data.token);
      setUser(data.user);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthContext.Provider value={{ isAuthenticated, user, token, isLoading, hasPermission, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
