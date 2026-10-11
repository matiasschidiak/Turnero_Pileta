// Elige el backend: Supabase si está configurado, o el modo demo (datos en
// este navegador) si no. Las dos implementaciones exponen las mismas funciones.
import { CONFIG } from './config.js';

export const DEMO = !CONFIG.supabaseUrl || !CONFIG.supabaseAnonKey;

export const api = DEMO
  ? (await import('./api-demo.js')).api
  : (await import('./api-supabase.js')).api;
