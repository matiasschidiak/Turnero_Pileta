# Turnero de pileta libre

Aplicación web para reservar turnos de pileta libre. Cada reserva es individual
(una persona, un lugar) y la capacidad de cada horario la define el personal
desde un panel protegido.

- **Página pública** (`index.html`): días disponibles, horarios con lugares
  disponibles en vivo y formulario de reserva (nombre, apellido y documento).
- **Panel** (`admin.html`): turnos del día con capacidad, ocupación y estado;
  lista de anotados; búsqueda por nombre, apellido o documento; cancelación con
  confirmación; horario semanal; días cerrados (feriados, mantenimiento, etc.).

## Cómo funcionan los horarios

- **Horario semanal:** se carga una sola vez y se repite todas las semanas. Lo que
  cargues para el lunes vale para todos los lunes, sin tener que generar nada:
  los turnos de cada fecha se crean solos cuando alguien la consulta.
- **Cambios en el horario semanal:** se aplican a todas las fechas futuras. La
  capacidad nunca baja de las reservas que ya hay.
- **Cambios para un día puntual:** en **Turnos del día** se puede cambiar la
  capacidad de un horario, cerrarlo o quitarlo solo para esa fecha. Ese día queda
  marcado como «Modificado este día» y el horario semanal ya no lo pisa. Con el
  botón de deshacer vuelve a seguir el horario semanal.
- **Días cerrados:** en **Días cerrados** (o con «Cerrar este día») se cierra una
  fecha o un rango de fechas con un motivo, que se muestra en la página pública.
  Se puede elegir si se cancelan las reservas que ya había. Al reabrir el día
  vuelven sus horarios normales.

Es una página estática (HTML, CSS y JavaScript, sin compilar) que se puede
publicar en GitHub Pages. Los datos se guardan en [Supabase](https://supabase.com)
(base de datos Postgres gratuita para este volumen).

## Estructura

```
index.html            Página de reservas
admin.html            Panel de administración
css/styles.css        Estilos (claro y oscuro, adaptados a celular)
js/config.js          ← Acá van la URL y la clave de Supabase
js/public.js          Lógica de la página de reservas
js/admin.js           Lógica del panel
js/api-supabase.js    Conexión con Supabase
js/api-demo.js        Modo demo (datos en el navegador)
js/utils.js           Validaciones, fechas y mensajes
supabase/schema.sql   Base de datos: tablas, reglas y permisos
tests/                Pruebas de la base de datos
```

## Probarla sin configurar nada (modo demo)

Si `js/config.js` no tiene los datos de Supabase, la app funciona en **modo demo**:
viene con horarios y reservas de ejemplo que se guardan solo en tu navegador. El
panel acepta cualquier email y contraseña.

Para abrirla hace falta un servidor local (los módulos de JavaScript no funcionan
abriendo el archivo con doble clic). Desde la carpeta del proyecto:

```bash
python -m http.server 5500
```

Después abrí <http://localhost:5500> y <http://localhost:5500/admin.html>.

## Puesta en marcha con Supabase

1. **Crear el proyecto.** En supabase.com creá una cuenta y un proyecto nuevo
   (para Argentina conviene la región São Paulo).

2. **Crear la base de datos.** En el proyecto, andá a **SQL Editor → New query**,
   pegá todo el contenido de `supabase/schema.sql` y apretá **Run**. Se puede
   volver a ejecutar más adelante (por ejemplo, si actualizás el archivo) sin
   perder datos.

3. **Crear el usuario del personal.**
   - En **Authentication → Sign In / Providers**, desactivá *Allow new users to
     sign up*, para que nadie pueda crearse una cuenta por su cuenta.
   - En **Authentication → Users → Add user → Create new user**, cargá el email y
     una contraseña, con *Auto Confirm User* activado.
   - En el **SQL Editor**, autorizalo a usar el panel (cambiá el email):

     ```sql
     insert into public.admins (user_id)
     select id from auth.users where email = 'personal@tu-complejo.com';
     ```

   Repetí este paso para cada persona que tenga que usar el panel.

4. **Conectar la página.** En **Project Settings → API** (o **API Keys**) copiá la
   *Project URL* y la clave *anon* / *publishable* y pegalas en `js/config.js`.
   Esa clave es pública por diseño: lo que protege los datos son los permisos de
   la base de datos. **Nunca** pongas la clave *service_role* / *secret* en la página.

5. **Cargar los horarios.** Entrá a `admin.html`, iniciá sesión y en
   **Horario semanal**:
   - Usá **Carga rápida** para cargar los horarios de la semana (por ejemplo, de
     lunes a viernes de 8 a 21, turnos de 60 minutos, 20 personas). Después podés
     ajustar cada horario con el lápiz o agregar sueltos con el «+» de cada día.
   - Ajustá **Reservas anticipadas** (cuántos días antes se puede reservar).
   - Cargá los feriados que ya conozcas en **Días cerrados**.

## Publicar en GitHub Pages con dominio propio

1. Subí la carpeta a un repositorio de GitHub (la carpeta `node_modules` ya está
   ignorada).
2. En el repositorio: **Settings → Pages → Build and deployment**, elegí
   *Deploy from a branch*, la rama `main` y la carpeta `/ (root)`.
3. En **Custom domain** escribí tu dominio (por ejemplo `turnos.tucomplejo.com.ar`)
   y en el DNS de tu dominio creá un registro `CNAME` que apunte a
   `tu-usuario.github.io`. Cuando GitHub lo verifique, activá **Enforce HTTPS**.

En el plan gratuito de GitHub, Pages requiere que el repositorio sea público. No
hay problema: en el código no hay nada secreto. Si preferís un repositorio privado,
Cloudflare Pages o Netlify funcionan igual y también son gratis.

## Cómo se protegen los datos y el cupo

Las reglas viven en la base de datos (`supabase/schema.sql`), no en la página, así
que no se pueden saltear desde el navegador:

- **Capacidad:** antes de guardar cada reserva, la base bloquea la fila del turno,
  cuenta las reservas activas y rechaza la reserva si no hay lugar. Si dos
  personas intentan tomar el último lugar al mismo tiempo, se atienden de a una
  y la segunda recibe «Horario lleno».
- **Duplicados:** un índice único impide dos reservas activas con el mismo
  documento en el mismo turno. El documento se normaliza antes de guardarse
  (`12.345.678`, `12 345 678` y `012345678` son el mismo). Una persona sí puede
  reservar turnos distintos.
- **Capacidad del admin:** no se puede bajar por debajo de las reservas activas.
- **Datos personales:** el público solo puede leer la tabla de turnos (horarios y
  cantidades) y llamar a tres funciones: ver disponibilidad, ver la configuración
  y reservar. Las reservas con nombres y documentos solo se leen con funciones
  del panel que verifican que el usuario esté en la tabla `admins`.
- **Estados:** *Disponible*, *Horario lleno*, *Cerrado* (lo cerró el admin o el
  día está cerrado) y *Finalizado* (ya empezó). Se calculan en la base con la hora
  de Argentina.

## Pruebas

Las pruebas corren el esquema sobre un Postgres real (PGlite) y verifican cupo,
duplicados, estados, validaciones, permisos, horario semanal, cambios por día y
días cerrados:

```bash
npm install
npm test
```

## Limitaciones y posibles mejoras

- **Reservas falsas:** cualquiera puede reservar con un documento inventado y
  ocupar lugares. Si pasa, se puede agregar un máximo de reservas por documento
  por día, un captcha (Cloudflare Turnstile) o pedir teléfono.
- **Cancelación por el usuario:** hoy solo cancela el personal. Se podría permitir
  que la persona cancele con su código de reserva y su documento.
- **Sin email de confirmación:** la confirmación se muestra en pantalla.
- **Supabase gratis** pausa los proyectos que pasan una semana sin uso; con uso
  diario no pasa.
