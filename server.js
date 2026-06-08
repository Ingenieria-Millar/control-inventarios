# Nexo Retail · ERP para tiendas de tecnología

Aplicación web para control de inventario y ventas de tiendas de tecnología, celulares y accesorios. Backend en **Node.js + Express** con persistencia en archivo, y frontend responsive que se sirve desde el mismo servicio.

> **Nombre de trabajo:** *Nexo Retail* (sugerido, ajustable).

---

## ✅ Qué funciona hoy (versión 0.1)

- **Inventario:** crear, editar y eliminar productos. Los datos **se guardan** de verdad.
- **POS / Ventas:** registrar ventas que **descuentan stock**, calculan IVA (19%) y validan stock insuficiente.
- **Compatibilidad automática:** al agregar un celular, sugiere accesorios compatibles con stock.
- **Dashboard:** ventas del día, utilidad, ticket promedio y alertas de stock, **calculados de los datos reales**.

## 🔧 Aún de demostración / por construir

- Inicio de sesión (es solo visual por ahora), usuarios y permisos reales.
- Multiempresa y multisede.
- Facturación electrónica DIAN real (CUFE), compras, CRM, reportes e IA.
- Las tarjetas marcadas como *"ejemplo"* en el dashboard (gráfica de 7 días, top de productos, resumen financiero).

Estos módulos están **diseñados** en `/docs` y se construyen en las siguientes entregas.

---

## ▶️ Correr en tu computador

Requisitos: Node.js 18 o superior.

```bash
npm install
npm start
```

Abre **http://localhost:3000**. La base de datos se crea sola en `data/nexo.json` con productos de ejemplo.

---

## 🚀 Desplegar en Render (Web Service)

**Opción A — Blueprint (recomendada):**
1. En Render: **New → Blueprint** y conecta este repositorio.
2. Render lee `render.yaml` y crea el Web Service (`npm install` + `npm start`).
3. **Deploy** → obtienes la URL pública.

**Opción B — Manual:**
1. **New → Web Service**, conecta el repositorio.
2. **Runtime:** Node · **Build Command:** `npm install` · **Start Command:** `npm start`.
3. **Create Web Service.**

⚠️ **Persistencia en producción:** en el plan **gratis** de Render el disco es temporal, así que `data/nexo.json` **se reinicia en cada despliegue**. Para que los datos sean permanentes: usa un **plan pago + disco persistente** (define la variable `DB_PATH` apuntando al disco montado), o migra a **PostgreSQL**. El plan gratis también **duerme** el servicio tras inactividad.

---

## 🗂️ Estructura

```
nexo-retail/
├─ server.js            # Servidor Express (API REST + frontend)
├─ db.js                # Capa de datos (persistencia en JSON)
├─ public/
│  └─ index.html        # Frontend (interfaz de la app)
├─ docs/                # Documentación de diseño (Fases 1–7)
├─ render.yaml          # Blueprint de despliegue (Web Service)
├─ package.json
├─ .gitignore
├─ LICENSE              # Licencia propietaria
└─ README.md
```

## 🔌 API (resumen)

`GET/POST /api/products` · `PUT/DELETE /api/products/:id` · `GET /api/products/:id/compatibles` · `GET/POST /api/sales` · `GET /api/dashboard` · `GET /api/health`

---

## 🔒 Licencia

Software **propietario**. Todos los derechos reservados (ver [`LICENSE`](./LICENSE)). Se recomienda mantener el repositorio **privado**.
