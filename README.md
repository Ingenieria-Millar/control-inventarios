# Nexo Retail · ERP SaaS para tiendas de tecnología

ERP en la nube, multiempresa y multisede, especializado en tiendas de tecnología, celulares y accesorios. Pensado para operar desde una sola tienda hasta cadenas con varias sedes, con facturación electrónica DIAN (Colombia) y funciones de inteligencia artificial.

> **Nombre de trabajo:** *Nexo Retail* (sugerido, ajustable).

---

## ⚠️ Estado del proyecto

Este repositorio contiene, por ahora:

- **Documentación de diseño e ingeniería** completa (Fases 1 a 7) en `/docs`.
- Un **prototipo navegable de demostración** en `/app` (datos de ejemplo, sin backend ni base de datos real, sin conexión real a la DIAN).

**Todavía NO incluye la aplicación funcional** (backend, base de datos, app móvil). Esa es la **Fase 8 (construcción)**, que se desarrolla módulo por módulo. El prototipo sirve para mostrar y navegar la solución, no para operar una tienda real.

---

## 📁 Estructura del repositorio

```
nexo-retail/
├─ app/                 # Prototipo de demostración (sitio estático)
│  └─ index.html
├─ docs/                # Documentación de diseño (Fases 1–7)
│  ├─ Fase1-Arquitectura.md
│  ├─ Fase2-ModeloDeDatos.md
│  ├─ Fase3-DisenoFuncional.md
│  ├─ Fase4-UX-UI.md
│  ├─ Fase5-APIs.md
│  ├─ Fase6-IA.md
│  └─ Fase7-Roadmap-Monetizacion.md
├─ render.yaml          # Blueprint para desplegar el prototipo en Render
├─ .gitignore
├─ LICENSE              # Licencia propietaria — todos los derechos reservados
└─ README.md
```

---

## ▶️ Ver el prototipo

**En tu computador:** abre `app/index.html` en el navegador (doble clic). No requiere instalación.

**En la web (Render):** ver la sección *Despliegue* más abajo. Una vez desplegado tendrás una URL pública del tipo `https://nexo-retail-demo.onrender.com`.

Recorrido sugerido: pantalla de ingreso → Dashboard → Inventario → **POS** (agrega un celular y observa la *compatibilidad automática* sugiriendo accesorios).

---

## 🚀 Despliegue del prototipo en Render

**Opción A — Blueprint (recomendada):**
1. En el panel de Render: **New → Blueprint**.
2. Conecta este repositorio de GitHub.
3. Render lee `render.yaml` y crea un *Static Site* publicando la carpeta `app`.
4. Pulsa **Deploy**. En 1–2 minutos obtendrás la URL pública.

**Opción B — Manual:**
1. **New → Static Site** y conecta el repositorio.
2. **Build Command:** déjalo vacío (o `echo skip`).
3. **Publish Directory:** `app`
4. **Create Static Site.**

Cada `git push` a `main` vuelve a desplegar automáticamente.

---

## 🧱 Stack previsto (Fase 8)

Web: Next.js + TypeScript · Móvil: React Native (Expo) · Backend: NestJS (API REST) · Base de datos: PostgreSQL (multi-tenant con Row-Level Security) · IA: microservicio Python (FastAPI) + LLM · Tiempo real: WebSocket · Caché/colas: Redis + BullMQ · Nube: Render → AWS.

---

## 📚 Documentación

| Fase | Contenido |
|---|---|
| 1 | Arquitectura y fundamentos |
| 2 | Modelo de datos y diagrama ER |
| 3 | Diseño funcional, casos de uso, historias y permisos |
| 4 | Diseño UX/UI |
| 5 | Especificación de la API REST |
| 6 | Componentes de Inteligencia Artificial |
| 7 | Roadmap, backlog y monetización |

---

## 🔒 Licencia y confidencialidad

Software **propietario**. Todos los derechos reservados. Consulta el archivo [`LICENSE`](./LICENSE). Por tratarse de un producto comercial, se recomienda mantener este repositorio **privado**.
