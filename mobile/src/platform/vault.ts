import * as SecureStore from 'expo-secure-store';
import type { Credentials, Vault } from '../core/client';
const key = 'fmo.credentials.v1';
export const vault: Vault = {
  async read() {
    const value = await SecureStore.getItemAsync(key);
    if (!value) return null;
    try { return JSON.parse(value) as Credentials; } catch { return null; }
  },
  async save(value) { await SecureStore.setItemAsync(key, JSON.stringify(value), { requireAuthentication: false }); },
  async clear() { await SecureStore.deleteItemAsync(key); },
};
