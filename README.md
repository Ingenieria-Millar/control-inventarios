# Nexo Retail

ERP SaaS multiempresa para tiendas de tecnología (celulares y accesorios) en Colombia.
Hecho por **Ingeniería Millar**.

Incluye: multiempresa con usuarios y roles, multi-sucursal con stock por sucursal, inventario, seguimiento por IMEI/serial, POS/ventas (IVA 19%), clientes (CRM) con
cupo de crédito, compras/entradas, salidas y ajustes, devoluciones (notas crédito), caja/arqueo por turnos, kardex,
historial de ventas, reportes,
finanzas (flujo de caja, cuentas por cobrar/pagar, gastos), lector de código de barras,
recuperación de contraseña por email, alertas inteligentes, registro de auditoría y panel de
súper administrador para dar de alta clientes.

## Archivos del proyecto

| Archivo | ¿Para qué? | ¿Obligatorio? |
|---|---|---|
| `server.js` | Backend (API, autenticación, persistencia). Sirve el frontend desde `web/`. | Sí |
| `web/index.html` | Frontend completo (interfaz de usuario). Se sirve tal cual. | Sí |
| `package.json` | Dependencias (express, pg) y comando de arranque | Sí |
| `.gitignore` | Evita subir `node_modules`, datos locales y `.env` | Recomendado |
| `README.md` | Esta documentación | Opcional |

> El frontend ya **no** está embebido en `server.js`: vive en `web/index.html` y el servidor lo
> entrega en cada ruta no-API. Editarlo ya no requiere tocar el backend.

## Despliegue en Render

1. Sube `server.js`, `web/` y `package.json` a la raíz del repositorio.
2. Crea un servicio web en Render apuntando al repo.
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
3. (Recomendado) Conecta una base de datos PostgreSQL y agrega la variable de entorno
   `DATABASE_URL`. Con ella los datos son permanentes y se activa la seguridad RLS.
   - Sin `DATABASE_URL`, la app corre en modo archivo JSON: **los datos se reinician** en cada
     despliegue (solo para pruebas).

## Variables de entorno

| Variable | ¿Para qué? |
|---|---|
| `DATABASE_URL` | Conexión a PostgreSQL (datos permanentes + RLS). Usa un rol **no superusuario**. |
| `CORS_ORIGINS` | Opcional. Dominios externos permitidos, separados por comas (o `*`). Por defecto solo mismo origen. |
| `SEED_SUPER_PASS` | Opcional. Contraseña inicial del súper administrador. Si no se define, se genera una aleatoria y se imprime **una sola vez** en los logs al sembrar. |
| `SEED_DEMO_PASS` | Opcional. Contraseña inicial del usuario demo. Mismo comportamiento que la anterior. |
| `NODE_ENV` | Ponlo en `production` en Render. En producción la app **se niega a arrancar sin `DATABASE_URL`** (el modo JSON no es seguro) y **aborta si el rol de BD es superusuario / BYPASSRLS** (la RLS no se aplicaría). |
| `PG_POOL_MAX` | Opcional. Máximo de conexiones del pool PostgreSQL (por defecto 10). Ajústalo al límite de tu plan de base de datos. |
| `SMTP_URL` | Opcional. Conexión SMTP para enviar emails (recuperación de contraseña). Sin ella, el envío queda en modo *stub* (se registra en logs, no envía). Requiere `npm i nodemailer`. |
| `SMTP_FROM` | Opcional. Remitente de los correos (por defecto `no-reply@nexo.local`). |
| `PORT` | La asigna Render automáticamente. |

## Acceso inicial (semilla)

Se crean automáticamente la primera vez (Empresa · Usuario · Contraseña):

- Súper administrador → `Nexo` · `Súper Admin` · *(de `SEED_SUPER_PASS`, o aleatoria impresa en los logs)*
- Empresa de ejemplo → `JEROTECH` · `DEMO` · *(de `SEED_DEMO_PASS`, o aleatoria impresa en los logs)*

> Las contraseñas iniciales ya **no son fijas**. Define `SEED_SUPER_PASS` / `SEED_DEMO_PASS`, o
> revisa los logs del primer arranque para verlas. Cámbialas al primer ingreso.

## Pruebas

Tests automatizados con el runner integrado de Node (sin dependencias extra). Corren en modo
archivo JSON, no tocan tu base de datos:

```
npm test
```

Cubren: autenticación, rate-limit/lockout, política de contraseña, validación de rol,
aislamiento multiempresa, ventas/stock e IVA, auditoría y vigencia del plan. Los archivos
viven en `test/` (`api.test.js` de integración, `unit.test.js` de funciones puras).

## Seguridad

- Contraseñas cifradas (scrypt), sesiones con token. Política de contraseña: **mínimo 8 caracteres**.
- Login con **límite de intentos por IP** y **bloqueo temporal de cuenta** (15 min) tras varios fallos.
- El estado de la empresa (vencida/inactiva) solo se revela tras credenciales válidas (anti-enumeración).
- **Vigencia del plan revisada en cada petición**: al vencer o desactivarse la empresa, las sesiones activas se cortan e invalidan (no solo al iniciar sesión).
- **Registro de auditoría** de acciones sensibles (login/login fallido, impersonación, alta/baja/cambio de empresas y usuarios, ajustes de stock). Consulta: `GET /api/audit` (súper-admin) y `GET /api/company/audit` (administrador de la empresa).
- Aislamiento entre empresas por código **y** por RLS a nivel de base de datos (en PostgreSQL).
- Cabeceras de seguridad (CSP, HSTS, anti-clickjacking) y CORS restringido por defecto.
