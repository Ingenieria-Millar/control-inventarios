# ERP SaaS — Retail de Tecnología
## Fase 5: Especificación de API REST

> API REST sobre NestJS. Base: `https://api.nexoretail.co/v1`. Todas las respuestas en JSON.

---

## 1. Convenciones generales

- **Versionado** en la ruta: `/v1`. Cambios incompatibles → `/v2`.
- **Autenticación:** `Authorization: Bearer <access_token>` (JWT). El token incluye `tenant_id`, `user_id` y roles; el `tenant_id` se aplica automáticamente a toda consulta (RLS).
- **Multisede:** la sede se pasa por header `X-Store-Id` o como query `?storeId=`.
- **Paginación:** `?page=1&limit=25`; respuesta con `{ data, meta: { page, limit, total, totalPages } }`.
- **Filtros y orden:** `?search=`, `?sort=campo:asc|desc`, filtros por campo (`?categoryId=`, `?status=`).
- **Idempotencia** en operaciones de pago/venta vía header `Idempotency-Key`.
- **Errores:** formato uniforme.
```json
{ "error": { "code": "STOCK_INSUFICIENTE", "message": "Stock insuficiente para SKU APL-I15-128", "details": {} } }
```
- **Códigos HTTP:** 200/201 éxito · 400 validación · 401 no autenticado · 403 sin permiso · 404 no existe · 409 conflicto (stock, consecutivo) · 422 regla de negocio · 429 límite de tasa.
- **Tiempo real:** eventos vía WebSocket (`/ws`): `stock.updated`, `sale.created`, `alert.new`, `transfer.received`.

---

## 2. Endpoints por módulo

### Autenticación y cuenta
| Método | Ruta | Descripción |
|---|---|---|
| POST | `/auth/login` | Inicia sesión, devuelve access + refresh token |
| POST | `/auth/refresh` | Renueva el access token |
| POST | `/auth/logout` | Revoca el refresh token |
| POST | `/auth/2fa/verify` | Verifica el segundo factor |
| GET | `/me` | Perfil, empresa, sedes y permisos del usuario |

### Empresas, sedes, usuarios y permisos
| Método | Ruta | Descripción |
|---|---|---|
| GET/POST | `/tenants` · `/tenants/:id` | Empresas (alta y administración) |
| GET/POST | `/stores` · `/stores/:id` | Sedes |
| GET/POST | `/users` · `/users/:id` | Usuarios |
| GET/POST | `/roles` · `/roles/:id` | Roles y sus permisos |
| GET | `/permissions` | Catálogo de permisos |
| POST | `/users/:id/stores` | Asignar usuario a sede con rol |

### Inventario
| Método | Ruta | Descripción |
|---|---|---|
| GET/POST | `/products` · `/products/:id` | Referencias |
| GET/POST | `/products/:id/variants` | Variantes (color/capacidad) |
| GET | `/products/:id/compatibilities` | Accesorios/dispositivos compatibles |
| POST | `/compatibilities` | Crear relación de compatibilidad |
| GET/POST | `/categories` · `/brands` · `/colors` | Catálogos |
| GET/POST | `/locations` | Ubicaciones de bodega |
| GET/POST | `/lots` | Lotes |
| GET | `/inventory-items?imei=` | Buscar unidad por serie/IMEI |
| GET | `/stock?storeId=&variantId=` | Existencias por sede |
| GET | `/kardex?variantId=&from=&to=` | Movimientos de inventario |
| GET | `/products/scan?code=` | Resolver producto por código de barras/QR |

### Compras y entradas
| Método | Ruta | Descripción |
|---|---|---|
| GET/POST | `/suppliers` · `/suppliers/:id` | Proveedores |
| GET/POST | `/purchase-quotes` | Cotizaciones |
| GET/POST | `/purchase-orders` · `/purchase-orders/:id` | Órdenes de compra |
| POST | `/purchase-orders/:id/send` | Enviar orden al proveedor |
| GET/POST | `/goods-receipts` | Recepción de mercancía (genera kardex + costo + CxP) |
| GET/POST | `/supplier-invoices` | Facturas de proveedor |

### Salidas no-venta
| Método | Ruta | Descripción |
|---|---|---|
| GET/POST | `/adjustments` | Ajustes / daños / pérdidas |
| GET/POST | `/transfers` | Traslados entre sedes |
| POST | `/transfers/:id/receive` | Confirmar recepción de un traslado |

### POS y ventas
| Método | Ruta | Descripción |
|---|---|---|
| POST | `/sales` | Crear venta (descuenta stock, calcula IVA) |
| POST | `/sales/:id/invoice` | Emitir factura electrónica → encola envío DIAN |
| GET | `/sales` · `/sales/:id` | Consultar ventas |
| POST | `/sales/:id/payments` | Registrar medios de pago |
| POST | `/returns` | Devolución / nota crédito |
| GET/POST | `/cash-sessions` | Apertura y cierre de caja (arqueo) |
| GET | `/dian-resolutions` | Resoluciones y consecutivos |
| GET | `/sales/:id/cufe-status` | Estado DIAN de una factura |

### CRM
| Método | Ruta | Descripción |
|---|---|---|
| GET/POST | `/customers` · `/customers/:id` | Clientes |
| GET | `/customers/:id/history` | Historial de compras |
| GET/POST | `/segments` | Segmentación |
| POST | `/customers/:id/loyalty` | Movimiento de puntos de fidelización |

### Finanzas
| Método | Ruta | Descripción |
|---|---|---|
| GET/POST | `/income` · `/expenses` | Ingresos y egresos |
| GET | `/cash-flow?from=&to=` | Flujo de caja |
| GET | `/accounts-receivable` · `/accounts-payable` | Cartera CxC / CxP |
| POST | `/payments` | Abonos a CxC/CxP |

### Dashboard, reportes y alertas
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/dashboard/kpis?storeId=` | KPIs del tablero |
| GET | `/reports/:type` | Reportes (kardex, rotación, rentabilidad, ventas, utilidades) |
| GET | `/reports/:type/export?format=xlsx|pdf` | Exportar reporte |
| GET/PATCH | `/alerts` | Listar y marcar alertas |

### IA
| Método | Ruta | Descripción |
|---|---|---|
| POST | `/ai/assistant` | Consulta en lenguaje natural (devuelve texto + datos) |
| POST | `/ai/voice` | Transcribe audio y resuelve la consulta |
| POST | `/ai/vision` | Reconoce un producto desde una foto |
| GET | `/ai/forecast?variantId=` | Predicción de demanda |
| POST | `/ai/simulate` | Simulador de decisiones (precio, promo, sede) |

### Auditoría
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/audit-logs?entity=&userId=&from=&to=` | Bitácora inmutable |

---

## 3. Qué sigue

**Fase 6 — Componentes de IA:** arquitectura del asistente en lenguaje natural, predicción de demanda, IA visual, voz, simulador, gemelo digital, red colaborativa y compatibilidad automática.
