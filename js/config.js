// Configuración de la app.
//
// Completá supabaseUrl y supabaseAnonKey con los datos de tu proyecto
// (Supabase → Project Settings → API). La clave "anon" / "publishable" es
// pública por diseño: la seguridad la dan los permisos de la base de datos.
//
// Si los dejás vacíos, la app funciona en MODO DEMO: los datos se guardan
// solo en este navegador. Sirve para probarla, no para usarla de verdad.
export const CONFIG = {
  supabaseUrl: 'https://byigafutnpmjpflnjdvz.supabase.co',
  supabaseAnonKey: 'sb_publishable_vpITq_ggp-GGHIwwUe0CKQ_R85mgUaY',

  nombreComplejo: 'Pileta libre',
  // Se muestra debajo del título grande de la página de reservas.
  subtitulo: 'Elegí el día y el horario. Cada reserva es individual y ocupa un lugar.',
};
