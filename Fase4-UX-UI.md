# ERP SaaS — Retail de Tecnología
## Fase 1: Arquitectura y Fundamentos

> Documento de ingeniería. Producto SaaS multiempresa / multisede, comercializable, para tiendas de tecnología, celulares y accesorios. Mercado objetivo: **Colombia**.

---

## 0. Decisiones confirmadas

| Tema | Decisión |
|---|---|
| Mercado | Colombia → facturación electrónica **DIAN** (UBL 2.1, CUFE), IVA 19% / 5% / 0% / excluido, moneda **COP**, identificación **NIT/RUT**, cumplimiento **Ley 1581 de 2012 (Habeas Data)**. |
| Naturaleza | SaaS multi-tenant, cloud-native, modular, API-first. |
| Alcance operativo | Desde 1 tienda hasta cadenas con múltiples sedes. |
| Entrega | Paquete completo por fases. Este documento es la **Fase 1**. |
| Stack | Recomendado por el equipo (sección 2). |

---

## 1. Visión de arquitectura

Arquitectura **monolito modular** (un backend bien dividido por módulos) que puede extraer servicios cuando el volumen lo exija. Esto evita la complejidad prematura de microservicios pero deja la puerta abierta a escalar a 100.000 usuarios concurrentes.

```
                          ┌─────────────────────────┐
                          │        CLIENTES          │
                          │  Web (Next.js)           │
                          │  Móvil (React Native)    │
                          │  Panel admin (Next.js)   │
                          └───────────┬─────────────┘
                                      │ HTTPS / WSS
                          ┌───────────▼─────────────┐
                          │   CDN (CloudFront)       │
                          │   Load Balancer (ALB)    │
                          └───────────┬─────────────┘
                                      │
                  ┌───────────────────▼───────────────────┐
                  │     API REST  (NestJS, autoescalada)   │
                  │  Auth/JWT · RBAC · Tenant isolation    │
                  │  Módulos: inventario, compras, POS,    │
                  │  finanzas, CRM, reportes, alertas...   │
                  │  WebSocket Gateway (tiempo real)       │
                  └───┬──────────┬──────────┬──────────┬───┘
                      │          │          │          │
              ┌───────▼──┐  ┌────▼────┐ ┌───▼────┐ ┌───▼─────────┐
              │PostgreSQL│  │  Redis  │ │ Colas  │ │ Microserv.  │
              │ (RLS +   │  │ (caché, │ │BullMQ  │ │ IA (FastAPI)│
              │ réplicas)│  │ sesión) │ │(async) │ │ NLP/visión  │
              └──────────┘  └─────────┘ └───┬────┘ └─────────────┘
                                            │
                                  ┌─────────▼─────────┐
                                  │  Integraciones    │
                                  │  DIAN, pagos, etc.│
                                  └───────────────────┘
```

**Principios:** API sin estado (escala horizontal), seguridad por diseño, todo lo pesado va a colas asíncronas, un solo lenguaje (TypeScript) en web/móvil/backend para reutilizar tipos y conocimiento.

---

## 2. Stack tecnológico recomendado

| Capa | Tecnología | Por qué |
|---|---|---|
| **Web / Panel admin** | Next.js (React + TypeScript) + Tailwind CSS + shadcn/ui | Render del lado del servidor, ecosistema maduro, UI consistente y profesional. |
| Estado y formularios web | TanStack Query + Zustand + React Hook Form + Zod | Manejo robusto de datos de servidor, estado local y validación. |
| **Móvil (Android + iOS)** | React Native (Expo) | Un solo código para ambas plataformas, reutiliza TypeScript, soporte nativo de cámara/escáner. |
| **Backend / API** | Node.js + NestJS (TypeScript), API **REST** | Estructura empresarial real (módulos, *guards* para roles, *interceptors* para auditoría). Alinea con tu experiencia en Node. |
| **Base de datos** | PostgreSQL 16 | Relacional y robusta; `JSONB` para atributos flexibles (compatibilidades, specs); soporta aislamiento multi-tenant; sólida en datos financieros. |
| ORM | Prisma | Tipado, migraciones versionadas, buena experiencia de desarrollo. |
| Caché / sesiones / colas | Redis + BullMQ | Caché, *rate limiting*, y trabajos asíncronos (envío a DIAN, reportes, IA). |
| Tiempo real | WebSocket (NestJS Gateway / Socket.IO) | Stock en vivo, POS, alertas, red colaborativa entre tiendas. |
| Búsqueda | Postgres Full-Text (o Meilisearch si crece) | Búsqueda rápida de productos y compatibilidades. |
| **IA / ML** | Microservicio Python (FastAPI) + Claude API (Anthropic) | Asistente en lenguaje natural, predicción de demanda, visión, voz. |
| Infra (MVP) | Render / Railway + Docker | Rápido y barato para arrancar y demostrar. |
| Infra (escala) | AWS: ECS/EKS, RDS PostgreSQL (con réplicas), ElastiCache, S3, CloudFront, ALB | Alta disponibilidad y autoescalado. |
| CI/CD | GitHub Actions | Ya trabajas con GitHub. |
| Infraestructura como código | Terraform | Infra reproducible y versionada. |
| Observabilidad | Sentry + Prometheus/Grafana (o Datadog) + OpenTelemetry | Errores, métricas y trazas. |
| Autenticación | JWT (access + refresh con rotación) + Passport + 2FA | Requisito del proyecto; control de roles. |
| Monorepo | pnpm + Turborepo | Comparte tipos y lógica entre web, móvil y API. |

---

## 3. Estrategia multiempresa y multisede

**Opciones de aislamiento de datos evaluadas:**

1. *Base de datos por tenant* — máximo aislamiento, pero caro e inmanejable con muchos clientes.
2. *Esquema por tenant* — buen aislamiento, complejidad media en migraciones.
3. *Esquema compartido + `tenant_id` + Row-Level Security (RLS)* — **recomendado**: el más económico y escalable; PostgreSQL filtra automáticamente por tenant a nivel de motor, evitando fugas de datos por error de código.

**Recomendación:** esquema compartido con **RLS de PostgreSQL** y `tenant_id` indexado en todas las tablas. Cuando un cliente crezca mucho, se puede aislar en su propio *shard*.

**Modelo conceptual:**
- **Empresa (tenant)** = el cliente que paga la suscripción.
- **Sede (sucursal)** = punto físico dentro de la empresa. El stock, las cajas y las ventas son **por sede**.
- **Usuario** pertenece a una empresa y puede tener acceso a una o varias sedes, con su rol.
- El `tenant_id` viaja en el JWT y se inyecta en cada consulta vía *middleware* + RLS.

---

## 4. Estructura de carpetas (monorepo)

```
erp-retail/
├─ apps/
│  ├─ web/                  # Next.js: panel admin + app + sitio comercial
│  ├─ mobile/               # React Native (Expo)
│  └─ api/                  # NestJS (API REST)
│     └─ src/
│        ├─ modules/
│        │  ├─ auth/                # login, JWT, 2FA
│        │  ├─ tenants/             # multiempresa
│        │  ├─ stores/              # multisede
│        │  ├─ users/               # usuarios y permisos
│        │  ├─ inventory/           # referencias, categorías, marcas, colores,
│        │  │                       #  compatibilidades, ubicaciones, lotes,
│        │  │                       #  garantías, kardex
│        │  ├─ inbound/             # entradas de mercancía
│        │  ├─ outbound/            # salidas: daños, pérdidas, traslados
│        │  ├─ purchases/           # compras, órdenes, cotizaciones
│        │  ├─ pos/                 # POS y ventas
│        │  ├─ invoicing/           # facturación electrónica DIAN
│        │  ├─ finance/             # ingresos, egresos, flujo de caja, CxC/CxP
│        │  ├─ crm/                 # clientes, fidelización, segmentación
│        │  ├─ reports/             # reportes avanzados
│        │  ├─ dashboard/           # KPIs gerenciales
│        │  ├─ alerts/              # alertas inteligentes
│        │  ├─ audit/               # auditoría completa (append-only)
│        │  └─ ai/                  # gateway al microservicio de IA
│        ├─ common/                 # guards, interceptors, pipes, decorators
│        ├─ config/
│        └─ main.ts
├─ services/
│  └─ ai/                   # FastAPI (Python): NLP, predicción, visión, voz
├─ packages/
│  ├─ types/                # DTOs y tipos compartidos (TS)
│  ├─ ui/                   # componentes compartidos
│  ├─ validation/           # esquemas Zod compartidos
│  └─ config/               # ESLint, tsconfig, etc.
├─ infra/                   # Terraform, Docker, Kubernetes
├─ .github/workflows/       # CI/CD
├─ turbo.json
└─ package.json
```

---

## 5. Plan de escalabilidad (hasta 100.000 usuarios concurrentes)

El crecimiento se aborda por etapas, sin sobre-construir desde el día uno:

**Etapa A — 0 a 1.000 usuarios:** monolito modular NestJS + PostgreSQL + Redis en plataforma gestionada (Render). Una instancia de API con autoescalado básico.

**Etapa B — 1.000 a 20.000 usuarios:** contenedores en AWS ECS detrás de un *load balancer* (ALB) con autoescalado horizontal. RDS PostgreSQL con **réplica de lectura** y *connection pooling* (PgBouncer). Redis gestionado. Imágenes y estáticos por CDN (CloudFront + S3).

**Etapa C — 20.000 a 100.000+ usuarios:** orquestación con Kubernetes (EKS) y múltiples réplicas. **Particionado** de tablas grandes (kardex, ventas) por fecha/tenant. **Sharding por tenant** para los clientes más grandes. Redis en *cluster*. Colas BullMQ escaladas. Caché agresivo del catálogo. Múltiples réplicas de lectura. Posible extracción de servicios pesados (reportes, IA) a procesos independientes.

**Claves para soportar 100k concurrentes:**
- API **sin estado** → escala horizontal ilimitada detrás del balanceador.
- Sesión en el JWT / Redis (nada de estado en el servidor de aplicación).
- La base de datos es el cuello de botella típico → réplicas de lectura, *pooling*, particionado, caché y mover todo lo pesado a colas.
- Operaciones lentas (envío a DIAN, generación de reportes, predicción de demanda, procesamiento de imágenes) **siempre asíncronas** vía colas.
- *Rate limiting* por tenant para evitar que un cliente afecte a los demás.

---

## 6. Seguridad empresarial

- **Autenticación:** JWT con *access token* corto + *refresh token* con rotación; 2FA obligatorio para roles administrativos.
- **Autorización:** RBAC por roles (Administrador, Gerente, Compras, Ventas, Bodega) reforzado con **Row-Level Security** para aislamiento entre empresas.
- **Cifrado:** TLS en tránsito; cifrado en reposo (RDS, S3); secretos en *vault* (AWS Secrets Manager), nunca en el código.
- **Auditoría completa:** tabla de auditoría *append-only* (inmutable) que registra quién, qué, cuándo y el antes/después de cada operación sensible, consultable por empresa.
- **Buenas prácticas:** validación de entrada (Zod), consultas parametrizadas (ORM), protección OWASP Top 10, CORS estricto, *helmet*, *rate limiting*.
- **Respaldo automático:** copias automáticas de RDS con *Point-in-Time Recovery* + versionado en S3. Alta disponibilidad multi-AZ.
- **Cumplimiento Colombia:** Ley 1581 de 2012 (protección de datos personales / Habeas Data), registro de base de datos ante la SIC, política de tratamiento de datos y consentimiento del titular.

---

## 7. Integraciones críticas (se detallan en fase posterior)

- **DIAN — Facturación electrónica:** vía Proveedor Tecnológico certificado (Facture, Carvajal, The Factory HKA, etc.) o integración directa. UBL 2.1, generación de CUFE, validación y numeración autorizada.
- **Pasarelas de pago** (Wompi, PayU, Mercado Pago, datáfonos).
- **Mensajería** (WhatsApp Business / email transaccional) para alertas y recibos.

---

## 8. Qué sigue

**Fase 2 — Modelo de datos:** modelo relacional completo, diagrama entidad-relación y diccionario de datos, cubriendo multiempresa/multisede, inventario, compras, entradas, salidas, POS, finanzas, CRM y auditoría.
