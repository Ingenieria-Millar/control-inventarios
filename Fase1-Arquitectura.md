# ERP SaaS — Retail de Tecnología
## Fase 3: Diseño Funcional

> Módulos detallados, casos de uso, historias de usuario, flujos de usuario y matriz de roles y permisos.

---

## 1. Módulos funcionales (resumen operativo)

| # | Módulo | Qué hace | Salidas clave |
|---|---|---|---|
| 1 | **Inventario** | Administra referencias, variantes, categorías, marcas, colores, compatibilidades, ubicaciones, lotes, garantías y stock min/máx. | Kardex automático, estado de stock, mapa de bodega |
| 2 | **Entradas de mercancía** | Recepción desde proveedor (con o sin orden), captura de costos y factura. | Movimiento kardex (+), costo promedio, CxP |
| 3 | **Salidas de mercancía** | Ventas, daños, pérdidas, traslados y ajustes. | Movimiento kardex (−), reportes de merma |
| 4 | **Compras** | Cotizaciones, órdenes de compra, recepción e historial por proveedor. | Órdenes, comparativos de proveedor |
| 5 | **POS / Ventas** | Facturación electrónica, devoluciones, descuentos, garantías y múltiples medios de pago. | Factura DIAN (CUFE), recibo, arqueo de caja |
| 6 | **Control financiero** | Ingresos, egresos, flujo de caja, rentabilidad, CxC y CxP. | Estado de caja, márgenes, cartera |
| 7 | **CRM** | Clientes, historial, fidelización por puntos y segmentación. | Segmentos, programa de puntos |
| 8 | **Dashboard gerencial** | KPIs de ventas, utilidades, inventario y tendencias. | Tablero en tiempo real |
| 9 | **Reportes avanzados** | Kardex, compras, ventas, utilidades, rotación y rentabilidad. | Exportes Excel/PDF |
| 10 | **Usuarios y permisos** | Roles, permisos por sede y auditoría completa. | Bitácora inmutable |
| 11 | **Multiempresa / multisede** | Aislamiento por empresa y operación por sede. | Consolidados de cadena |
| 12 | **Alertas e IA** | Stock bajo, predicción de demanda, asistente NL, compatibilidad, visión y voz. | Alertas y recomendaciones |

---

## 2. Casos de uso principales

**CU-01 · Registrar una venta en el POS**
Actor: Vendedor. El vendedor busca/escanea productos, el sistema arma el carrito, calcula IVA y total, sugiere accesorios compatibles, registra uno o varios medios de pago, descuenta stock (y la serie/IMEI si aplica), genera la factura electrónica con CUFE y la envía a la DIAN.

**CU-02 · Recibir mercancía de un proveedor**
Actor: Bodega. Selecciona la orden de compra (o crea entrada directa), confirma cantidades y costos por línea, asigna ubicación y lote, genera series para equipos serializados. El sistema actualiza stock, recalcula costo promedio, registra kardex (+) y crea la cuenta por pagar.

**CU-03 · Crear orden de compra a partir de sugerencia de IA**
Actor: Compras. El sistema lista productos bajo el mínimo y la demanda proyectada; el usuario ajusta cantidades, selecciona proveedor y emite la orden.

**CU-04 · Trasladar productos entre sedes**
Actor: Bodega/Gerente. Crea el traslado (origen→destino), el sistema descuenta en origen y deja en tránsito; la sede destino confirma recepción y suma a su stock.

**CU-05 · Procesar una devolución con garantía**
Actor: Vendedor. Busca la venta, selecciona el ítem (por serie si aplica), registra motivo, el sistema valida vigencia de garantía, reingresa o marca como dañado y emite nota crédito DIAN.

**CU-06 · Consultar el negocio en lenguaje natural**
Actor: Gerente. Pregunta «¿qué debo comprar esta semana?» o «¿cuál es mi margen por marca?»; el asistente consulta los datos de la empresa y responde con cifras y un gráfico.

**CU-07 · Cierre de caja (arqueo)**
Actor: Vendedor/Cajero. Al cerrar turno, ingresa el conteo físico; el sistema compara contra lo esperado y registra la diferencia.

**CU-08 · Configurar empresa y sede**
Actor: Administrador. Da de alta la empresa, sedes, usuarios, roles, resoluciones DIAN, impuestos y listas de precio.

---

## 3. Historias de usuario (muestra por módulo)

**Formato:** *Como [rol] quiero [acción] para [beneficio].*

- **Inventario** — Como bodeguero quiero ver el stock con un indicador de color para identificar de inmediato lo agotado o bajo mínimo.
- **Inventario** — Como administrador quiero definir stock mínimo y máximo por producto y por sede para que las alertas se ajusten a cada tienda.
- **POS** — Como vendedor quiero escanear el código de barras para agregar productos al carrito sin teclear.
- **POS** — Como vendedor quiero registrar pago dividido (efectivo + tarjeta) en una misma factura.
- **POS** — Como cliente quiero recibir la factura electrónica en mi correo apenas se confirma la venta.
- **Compras** — Como comprador quiero comparar precios de varios proveedores para una misma referencia antes de emitir la orden.
- **Finanzas** — Como gerente quiero ver el flujo de caja del mes con ingresos vs egresos para tomar decisiones de liquidez.
- **CRM** — Como gerente quiero segmentar clientes por frecuencia de compra para enviar promociones dirigidas.
- **Reportes** — Como gerente quiero exportar la rotación de inventario a Excel para revisar productos sin movimiento.
- **IA** — Como gerente quiero que el sistema me avise qué reponer antes de quedar agotado.
- **Seguridad** — Como administrador quiero ver quién modificó un precio o eliminó un registro y cuándo.

> El backlog completo y priorizado está en la Fase 7.

---

## 4. Flujos de usuario clave

**Flujo de venta (POS)**
1. Vendedor abre POS → 2. Busca/escanea producto → 3. Sistema valida stock y lo agrega al carrito → 4. (Si es dispositivo) muestra accesorios compatibles → 5. Aplica descuentos → 6. Asocia cliente (o consumidor final) → 7. Selecciona medios de pago → 8. Confirma → 9. Descuenta stock + kardex → 10. Genera CUFE y envía a DIAN → 11. Entrega/envía factura.

**Flujo de reposición asistida por IA**
1. IA detecta stock bajo + proyecta demanda → 2. Genera alerta y sugerencia de compra → 3. Compras revisa y ajusta → 4. Emite orden al proveedor → 5. Bodega recibe → 6. Stock y costo se actualizan.

**Flujo de devolución**
1. Buscar venta → 2. Seleccionar ítem (serie) → 3. Validar garantía → 4. Elegir destino (reingreso / dañado) → 5. Emitir nota crédito DIAN → 6. Registrar reembolso.

**Flujo de alta de empresa (onboarding SaaS)**
1. Registro y elección de plan → 2. Datos de empresa (NIT, régimen) → 3. Crear primera sede → 4. Cargar resolución DIAN → 5. Invitar usuarios y asignar roles → 6. Importar catálogo (Excel/IA visual) → 7. Listo para vender.

---

## 5. Matriz de roles y permisos

Acciones: **V** ver · **C** crear · **E** editar · **X** eliminar/anular · **—** sin acceso.

| Módulo | Administrador | Gerente | Compras | Ventas | Bodega | Auditor |
|---|---|---|---|---|---|---|
| Dashboard | V | V | V | V (su sede) | V (su sede) | V |
| Inventario | VCEX | VCE | V | V | VCE | V |
| Compras / Órdenes | VCEX | VCE | VCE | — | V | V |
| Entradas mercancía | VCEX | VCE | VC | — | VCE | V |
| Salidas / Traslados | VCEX | VCE | — | V | VCE | V |
| POS / Ventas | VCEX | VCE | — | VC | — | V |
| Devoluciones | VCEX | VCE | — | VC | — | V |
| Finanzas / Caja | VCEX | VCE | V (CxP) | V (su caja) | — | V |
| CRM | VCEX | VCE | — | VCE | — | V |
| Reportes | V | V | V (compras) | V (ventas) | V (inventario) | V |
| Usuarios y roles | VCEX | V | — | — | — | V |
| Configuración / DIAN | VCEX | V | — | — | — | V |
| Auditoría | V | V | — | — | — | V |

> Los permisos se asignan **por sede**: un usuario puede ser Gerente en una sede y solo Ventas en otra. Las reglas se aplican en el backend con *guards* y se refuerzan con Row-Level Security.

---

## 6. Qué sigue

**Fase 4 — UX/UI:** sistema de diseño, inventario de pantallas, wireframes y el prototipo navegable (entregado en HTML).
